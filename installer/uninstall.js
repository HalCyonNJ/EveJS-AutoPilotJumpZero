"use strict";

/**
 * Autopilot Jump Zero - uninstall / rollback.
 *
 * Removes the two preload registrations (Docker entrypoint and the native
 * StartServer.bat launcher) and retires the mod folder. The removals are surgical rather than
 * restored from a whole-file backup, so uninstalling this mod never undoes
 * another mod that registered itself later.
 *
 * Usage:
 *   node uninstall.js --server "D:\eve\v0.12.9"
 *   node uninstall.js --server "D:\eve\v0.12.9" --dry-run
 *   node uninstall.js --server "D:\eve\v0.12.9" --keep-files
 *   node uninstall.js --status --server "D:\eve\v0.12.9"
 */

const fs = require("node:fs");
const path = require("node:path");

const deployment = require("./lib/deployment");
const register = require("./lib/register");

const INSTALLER_DIR = __dirname;

function out(line = "") {
  process.stdout.write(`${line}\n`);
}

function fail(message) {
  out("");
  out(`[FAIL] ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

function parseArgs(argv) {
  const options = { server: "", dockerOnly: false, nativeOnly: false, dryRun: false, keepFiles: false, status: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--server" && argv[index + 1]) options.server = argv[(index += 1)];
    else if (arg.startsWith("--server=")) options.server = arg.slice("--server=".length);
    else if (arg === "--docker-only") options.dockerOnly = true;
    else if (arg === "--native-only") options.nativeOnly = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--keep-files") options.keepFiles = true;
    else if (arg === "--status") options.status = true;
    else if (arg === "--help" || arg === "-h") {
      out("Usage: node uninstall.js [--server <EveJS root>] [--docker-only|--native-only]");
      out("                      [--dry-run] [--keep-files] [--status]");
      process.exit(0);
    } else if (!arg.startsWith("--") && !options.server) options.server = arg;
  }
  if (options.dockerOnly && options.nativeOnly) {
    fail("--docker-only and --native-only are mutually exclusive");
  }
  return options;
}

function resolveRoot(options) {
  const explicit = options.server || process.env.EVEJS_SERVER || process.env.EVEJS_ROOT || "";
  if (explicit) {
    const resolved = path.resolve(explicit);
    if (!deployment.isEveJsRoot(resolved)) {
      fail(`${resolved} does not look like an EveJS 0.12.9 root (server/index.js and beyonceService.js must exist)`);
    }
    return resolved;
  }
  const starts = [INSTALLER_DIR, process.cwd()];
  let roots = deployment.findEveJsRoots(starts);
  if (roots.length === 0) roots = deployment.findDeeperEveJsRoots(starts);
  if (roots.length === 1) return roots[0];
  if (roots.length === 0) fail("could not find an EveJS installation; pass --server <EveJS root>");
  fail(`several EveJS installations were found; pass --server <root>. Candidates: ${roots.join(", ")}`);
}

function reportStatus(root, deployments) {
  const modDir = path.join(root, "mods", deployment.MOD_ID);
  out(`EveJS root : ${root}`);
  out(`Mod folder : ${modDir} (${fs.existsSync(path.join(modDir, "loader.js")) ? "present" : "absent"})`);
  if (deployments.docker.present) {
    const text = deployment.readText(deployments.docker.entrypoint);
    const registered = register.hasEntrypointPreload(text, { requirePath: register.containerRequirePath(deployment.MOD_ID) });
    out(`Docker     : ${registered ? "registered" : "not registered"} (${deployments.docker.entrypoint})`);
  }
  if (deployments.native.present) {
    const text = deployment.readText(deployments.native.startServerBat);
    const registered = register.hasStartServerPreload(text);
    const current =
      registered &&
      register.startServerPreloadIsCurrent(text, {
        requirePath: register.nativeRequirePath(deployment.MOD_ID),
        existPath: register.nativeExistPath(deployment.MOD_ID),
      });
    const state = !registered ? "not registered" : current ? "registered" : "registered (legacy form)";
    out(`Native     : ${state} (${deployments.native.startServerBat})`);
    if (registered && !current) {
      out("             re-run the installer to upgrade it to the append-only form");
    }
  }
}

function removeRegistration(options) {
  const { file, label, result, preload, dryRun, write } = options;
  if (!result.ok) {
    out(`[WARN] ${label}: ${result.reason}`);
    return { failed: true };
  }
  if (!result.changed) {
    out(`[SKIP] ${label}: nothing to remove`);
    return { failed: false };
  }
  if (dryRun) {
    out(`[PLAN] ${label}: would remove ${preload}`);
    return { failed: false };
  }
  write();
  out(`[ OK ] ${label}: removed ${preload}`);
  return { failed: false };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = resolveRoot(options);
  const deployments = deployment.detectDeployments(root);

  if (options.status) {
    reportStatus(root, deployments);
    return;
  }

  const useDocker = deployments.docker.present && !options.nativeOnly;
  const useNative = deployments.native.present && !options.dockerOnly;

  out("============================================================");
  out("  Autopilot Jump Zero - Uninstall / Rollback");
  out("============================================================");
  out(`  EveJS root : ${root}`);
  if (options.dryRun) out("  DRY RUN    : nothing will be written");
  out("------------------------------------------------------------");

  const backupRoot = path.join(root, deployment.BACKUP_DIRNAME, deployment.timestamp());

  if (useDocker) {
    const file = deployments.docker.entrypoint;
    const preload = register.containerRequirePath(deployment.MOD_ID);
    const result = register.removeEntrypointPreload(deployment.readText(file), { requirePath: preload });
    removeRegistration({
      file,
      label: "docker/entrypoint.sh",
      preload,
      result,
      dryRun: options.dryRun,
      write() {
        deployment.archivePath(root, file, backupRoot);
        deployment.writeText(file, result.text);
      },
    });
  }

  if (useNative) {
    const file = deployments.native.startServerBat;
    const preload = register.nativeRequirePath(deployment.MOD_ID);
    const result = register.removeStartServerPreload(deployment.readText(file));
    removeRegistration({
      file,
      label: "StartServer.bat",
      preload,
      result,
      dryRun: options.dryRun,
      write() {
        deployment.archivePath(root, file, backupRoot);
        deployment.writeText(file, result.text);
      },
    });
  }

  const modDir = path.join(root, "mods", deployment.MOD_ID);
  const present = fs.existsSync(modDir);
  if (!present) {
    out(`[SKIP] mods/${deployment.MOD_ID}: not present`);
  } else if (options.keepFiles) {
    out(`[SKIP] mods/${deployment.MOD_ID}: kept (--keep-files)`);
  } else if (options.dryRun) {
    out(`[PLAN] mods/${deployment.MOD_ID}: would archive and remove`);
  } else {
    const archived = deployment.archivePath(root, modDir, backupRoot);
    fs.rmSync(modDir, { recursive: true, force: true });
    out(`[ OK ] mods/${deployment.MOD_ID}: removed (archived at ${archived})`);
  }

  out("------------------------------------------------------------");
  out("");
  out("  Next steps");
  if (useDocker) {
    out("    Docker : docker compose build && docker compose up -d --no-deps server");
  }
  if (useNative) {
    out("    Native : restart the server with StartServer.bat");
  }
  out("");
  out("  With the preload gone the server falls back to vanilla behaviour: the");
  out("  autopilot warps to 10 km and approaches the gate before jumping.");
}

try {
  main();
} catch (error) {
  if (!process.exitCode) process.exitCode = 1;
  if (process.env.EVEJS_AUTOPILOT_JUMP_ZERO_DEBUG) out(error.stack);
}