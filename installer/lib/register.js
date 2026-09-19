"use strict";

// Pure text transforms that wire this mod into both supported EveJS
// deployments: the Docker entrypoint preload list and the Windows native
// launcher (StartServer.bat). Nothing here touches the filesystem, so every
// rule can be exercised against fixture text by test/installer.js.

const CONTAINER_MODS_ROOT = "/app/mods";
const NATIVE_MODS_PREFIX = "../mods";

// The native entry point is StartServer.bat rather than the npm start script in
// server/package.json. package.json is an input to the image's dependency layer:
// editing it re-runs `npm ci` on the next image build, and on a network where
// better-sqlite3's prebuild download fails that falls back to a source build
// that aborts on Node 24. StartServer.bat is excluded from the Docker build
// context, so preloading through it cannot disturb an image build.
const START_SERVER_ANCHOR = 'set "EVEJS_PROXY_LOCAL_INTERCEPT=1"';
const START_SERVER_BEGIN = "rem --- autopilotJumpZero: preload the server-side loader ---";
const START_SERVER_END = "rem --- autopilotJumpZero: end autopilotJumpZero preload ---";

// The only `node ... \` invocation in docker/entrypoint.sh whose continuation
// carries this flag is a server launch, and Node applies --require to it no
// matter whether the container was asked for `server` or `all`.
const SERVER_LAUNCH_FLAG = "--report-on-fatalerror";
const NODE_LAUNCH_LINE = /^([ \t]*)(.*\bnode[ \t]+)\\$/u;
const CONTINUES = /[ \t]\\[ \t]*$/u;

function containerRequirePath(modId) {
  return `${CONTAINER_MODS_ROOT}/${modId}/loader.js`;
}

// Expressed through the variable StartServer.bat computes from its own
// location, so the block survives the install being copied or moved.
//
// NODE_OPTIONS is parsed with backslash escapes, so a `--require="C:\path"`
// entry silently collapses into `C:path`. The value Node receives therefore
// uses forward slashes, while the `if exist` test keeps native separators.
function nativeRequirePath(modId) {
  return `%EVEJS_REPO_ROOT:\\=/%/mods/${modId}/loader.js`;
}

function nativeExistPath(modId) {
  return `%EVEJS_REPO_ROOT%\\mods\\${modId}\\loader.js`;
}

function requireFlag(requirePath) {
  return `--require ${requirePath}`;
}

// Splitting on \n keeps a CRLF file byte-identical apart from the edit: the
// carriage return stays at the end of its own line.
function splitLines(text) {
  return String(text).split("\n");
}

function stripCarriageReturn(line) {
  return String(line).replace(/\r$/u, "");
}

function isServerLaunch(body) {
  return body.some((line) => line.includes(SERVER_LAUNCH_FLAG));
}

function applyEntrypointPreload(text, options) {
  const source = String(text);
  const requirePath = options.requirePath;
  const flag = requireFlag(requirePath);
  const indentation = options.indentation || "  ";
  const lines = splitLines(source);
  const output = [];
  let launches = 0;
  let insertions = 0;
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const match = NODE_LAUNCH_LINE.exec(stripCarriageReturn(line));
    if (!match) {
      output.push(line);
      index += 1;
      continue;
    }

    let end = index;
    while (end < lines.length - 1 && CONTINUES.test(stripCarriageReturn(lines[end]))) {
      end += 1;
    }
    const body = lines.slice(index, end + 1);
    output.push(line);
    if (isServerLaunch(body)) {
      launches += 1;
      if (!body.some((entry) => entry.includes(flag))) {
        // The injected entry lands first in the continuation list and keeps the
        // final backslash so the logical invocation stays a single statement.
        output.push(`${match[1]}${indentation}${flag} \\`);
        insertions += 1;
      }
    }
    for (let cursor = index + 1; cursor <= end; cursor += 1) output.push(lines[cursor]);
    index = end + 1;
  }

  if (launches === 0) {
    return {
      ok: false,
      changed: false,
      reason: `no server launch (node with ${SERVER_LAUNCH_FLAG}) found in docker/entrypoint.sh`,
    };
  }
  return { ok: true, changed: insertions > 0, text: output.join("\n"), insertions, launches };
}

function removeEntrypointPreload(text, options) {
  const flag = requireFlag(options.requirePath);
  const kept = [];
  let removals = 0;
  for (const line of splitLines(text)) {
    const bare = stripCarriageReturn(line).trim();
    if (bare === flag || bare === `${flag} \\`) {
      removals += 1;
      continue;
    }
    kept.push(line);
  }
  return { ok: true, changed: removals > 0, text: kept.join("\n"), removals };
}

function hasEntrypointPreload(text, options) {
  const flag = requireFlag(options.requirePath);
  return splitLines(text).some((line) => stripCarriageReturn(line).includes(flag));
}

function describeEntrypointPreloads(text) {
  const found = [];
  for (const line of splitLines(text)) {
    const match = /^[ \t]*--require[ \t]+(\S+)[ \t]*\\?[ \t]*$/u.exec(stripCarriageReturn(line));
    if (match) found.push(match[1]);
  }
  return found;
}

