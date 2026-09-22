"use strict";

// Filesystem-side helpers for the installer: locating an EveJS root, detecting
// which deployments are present, archiving what is about to change, and
// copying the payload. Kept apart from lib/register.js so the text transforms
// stay testable without a real checkout.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MOD_ID = "beta-autopilotJumpZero";
const PAYLOAD_DIRNAME = "mod";
const BACKUP_DIRNAME = "_beta-autopilotjumpzero-backup";
const REQUIRED_FILES = Object.freeze([
  path.join("server", "index.js"),
  path.join("server", "src", "services", "ship", "beyonceService.js"),
]);
// Everything under the mod root that belongs to the development checkout only.
// The installer prunes these from an already-installed folder, so an installed
// mods\beta-autopilotJumpZero holds the payload and nothing else.
const DEV_ONLY_DIRECTORIES = Object.freeze(["installer", "node_modules", ".git"]);
const DEV_ONLY_FILES = Object.freeze([]);
const DOCKER_ENTRYPOINT = path.join("docker", "entrypoint.sh");
// The native entry point. Deliberately not server/package.json: that file is
// an input to the image's dependency layer, so editing it forces npm ci to
// re-run on the next Docker build.
const NATIVE_START_SERVER = "StartServer.bat";

function isFile(target) {
  try {
    return fs.statSync(target).isFile();
  } catch (_error) {
    return false;
  }
}

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch (_error) {
    return false;
  }
}

function isEveJsRoot(dir) {
  if (!dir) return false;
  return REQUIRED_FILES.every((relative) => isFile(path.join(dir, relative)));
}

function readText(file) {
  return fs.readFileSync(file, "utf8");
}

function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
}

function ensureDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function childrenOf(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name));
  } catch (_error) {
    return [];
  }
}

function ancestor(dir, levels) {
  let current = path.resolve(dir);
  for (let level = 0; level < levels; level += 1) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

// The first tier asks only about each starting point and its siblings, so an
// installer unpacked next to (or inside) the EveJS root it targets resolves to
// exactly one candidate and never wanders into unrelated trees.
function findEveJsRoots(startDirs) {
  const ordered = [];
  const seen = new Set();
  const push = (dir) => {
    const resolved = path.resolve(dir);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    ordered.push(resolved);
  };

  for (const start of startDirs) {
    push(start);
    for (const sibling of childrenOf(path.dirname(start))) push(sibling);
  }
  return ordered.filter((dir) => isEveJsRoot(dir));
}

// Used only when the first tier finds nothing: an installer living deep inside
// an install (mods/<mod>/installer/) has to walk up before it can see the root.
function findDeeperEveJsRoots(startDirs, levels = 4) {
  const ordered = [];
  const seen = new Set();
  const push = (dir) => {
    const resolved = path.resolve(dir);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    ordered.push(resolved);
  };

  for (const start of startDirs) {
    for (let level = 1; level <= levels; level += 1) {
      const base = ancestor(start, level);
      push(base);
      for (const child of childrenOf(base)) push(child);
    }
  }
  return ordered.filter((dir) => isEveJsRoot(dir));
}

function detectDeployments(root) {
  const entrypoint = path.join(root, DOCKER_ENTRYPOINT);
  const startServerBat = path.join(root, NATIVE_START_SERVER);
  return {
    docker: { name: "docker", entrypoint, present: isFile(entrypoint) },
    native: { name: "native", startServerBat, present: isFile(startServerBat) },
  };
}

function timestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

// Archives a file or directory under <EveJS root>/_beta-autopilotjumpzero-backup/ so
// uninstall.bat can always restore something by hand, even after a later mod
// rewrites the same lines again.
function archivePath(root, sourcePath, backupRoot) {
  const target = path.join(backupRoot, path.relative(root, sourcePath));
  ensureDirectory(path.dirname(target));
  fs.cpSync(sourcePath, target, { recursive: true, force: true });
  return target;
}

function digestTree(dir) {
  const hash = crypto.createHash("sha256");
  const walk = (current) => {
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (_error) {
      return;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        hash.update(`d:${path.relative(dir, full)}\n`);
        walk(full);
      } else if (entry.isFile()) {
        hash.update(`f:${path.relative(dir, full)}\n`);
        hash.update(fs.readFileSync(full));
      }
    }
  };
  walk(dir);
  return hash.digest("hex");
}

function copyTree(source, target) {
  ensureDirectory(target);
  fs.cpSync(source, target, { recursive: true, force: true });
}

module.exports = {
  BACKUP_DIRNAME,
  DEV_ONLY_DIRECTORIES,
  DEV_ONLY_FILES,
  DOCKER_ENTRYPOINT,
  MOD_ID,
  NATIVE_START_SERVER,
  PAYLOAD_DIRNAME,
  REQUIRED_FILES,
  archivePath,
  copyTree,
  detectDeployments,
  digestTree,
  ensureDirectory,
  findDeeperEveJsRoots,
  findEveJsRoots,
  isDirectory,
  isEveJsRoot,
  isFile,
  readText,
  timestamp,
  writeText,
};