"use strict";

const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");

const API_SYMBOL = "evejs.autopilotJumpZero";
const TARGETS = Object.freeze({
  beyonceService: "server/src/services/ship/beyonceService.js",
});
const MARKERS = Object.freeze({
  beyonceService: "autopilotJumpZero: autopilot warp-in distance",
});

// EveJS 0.12.9 decides where an autopilot warp ends in exactly one place.
// The retail client autopilot calls beyonce.CmdWarpToStuffAutopilot(targetID)
// with no range at all and then jumps on its own once the surface distance to
// the gate drops under 2500 m, so this hardcoded 10000 m (which lands the ship
// outside the jump bubble, forcing an approach leg) is the entire server-side
// lever over autopilot travel time.
const HANDLER_ANCHOR = "  Handle_CmdWarpToStuffAutopilot(args, session) {";
const HANDLER_SEAM_VANILLA =
  "spaceRuntime.warpToEntity(session, targetID, { minimumRange: 10000 })";
const HANDLER_SEAM_INSTALLED =
  "spaceRuntime.warpToEntity(session, targetID, { minimumRange: " +
  `globalThis[Symbol.for("${API_SYMBOL}")]?.warpInDistanceMeters ?? 0 }); ` +
  `/* ${MARKERS.beyonceService} */`;
// A server whose own source already carries a config-driven warp-in distance
// owns this seam. The mod must report that instead of fighting another patch.
const HANDLER_SEAM_FOREIGN = "minimumRange: warpInDistanceMeters";

function normalizePath(value) {
  return String(value || "").split(path.sep).join("/");
}

function countText(source, token) {
  return String(source).split(token).length - 1;
}

function seamError(state, message) {
  const error = new Error(message);
  error.seamState = state;
  return error;
}

function locateHandlerScope(source) {
  const text = String(source);
  const anchorCount = countText(text, HANDLER_ANCHOR);
  if (anchorCount !== 1) {
    throw seamError(
      "missing",
      `autopilot handler anchor count ${anchorCount}, expected 1`,
    );
  }
  const start = text.indexOf(HANDLER_ANCHOR);
  // Members of the service object are indented by two spaces, so the first
  // "\n  }" after the anchor is the closing brace of this handler.
  const closeIndex = text.indexOf("\n  }", start + HANDLER_ANCHOR.length);
  if (closeIndex < 0) {
    throw seamError("missing", "autopilot handler closing brace not found");
  }
  return {
    start,
    end: closeIndex + 1,
    scoped: text.slice(start, closeIndex + 1),
  };
}

function analyzeSeam(source) {
  const text = String(source);
  const scope = locateHandlerScope(text);
  const vanillaCount = countText(scope.scoped, HANDLER_SEAM_VANILLA);
  const installedCount = countText(scope.scoped, HANDLER_SEAM_INSTALLED);
  const markerCount = countText(scope.scoped, MARKERS.beyonceService);
  const markerOutsideScope =
    countText(text, MARKERS.beyonceService) - markerCount;
  if (markerOutsideScope !== 0) {
    throw seamError(
      "missing",
      "autopilotJumpZero marker found outside the owned autopilot handler",
    );
  }
  if (vanillaCount === 1 && installedCount === 0 && markerCount === 0) {
    return { ...scope, status: "vanilla" };
  }
  if (vanillaCount === 0 && installedCount === 1 && markerCount === 1) {
    return { ...scope, status: "installed" };
  }
  if (vanillaCount > 1 || installedCount > 1 || markerCount > 1) {
    throw seamError(
      "missing",
      "ambiguous autopilot seam " +
        `(vanilla=${vanillaCount}, installed=${installedCount}, marker=${markerCount})`,
    );
  }
  if (countText(scope.scoped, HANDLER_SEAM_FOREIGN) === 1) {
    throw seamError(
      "foreign",
      "the autopilot warp-in distance is already owned by a server-side patch",
    );
  }
  throw seamError("missing", "required autopilot seam missing or changed");
}

function applySeam(source) {
  const text = String(source);
  const analysis = analyzeSeam(text);
  if (analysis.status === "installed") {
    return { source: text, alreadyInstalled: true, status: analysis.status };
  }
  const transformedScope = analysis.scoped.replace(
    HANDLER_SEAM_VANILLA,
    HANDLER_SEAM_INSTALLED,
  );
  return {
    source: text.slice(0, analysis.start) + transformedScope + text.slice(analysis.end),
    alreadyInstalled: false,
    status: analysis.status,
  };
}

function transformBeyonceServiceDetailed(source) {
  return applySeam(String(source));
}

function transformBeyonceService(source) {
  return transformBeyonceServiceDetailed(source).source;
}

function targetKeyForFile(filename) {
  const normalized = normalizePath(filename);
  return (
    Object.entries(TARGETS).find(([, suffix]) => normalized.endsWith(suffix))?.[0] ||
    null
  );
}

function transformSource(filename, source) {
  const key = targetKeyForFile(filename);
  if (!key) {
    return { ok: false, source, reason: `not a transform target: ${filename}` };
  }
  try {
    const before = String(source);
    const result = transformBeyonceServiceDetailed(before);
    const linesBefore = before.split("\n").length;
    const linesAfter = result.source.split("\n").length;
    if (linesBefore !== linesAfter) {
      return {
        ok: false,
        state: "missing",
        source: before,
        reason: `${key} line count changed ${linesBefore} -> ${linesAfter}`,
      };
    }
    return {
      ok: true,
      state: result.status,
      source: result.source,
      reason: null,
      key,
      alreadyInstalled: result.alreadyInstalled === true,
    };
  } catch (error) {
    return {
      ok: false,
      state: error.seamState || "missing",
      source: String(source),
      reason: error.message,
      key,
    };
  }
}

function inspect(runtimeRoot) {
  const reports = [];
  for (const [key, suffix] of Object.entries(TARGETS)) {
    const filename = path.join(runtimeRoot, ...suffix.split("/"));
    let source = "";
    try {
      source = fs.readFileSync(filename, "utf8");
    } catch (error) {
      reports.push({ key, filename, ok: false, state: "missing", reason: error.message });
      continue;
    }
    const result = transformSource(filename, source);
    reports.push({
      key,
      filename,
      ok: result.ok,
      state: result.state,
      reason: result.reason,
      alreadyInstalled: result.alreadyInstalled === true,
    });
  }
  return { ok: reports.every((report) => report.ok), reports };
}

function isTargetFile(filename) {
  return targetKeyForFile(filename) !== null;
}

function loadTransformed(filename, parent) {
  const source = fs.readFileSync(filename, "utf8");
  const result = transformSource(filename, source);
  if (!result.ok) {
    return { ok: false, exports: null, reason: result.reason, state: result.state };
  }
  const compiled = new Module(filename, parent || null);
  compiled.filename = filename;
  compiled.paths = Module._nodeModulePaths(path.dirname(filename));
  Module._cache[filename] = compiled;
  try {
    compiled._compile(result.source, filename);
    compiled.loaded = true;
  } catch (error) {
    delete Module._cache[filename];
    return {
      ok: false,
      exports: null,
      reason: `compile failed: ${error.message}`,
      state: result.state,
    };
  }
  return {
    ok: true,
    exports: compiled.exports,
    reason: null,
    key: result.key,
    state: result.state,
    alreadyInstalled: result.alreadyInstalled === true,
  };
}

module.exports = {
  API_SYMBOL,
  MARKERS,
  TARGETS,
  applySeam,
  inspect,
  isTargetFile,
  loadTransformed,
  targetKeyForFile,
  transformBeyonceService,
  transformSource,
};