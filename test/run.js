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

// The handler below is the EveJS 0.12.8 shape: the seam line (4-space indent,
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

function createFixtureTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-jump-zero-"));
  const targetDir = path.join(root, "server", "src", "services", "ship");
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, "beyonceService.js"), VANILLA_FIXTURE, "utf8");
  return {
    root,
    target: path.join(targetDir, "beyonceService.js"),
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
  const config = configModule.load(modDir, {});
  assert.strictEqual(config.enabled, true);
  assert.strictEqual(config.warpInDistanceMeters, 0);
  assert.strictEqual(config.verbose, false);
  assert.deepStrictEqual([...config.problems], []);
});

test("config reads environment overrides", () => {
  const config = configModule.load(modDir, {
    EVEJS_AUTOPILOT_JUMP_ZERO_WARP_IN_METERS: "15000",
    EVEJS_AUTOPILOT_JUMP_ZERO_VERBOSE: "1",
  });
  assert.strictEqual(config.warpInDistanceMeters, 15000);
  assert.strictEqual(config.verbose, true);
  assert.deepStrictEqual([...config.problems], []);
});

test("config rejects a non-numeric or out-of-range distance", () => {
  for (const value of ["abc", "-1", "1000001", ""]) {
    const config = configModule.load(modDir, {
      EVEJS_AUTOPILOT_JUMP_ZERO_WARP_IN_METERS: value,
    });
    if (value === "") {
      assert.strictEqual(config.warpInDistanceMeters, 0);
      assert.deepStrictEqual([...config.problems], []);
      continue;
    }
    assert.strictEqual(config.warpInDistanceMeters, 0, `value ${value}`);
    assert.strictEqual(config.problems.length, 1, `expected one problem for ${value}`);
  }
});

test("config can be disabled", () => {
  const config = configModule.load(modDir, { EVEJS_AUTOPILOT_JUMP_ZERO: "0" });
  assert.strictEqual(config.enabled, false);
});

test(".env.example only lists known keys", () => {
  const examplePath = path.join(modDir, ".env.example");
  if (!fs.existsSync(examplePath)) {
    console.log("     SKIP .env.example is not present in this tree");
    return;
  }
  const values = configModule.readEnvFile(examplePath);
  const known = new Set(Object.values(configModule.KEYS));
  const unknown = Object.keys(values).filter((key) => !known.has(key));
  assert.deepStrictEqual(unknown, []);
  assert.deepStrictEqual(
    Object.values(configModule.KEYS).filter((key) => !(key in values)),
    [],
  );
});

test("launcher manifest matches the loader version", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(modDir, "evejs-launcher.mod.json"), "utf8"),
  );
  assert.strictEqual(manifest.version, loaderModule.MOD_VERSION);
  assert.strictEqual(manifest.kind, "loader");
  assert.ok(manifest.compatibility.evejsVersions.includes("0.12.8"));
});

test("transform rewrites the vanilla seam in place", () => {
  const result = transforms.transformSource(targetRelative, VANILLA_FIXTURE);
  assert.strictEqual(result.ok, true, result.reason);
  assert.strictEqual(result.state, "vanilla");
  assert.strictEqual(result.alreadyInstalled, false);
  assert.ok(result.source.includes(transforms.MARKERS.beyonceService));
  assert.ok(
    result.source.includes(
      'globalThis[Symbol.for("evejs.autopilotJumpZero")]?.warpInDistanceMeters ?? 0',
    ),
  );
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

for (const range of [0, 15000]) {
  test(`the installed hook drives the handler at ${range} m`, () => {
    const fixture = createFixtureTree();
    try {
      const code = [
        "const path = require('node:path');",
        `const loader = require(${JSON.stringify(loaderPath)});`,
        "const root = process.argv[1];",
        "const api = loader.createApi({ warpInDistanceMeters: Number(process.env.TEST_RANGE) });",
        "globalThis[Symbol.for(loader.API_SYMBOL)] = api;",
        "const hook = loader._testing.installModuleHook(api, root, false);",
        `const { BeyonceService } = require(path.join(root, ${JSON.stringify(targetRelative)}));`,
        "const result = new BeyonceService().Handle_CmdWarpToStuffAutopilot([50006582], { characterID: 140000005 });",
        "console.log('RESULT:' + JSON.stringify({ minimumRange: result.minimumRange, targetID: result.targetID, transformed: hook.transformed.size }));",
      ].join("");
      const child = runNode(["-e", code, fixture.root], {
        env: {
          ...process.env,
          EVEJS_AUTOPILOT_JUMP_ZERO: "0",
          TEST_RANGE: String(range),
        },
      });
      assert.strictEqual(child.status, 0, child.stderr || child.stdout);
      assert.deepStrictEqual(parseChildResult(child.stdout), {
        minimumRange: range,
        targetID: 50006582,
        transformed: 1,
      });
    } finally {
      fixture.cleanup();
    }
  });
}

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