// `NODE_OPTIONS` is a list, and another loader mod may already own it. Two
// simpler policies are both wrong:
//
//   set "NODE_OPTIONS=--require=..."       drops whatever was already there
//   if not defined NODE_OPTIONS set "..."  drops whichever mod registers second
//
// The second one reads like a guard but is not one. Later installs are inserted
// ABOVE earlier ones, so a neighbour that lands ahead of this block claims the
// variable first and this mod is then skipped without a word. This block
// therefore APPENDS, and assigns outright only when nothing has claimed the
// variable yet.
//
// `%NODE_OPTIONS%` is expanded while the parenthesised block is parsed, which
// happens after the earlier blocks have already run, so the append always sees
// the incoming value.
function startServerBlockLines(requirePath, existPath, suffix) {
  return [
    `${START_SERVER_BEGIN}${suffix}`,
    `if exist "${existPath}" (${suffix}`,
    `  if defined NODE_OPTIONS (${suffix}`,
    `    set "NODE_OPTIONS=%NODE_OPTIONS% --require="${requirePath}""${suffix}`,
    `  ) else (${suffix}`,
    `    set "NODE_OPTIONS=--require="${requirePath}""${suffix}`,
    `  )${suffix}`,
    `)${suffix}`,
    `${START_SERVER_END}${suffix}`,
  ];
}

// Returns the line range of an already-registered block, or null when there is
// none. A begin marker without an end marker is reported separately: it is a
// damaged registration, not an absent one.
function blockMatches(lines, range, block) {
  const current = lines.slice(range.begin, range.end + 1);
  return current.length === block.length && current.every((line, offset) => line === block[offset]);
}

function findStartServerBlock(lines) {
  const begin = lines.findIndex((line) => stripCarriageReturn(line).trim() === START_SERVER_BEGIN);
  if (begin < 0) return null;
  for (let index = begin + 1; index < lines.length; index += 1) {
    if (stripCarriageReturn(lines[index]).trim() === START_SERVER_END) {
      return { begin, end: index };
    }
  }
  return null;
}

// The block is inserted directly after the launcher's own environment setup, so
// both branches that reach `npm start` (server only, and server + play) inherit
// NODE_OPTIONS and the loader is in place before any server module loads.
//
// It stays at the head of the preload group on purpose. `--require` order is
// hook order, and this loader replaces its target module instead of wrapping
// it, so it has to end up innermost: a wrapping mod installed after it still
// sees the exports this transform produced, while a wrapper this mod skipped
// past would be erased. Appending the value is what makes the position safe -
// once the value is appended to rather than claimed, a neighbour that jumps
// ahead of this block can no longer silence it.
//
// A block left by an older release carries the first-writer-wins form. It is
// rewritten in place, so upgrading repairs the registration that is already
// there instead of leaving a fragile one behind.
function applyStartServerPreload(text, options) {
  const source = String(text);
  const requirePath = options.requirePath;
  const suffix = source.includes("\r\n") ? "\r" : "";
  const lines = splitLines(source);
  const block = startServerBlockLines(requirePath, options.existPath || requirePath, suffix);
  const existing = findStartServerBlock(lines);
  if (existing) {
    if (blockMatches(lines, existing, block)) {
      return { ok: true, changed: false, upgraded: false, text: source };
    }
    const output = [...lines.slice(0, existing.begin), ...block, ...lines.slice(existing.end + 1)];
    return {
      ok: true,
      changed: true,
      upgraded: true,
      text: output.join("\n"),
      insertions: block.length,
    };
  }
  if (hasStartServerPreload(source)) {
    return {
      ok: false,
      changed: false,
      reason: "the existing autopilotJumpZero preload block has no end marker",
    };
  }
  const anchor = lines.findIndex((line) => stripCarriageReturn(line).trim() === START_SERVER_ANCHOR);
  if (anchor < 0) {
    return {
      ok: false,
      changed: false,
      reason: `no ${START_SERVER_ANCHOR} line found in StartServer.bat`,
    };
  }
  const output = [...lines.slice(0, anchor + 1), ...block, ...lines.slice(anchor + 1)];
  return {
    ok: true,
    changed: true,
    upgraded: false,
    text: output.join("\n"),
    insertions: block.length,
  };
}

function removeStartServerPreload(text) {
  const lines = splitLines(text);
  const kept = [];
  let inside = false;
  let removals = 0;
  for (const line of lines) {
    const bare = stripCarriageReturn(line).trim();
    if (bare === START_SERVER_BEGIN) {
      inside = true;
      removals += 1;
      continue;
    }
    if (inside) {
      removals += 1;
      if (bare === START_SERVER_END) inside = false;
      continue;
    }
    kept.push(line);
  }
  return { ok: true, changed: removals > 0, text: kept.join("\n"), removals };
}

function hasStartServerPreload(text) {
  return stripCarriageReturn(String(text)).includes(START_SERVER_BEGIN);
}

// True when the registered block already matches the current append-only form.
// A block that is present but not current was written by an older release and
// still carries the first-writer-wins policy, which a reinstall repairs.
function startServerPreloadIsCurrent(text, options) {
  const source = String(text);
  const lines = splitLines(source);
  const existing = findStartServerBlock(lines);
  if (!existing) return false;
  const suffix = source.includes("\r\n") ? "\r" : "";
  const block = startServerBlockLines(options.requirePath, options.existPath || options.requirePath, suffix);
  return blockMatches(lines, existing, block);
}

module.exports = {
  CONTAINER_MODS_ROOT,
  NATIVE_MODS_PREFIX,
  SERVER_LAUNCH_FLAG,
  START_SERVER_ANCHOR,
  START_SERVER_BEGIN,
  START_SERVER_END,
  applyEntrypointPreload,
  applyStartServerPreload,
  containerRequirePath,
  describeEntrypointPreloads,
  hasEntrypointPreload,
  hasStartServerPreload,
  nativeExistPath,
  nativeRequirePath,
  removeEntrypointPreload,
  removeStartServerPreload,
  requireFlag,
  startServerPreloadIsCurrent,
};