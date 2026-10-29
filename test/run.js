"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const modDir = path.resolve(__dirname, "..");
const runtimeRoot = path.resolve(modDir, "../..");
const loaderPath = path.join(modDir, "loader.js");
const targetRelative = "server/src/services/ship/beyonceService.js";
const warpTargetsRelative = "server/src/space/destiny/simulation/warpTargets.js";
const results = [];
let failed = 0;

function test(name, operation) {
  try {
    operation();
    results.push(name);
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}`);
    console.error(`     ${(error && error.message) || error}`);
  }
}

function runNode(args, options = {}) {
  return spawnSync(process.execPath, args, { encoding: "utf8", timeout: 30000, ...options });
}

function parseChildResult(stdout) {
  const line = String(stdout || "").split(/\r?\n/u).find((entry) => entry.startsWith("RESULT:"));
  assert.ok(line, `missing child result in output: ${stdout}`);
  return JSON.parse(line.slice("RESULT:".length));
}

// The handler below is the EveJS 261018.1 shape: the seam line (4-space indent,
// inside a 2-space member) must stay byte-identical to the real file.
const VANILLA_FIXTURE = `"use strict";

const spaceRuntime = {
  warpToEntity(session, targetID, options) {
    return { success: true, targetID, minimumRange: options.minimumRange };
  },
};

function normalizeNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

class BeyonceService {
  Handle_CmdWarpToStuffAutopilot(args, session) {
    const targetID = normalizeNumber(args && args[0], 0);
    const result = spaceRuntime.warpToEntity(session, targetID, { minimumRange: 10000 });
    return result;
  }

  Handle_CmdDock(args, session) {
    return null;
  }
}

module.exports = { BeyonceService };
`;

// The stargate envelope, in the shape EveJS 261018.1 ships: the exit point is the
// gate radius plus the requested surface range and nothing else. The seam line
// and the two function names must stay byte-identical to the real file.
const ENVELOPE_FIXTURE = `"use strict";

function createDestinyWarpTargetPlanner(deps = {}) {
  const addVectors = (left, right) => ({
    x: left.x + right.x,
    y: left.y + right.y,
    z: left.z + right.z,
  });
  const cloneVector = (source = null) => ({
    x: Number(source && source.x) || 0,
    y: Number(source && source.y) || 0,
    z: Number(source && source.z) || 0,
  });
  const normalizeVector = (source) => cloneVector(source);
  const scaleVector = (source, scale) => ({
    x: cloneVector(source).x * scale,
    y: cloneVector(source).y * scale,
    z: cloneVector(source).z * scale,
  });

  function getStargateWarpExitEnvelopePoint(
    entity,
    stargate,
    minimumRange = 0,
  ) {
    const gateRadius = 15000;
    const requestedRange = Math.max(0, Number(minimumRange) || 0);
    const explicitSurfaceRange =
      requestedRange > 2500
        ? requestedRange
        : 0;
    const gatePosition = cloneVector(stargate && stargate.position);
    const fallbackDirection = normalizeVector(
      entity && entity.direction ? entity.direction : { x: 1, y: 0, z: 0 },
    );
    const fromGateToShip = normalizeVector(
      entity && entity.position ? entity.position : fallbackDirection,
    );

    return addVectors(
      gatePosition,
      scaleVector(fromGateToShip, gateRadius + explicitSurfaceRange),
    );
  }

  function resolveStargateWarpTarget(entity, stargate, minimumRange = 0) {
    return {
      rawDestination: getStargateWarpExitEnvelopePoint(entity, stargate, minimumRange),
      stopDistance: 0,
    };
  }

  return {
    getStargateWarpExitEnvelopePoint,
    resolveStargateWarpTarget,
  };
}

module.exports = { createDestinyWarpTargetPlanner };
`;

function createFixtureTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-jump-zero-"));
  const targetDir = path.join(root, "server", "src", "services", "ship");
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, "beyonceService.js"), VANILLA_FIXTURE, "utf8");
  const envelopeDir = path.join(root, "server", "src", "space", "destiny", "simulation");
  fs.mkdirSync(envelopeDir, { recursive: true });
  fs.writeFileSync(path.join(envelopeDir, "warpTargets.js"), ENVELOPE_FIXTURE, "utf8");
  return {
    root,
    target: path.join(targetDir, "beyonceService.js"),
    envelope: path.join(envelopeDir, "warpTargets.js"),
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function findLiveTree() {
  const candidates = [
    process.env.EVEJS_AUTOPILOT_JUMP_ZERO_TREE,
    runtimeRoot,
    path.join(runtimeRoot, "EveJS"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const target = path.join(candidate, ...targetRelative.split("/"));
    if (fs.existsSync(target)) return { root: candidate, target };
  }
  return null;
}

const configModule = require(path.join(modDir, "config"));
const transforms = require(path.join(modDir, "lib/sourceTransforms"));
const viability = require(path.join(modDir, "lib/viability"));

// Keep the preload inert while the suite drives the exports directly.
const previousEnabledValue = process.env.EVEJS_AUTOPILOT_JUMP_ZERO;
process.env.EVEJS_AUTOPILOT_JUMP_ZERO = "0";
const loaderModule = require(loaderPath);
if (previousEnabledValue === undefined) {
  delete process.env.EVEJS_AUTOPILOT_JUMP_ZERO;
} else {
  process.env.EVEJS_AUTOPILOT_JUMP_ZERO = previousEnabledValue;
}

test("config defaults keep the mod active with jump-zero", () => {
  const config = configModule.load({});
  assert.strictEqual(config.enabled, true);
  assert.strictEqual(config.surfaceClearanceMeters, 500);
  assert.strictEqual(config.verbose, false);
  assert.deepStrictEqual([...config.problems], []);
});

test("config reads environment overrides", () => {
  const config = configModule.load({
    EVEJS_AUTOPILOT_JUMP_ZERO_SURFACE_CLEARANCE_METERS: "750",
    EVEJS_AUTOPILOT_JUMP_ZERO_VERBOSE: "1",
  });
  assert.strictEqual(config.surfaceClearanceMeters, 750);
  assert.strictEqual(config.verbose, true);
  assert.deepStrictEqual([...config.problems], []);
});

test("config rejects a non-numeric or out-of-range clearance", () => {
  for (const value of ["abc", "-1", "2001"]) {
    const config = configModule.load({
      EVEJS_AUTOPILOT_JUMP_ZERO_SURFACE_CLEARANCE_METERS: value,
    });
    assert.strictEqual(config.surfaceClearanceMeters, 500, `value ${value}`);
    assert.strictEqual(config.problems.length, 1, `expected one problem for ${value}`);
  }
});

test("the stargate offset is the hull radius plus a capped clearance", () => {
  const api = loaderModule.createApi({ surfaceClearanceMeters: 500 });
  assert.strictEqual(api.stargateSurfaceOffset({ radius: 7500 }), 8000);
  assert.strictEqual(api.stargateSurfaceOffset({ radius: 31 }), 62);
  assert.strictEqual(api.stargateSurfaceOffset({ radius: 0 }), 0);
  assert.strictEqual(api.stargateSurfaceOffset(null), 0);
  const noClearance = loaderModule.createApi({ surfaceClearanceMeters: 0 });
  assert.strictEqual(noClearance.stargateSurfaceOffset({ radius: 7500 }), 7500);
});

test("config can be disabled", () => {
  const config = configModule.load({ EVEJS_AUTOPILOT_JUMP_ZERO: "0" });
  assert.strictEqual(config.enabled, false);
});

test("the mod ships no configuration file and reads none", () => {
  assert.strictEqual(fs.existsSync(path.join(modDir, ".env")), false);
  assert.strictEqual(fs.existsSync(path.join(modDir, ".env.example")), false);
  assert.strictEqual(typeof configModule.readEnvFile, "undefined");
});

test("launcher manifest matches the loader version", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(modDir, "evejs-launcher.mod.json"), "utf8"),
  );
  assert.strictEqual(manifest.version, loaderModule.MOD_VERSION);
  assert.strictEqual(manifest.kind, "loader");
  assert.deepStrictEqual([...manifest.compatibility.evejsVersions], ["261018.1", "261028.1"]);
});

test("transform rewrites the vanilla seam in place", () => {
  const result = transforms.transformSource(targetRelative, VANILLA_FIXTURE);
  assert.strictEqual(result.ok, true, result.reason);
  assert.strictEqual(result.state, "vanilla");
  assert.strictEqual(result.alreadyInstalled, false);
  assert.ok(result.source.includes(transforms.MARKERS.beyonceService));
  assert.ok(result.source.includes("{ minimumRange: 0 }"));
  assert.ok(!result.source.includes("minimumRange: 10000"));
  assert.strictEqual(
    result.source.split("\n").length,
    VANILLA_FIXTURE.split("\n").length,
    "line count must be preserved",
  );
  const compiled = new Module(path.join(os.tmpdir(), "autopilot-jump-zero-compiled.js"), null);
  compiled.filename = path.join(os.tmpdir(), "autopilot-jump-zero-compiled.js");
  compiled.paths = Module._nodeModulePaths(os.tmpdir());
  compiled._compile(result.source, compiled.filename);
});

test("transform is idempotent", () => {
  const first = transforms.transformBeyonceService(VANILLA_FIXTURE);
  const second = transforms.transformSource(targetRelative, first);
  assert.strictEqual(second.ok, true, second.reason);
  assert.strictEqual(second.state, "installed");
  assert.strictEqual(second.alreadyInstalled, true);
  assert.strictEqual(second.source, first);
});

test("transform fails closed when the handler anchor is gone", () => {
  const renamed = VANILLA_FIXTURE.replace(
    "Handle_CmdWarpToStuffAutopilot(args, session)",
    "Handle_AutoPilotWarp(args, session)",
  );
  const result = transforms.transformSource(targetRelative, renamed);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.state, "missing");
  assert.match(result.reason, /anchor count 0, expected 1/u);
});

test("transform fails closed when the seam is duplicated", () => {
  const duplicated = VANILLA_FIXTURE.replace(
    "    const result = spaceRuntime.warpToEntity(session, targetID, { minimumRange: 10000 });",
    "    const result = spaceRuntime.warpToEntity(session, targetID, { minimumRange: 10000 });\n" +
      "    const shadow = spaceRuntime.warpToEntity(session, targetID, { minimumRange: 10000 });",
  );
  const result = transforms.transformSource(targetRelative, duplicated);
  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /ambiguous autopilot seam/u);
});

test("transform refuses a seam another server-side patch owns", () => {
  const foreign = VANILLA_FIXTURE.replace(
    "{ minimumRange: 10000 }",
    "{ minimumRange: warpInDistanceMeters }",
  );
  const result = transforms.transformSource(targetRelative, foreign);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.state, "foreign");
  assert.match(result.reason, /already owned by a server-side patch/u);
});

test("transform leaves files it does not own alone", () => {
  const result = transforms.transformSource("server/src/space/runtime.js", VANILLA_FIXTURE);
  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /not a transform target/u);
});

test("warpTargets transform adds the hull offset to the stargate envelope", () => {
  const result = transforms.transformSource(warpTargetsRelative, ENVELOPE_FIXTURE);
  assert.strictEqual(result.ok, true, result.reason);
  assert.strictEqual(result.state, "vanilla");
  assert.strictEqual(result.alreadyInstalled, false);
  assert.ok(result.source.includes(transforms.MARKERS.warpTargets));
  assert.ok(result.source.includes("?.stargateSurfaceOffset?.(entity) ?? 0"));
  assert.strictEqual(
    result.source.split("\n").length,
    ENVELOPE_FIXTURE.split("\n").length,
    "line count must be preserved",
  );
  const compiledPath = path.join(os.tmpdir(), "autopilot-jump-zero-envelope.js");
  const compiled = new Module(compiledPath, null);
  compiled.filename = compiledPath;
  compiled.paths = Module._nodeModulePaths(os.tmpdir());
  compiled._compile(result.source, compiledPath);

  const marker = Symbol.for(transforms.API_SYMBOL);
  const previous = globalThis[marker];
  globalThis[marker] = loaderModule.createApi({ surfaceClearanceMeters: 500 });
  try {
    const planner = compiled.exports.createDestinyWarpTargetPlanner({});
    const titan = planner.getStargateWarpExitEnvelopePoint({ radius: 7500 }, {}, 0);
    const frigate = planner.getStargateWarpExitEnvelopePoint({ radius: 31 }, {}, 0);
    assert.strictEqual(titan.x, 15000 + 7500 + 500);
    assert.strictEqual(frigate.x, 15000 + 31 + 31);
  } finally {
    if (previous === undefined) delete globalThis[marker];
    else globalThis[marker] = previous;
  }
});

test("warpTargets transform is idempotent", () => {
  const first = transforms.transformWarpTargets(ENVELOPE_FIXTURE);
  const second = transforms.transformSource(warpTargetsRelative, first);
  assert.strictEqual(second.ok, true, second.reason);
  assert.strictEqual(second.state, "installed");
  assert.strictEqual(second.alreadyInstalled, true);
  assert.strictEqual(second.source, first);
});

test("warpTargets transform fails closed when the envelope is gone", () => {
  const renamed = ENVELOPE_FIXTURE.replace(
    "getStargateWarpExitEnvelopePoint(",
    "getStargateWarpExitEnvelope(",
  );
  const result = transforms.transformSource(warpTargetsRelative, renamed);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.state, "missing");
  assert.match(result.reason, /stargate envelope anchor count 0, expected 1/u);
});

test("warpTargets transform reports a vendor that already owns the geometry", () => {
  const foreign = ENVELOPE_FIXTURE
    .replace(
      "    const gateRadius = 15000;",
      "    const gateRadius = 15000;\n    const shipRadius = 0;",
    )
    .replace(
      "      scaleVector(fromGateToShip, gateRadius + explicitSurfaceRange),",
      "      scaleVector(fromGateToShip, gateRadius + explicitSurfaceRange + shipRadius),",
    );
  const result = transforms.transformSource(warpTargetsRelative, foreign);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.state, "foreign");
  assert.match(result.reason, /already accounts for the ship radius/u);
});

test("viability gate rejects a tree without the autopilot handler", () => {
  const fixture = createFixtureTree();
  try {
    fs.writeFileSync(fixture.target, VANILLA_FIXTURE.replace(/Handle_CmdDock\(/gu, "Handle_Later("), "utf8");
    const report = viability.inspect(fixture.root);
    assert.strictEqual(report.ok, false);
    assert.ok(report.reports.some((entry) => entry.key === "beyonceServiceShape" && !entry.ok));
  } finally {
    fixture.cleanup();
  }
});

test("the installed hook transforms the stargate envelope when it is required", () => {
  const fixture = createFixtureTree();
  try {
    const code = [
      "const path = require('node:path');",
      `const loader = require(${JSON.stringify(loaderPath)});`,
      "const root = process.argv[1];",
      "const api = loader.createApi({ surfaceClearanceMeters: 500 });",
      "globalThis[Symbol.for(loader.API_SYMBOL)] = api;",
      "const hook = loader._testing.installModuleHook(api, root, false);",
      `const plan = require(path.join(root, ${JSON.stringify(warpTargetsRelative)}));`,
      "const planner = plan.createDestinyWarpTargetPlanner({});",
      "const point = planner.getStargateWarpExitEnvelopePoint({ radius: 7500 }, {}, 0);",
      "console.log('RESULT:' + JSON.stringify({ x: point.x, transformed: hook.transformed.size }));",
    ].join("");
    const child = runNode(["-e", code, fixture.root], {
      env: { ...process.env, EVEJS_AUTOPILOT_JUMP_ZERO: "0" },
    });
    assert.strictEqual(child.status, 0, child.stderr || child.stdout);
    assert.deepStrictEqual(parseChildResult(child.stdout), {
      x: 15000 + 7500 + 500,
      transformed: 1,
    });
  } finally {
    fixture.cleanup();
  }
});

test("the loader stays inert in worker threads", () => {
  const code =
    "const {Worker}=require('node:worker_threads');" +
    `const w=new Worker("const {parentPort,workerData}=require('node:worker_threads');const l=require(workerData);parentPort.postMessage(l.installResult);",` +
    `{eval:true,workerData:${JSON.stringify(loaderPath)}});` +
    "w.once('message',(value)=>{console.log('RESULT:'+JSON.stringify(value));});w.once('error',(error)=>{throw error});";
  const child = runNode(["-e", code], {
    env: { ...process.env, EVEJS_AUTOPILOT_JUMP_ZERO: "1" },
  });
  assert.strictEqual(child.status, 0, child.stderr || child.stdout);
  assert.deepStrictEqual(parseChildResult(child.stdout), { active: false, reason: "worker-thread" });
});

test("the installed hook drives the handler to zero range", () => {
  const fixture = createFixtureTree();
  try {
    const code = [
      "const path = require('node:path');",
      `const loader = require(${JSON.stringify(loaderPath)});`,
      "const root = process.argv[1];",
      "const api = loader.createApi({ surfaceClearanceMeters: 500 });",
      "globalThis[Symbol.for(loader.API_SYMBOL)] = api;",
      "const hook = loader._testing.installModuleHook(api, root, false);",
      `const { BeyonceService } = require(path.join(root, ${JSON.stringify(targetRelative)}));`,
      "const result = new BeyonceService().Handle_CmdWarpToStuffAutopilot([50006582], { characterID: 140000005 });",
      "console.log('RESULT:' + JSON.stringify({ minimumRange: result.minimumRange, targetID: result.targetID, transformed: hook.transformed.size }));",
    ].join("");
    const child = runNode(["-e", code, fixture.root], {
      env: { ...process.env, EVEJS_AUTOPILOT_JUMP_ZERO: "0" },
    });
    assert.strictEqual(child.status, 0, child.stderr || child.stdout);
    assert.deepStrictEqual(parseChildResult(child.stdout), {
      minimumRange: 0,
      targetID: 50006582,
      transformed: 1,
    });
  } finally {
    fixture.cleanup();
  }
});

test("live tree probe reports a known seam state", () => {
  const live = findLiveTree();
  if (!live) {
    console.log("     SKIP no EveJS tree found next to this mod");
    return;
  }
  const report = transforms.inspect(live.root).reports[0];
  assert.ok(
    ["vanilla", "installed", "foreign", "missing"].includes(report.state),
    `unexpected state ${report.state}`,
  );
  console.log(`     ${live.target} -> ${report.state}${report.reason ? ` (${report.reason})` : ""}`);
  if (report.state === "vanilla") {
    // A pristine tree must also clear the viability gate, otherwise the loader
    // would refuse to install even though the seam itself looks patchable.
    const gate = viability.inspect(live.root);
    const failures = gate.reports.filter((entry) => !entry.ok);
    assert.deepStrictEqual(
      failures.map((entry) => `${entry.key}: ${entry.reason}`),
      [],
      "viability gate must accept the pristine tree",
    );
    console.log(`     viability gate: ok (${gate.reports.length} checks)`);
  }
});

require("./installer")({ test, modDir });

console.log(`\n${results.length}/${results.length + failed} PASS`);
if (failed > 0) process.exitCode = 1;