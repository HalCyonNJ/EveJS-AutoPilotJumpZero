"use strict";

const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const { isMainThread } = require("node:worker_threads");

const MOD_VERSION = "1.1.2";
const MOD_DIR = __dirname;
const RUNTIME_ROOT = path.resolve(MOD_DIR, "../..");
const LOG_PREFIX = "[autopilotJumpZero]";
const INSTALL_FLAG = "__autopilotJumpZeroLoaderInstalled";
const API_SYMBOL = "evejs.autopilotJumpZero";

function log(message) {
  console.log(`${LOG_PREFIX} ${message}`);
}

function logError(message, error = null) {
  console.error(`${LOG_PREFIX} ${message}`);
  if (error && error.stack) console.error(error.stack);
}

function canonicalize(filename, options = {}) {
  const platform = options.platform || process.platform;
  const resolved = path.resolve(String(filename || ""));
  const realpath = options.realpath || (fs.realpathSync.native || fs.realpathSync);
  let canonical;
  try {
    canonical = realpath(resolved);
  } catch (_error) {
    canonical = resolved;
  }
  if (platform === "win32") {
    return path.win32.normalize(canonical.replace(/\//gu, "\\")).toLowerCase();
  }
  return path.posix.normalize(canonical.replace(/\\/gu, "/"));
}

function resolveFilename(request, parent, isMain) {
  try {
    return Module._resolveFilename(request, parent, isMain);
  } catch (_error) {
    return null;
  }
}

function buildCanonicalTargetMap(runtimeRoot, transforms, options = {}) {
  const targetMap = new Map();
  for (const [key, relative] of Object.entries(transforms.TARGETS)) {
    const filename = path.resolve(runtimeRoot, ...relative.split("/"));
    const canonical = canonicalize(filename, options);
    if (targetMap.has(canonical)) {
      throw new Error(`duplicate canonical target: ${filename}`);
    }
    targetMap.set(canonical, Object.freeze({ kind: "transform", key, relative, filename, canonical }));
  }
  return targetMap;
}

function findPrecachedTargets(targetMap, options = {}) {
  const cachedByCanonical = new Map();
  for (const filename of Object.keys(Module._cache)) {
    cachedByCanonical.set(canonicalize(filename, options), filename);
  }
  return [...targetMap.values()]
    .filter((target) => cachedByCanonical.has(target.canonical))
    .map((target) => cachedByCanonical.get(target.canonical));
}

// Resolution still uses Node's parent-aware resolver on every call. Only
// successful filesystem identities are memoized; failed probes remain retryable.
// Do not reject by basename: symlinks/packages can alias an exact owned target.
function createCanonicalCache(canonicalizeFn, options = {}) {
  const identities = new Map();
  return function canonicalizeResolved(filename) {
    if (identities.has(filename)) return identities.get(filename);
    let succeeded = false;
    const canonical = canonicalizeFn(filename, {
      ...options,
      realpath(value) {
        const result = (options.realpath || fs.realpathSync.native || fs.realpathSync)(value);
        succeeded = true;
        return result;
      },
    });
    // canonicalize preserves its existing lexical fallback on realpath failure,
    // but that fallback must not prevent a later successful canonicalization.
    if (succeeded) identities.set(filename, canonical);
    return canonical;
  };
}

function createApi(config) {
  return Object.freeze({
    version: MOD_VERSION,
    warpInDistanceMeters: config.warpInDistanceMeters,
    config,
  });
}

function installModuleHook(api, runtimeRoot, verbose, options = {}) {
  const transforms = require("./lib/sourceTransforms");
  const canonicalTargets = buildCanonicalTargetMap(runtimeRoot, transforms, options);
  const cachedBeforeInstall = findPrecachedTargets(canonicalTargets, options);
  if (cachedBeforeInstall.length > 0) {
    throw new Error(
      `required target already cached before hook installation: ${cachedBeforeInstall.join(", ")}`,
    );
  }

  const canonicalizeResolved = createCanonicalCache(canonicalize, options);
  const previousLoad = Module._load;
  const transformed = new Set();
  const transforming = new Set();
  const loadedTargets = new Map();

  function hookedLoad(request, parent, isMain) {
    if (Module.isBuiltin(request)) return previousLoad.apply(this, arguments);
    const filename = resolveFilename(request, parent, isMain);
    if (!filename) return previousLoad.apply(this, arguments);
    const canonical = canonicalizeResolved(filename);
    const target = canonicalTargets.get(canonical);
    if (!target) return previousLoad.apply(this, arguments);

    if (loadedTargets.has(canonical)) return loadedTargets.get(canonical);
    if (transforming.has(canonical)) {
      const cached = Module._cache[target.filename];
      if (!cached) throw new Error(`transform recursion cache missing: ${target.filename}`);
      return cached.exports;
    }
    if (Module._cache[target.filename] || transformed.has(canonical)) {
      throw new Error(`transform target cached before application: ${target.filename}`);
    }

    transforming.add(canonical);
    try {
      const loaded = transforms.loadTransformed(target.filename, parent);
      if (!loaded.ok) {
        throw new Error(`source transform failed for ${target.filename}: ${loaded.reason}`);
      }
      transformed.add(canonical);
      loadedTargets.set(canonical, loaded.exports);
      log(
        `in-memory transform ${loaded.alreadyInstalled ? "already present" : "applied"}: ` +
          `${target.key} autopilot warp-in distance ${api.warpInDistanceMeters} m`,
      );
      if (verbose) log(`owned target resolved: ${target.filename}`);
      return loaded.exports;
    } finally {
      transforming.delete(canonical);
    }
  }

  Module._load = hookedLoad;
  return { canonicalTargets, loadedTargets, previousLoad, transformed, transforming, hookedLoad };
}

function install(options = {}) {
  if (!isMainThread) return { active: false, reason: "worker-thread" };
  if (globalThis[INSTALL_FLAG]) return { active: false, reason: "already-installed" };

  const runtimeRoot = path.resolve(options.runtimeRoot || RUNTIME_ROOT);
  const environment = options.environment || process.env;
  const config = require("./config").load(MOD_DIR, environment);
  if (!config.enabled) {
    log("inert — mod disabled; vanilla EveJS autopilot behaviour retained");
    return { active: false, reason: "disabled", config };
  }
  if (config.problems.length > 0) {
    for (const problem of config.problems) logError(problem);
    logError("invalid mod-owned configuration — no hooks installed");
    return { active: false, reason: "invalid-config", config };
  }

  const viable = require("./lib/viability").inspect(runtimeRoot);
  if (!viable.ok) {
    logError("viability gate failed — no hooks installed");
    for (const report of viable.reports.filter((entry) => !entry.ok)) {
      logError(`${report.key}: ${report.reason}`);
    }
    return { active: false, reason: "not-viable", config, viable };
  }

  const apiMarker = Symbol.for(API_SYMBOL);
  const api = createApi(config);
  let hookState = null;
  try {
    hookState = installModuleHook(api, runtimeRoot, config.verbose, options.canonicalizeOptions);
    globalThis[apiMarker] = api;
    const installState = Object.freeze({ active: true, api, config, viable, runtimeRoot, hookState });
    globalThis[INSTALL_FLAG] = installState;
    log(`v${MOD_VERSION} active — autopilot warp-in distance ${config.warpInDistanceMeters} m`);
    return installState;
  } catch (error) {
    if (hookState && Module._load === hookState.hookedLoad) {
      Module._load = hookState.previousLoad;
    }
    if (globalThis[apiMarker] === api) delete globalThis[apiMarker];
    if (globalThis[INSTALL_FLAG] && globalThis[INSTALL_FLAG].hookState === hookState) {
      delete globalThis[INSTALL_FLAG];
    }
    throw error;
  }
}

let installResult = null;
try {
  installResult = install();
} catch (error) {
  logError("loader failed before activation", error);
  installResult = { active: false, reason: "exception", error };
}

module.exports = {
  API_SYMBOL,
  INSTALL_FLAG,
  MOD_DIR,
  MOD_VERSION,
  RUNTIME_ROOT,
  canonicalize,
  createApi,
  install,
  installResult,
  _testing: Object.freeze({
    buildCanonicalTargetMap,
    findPrecachedTargets,
    installModuleHook,
  }),
};