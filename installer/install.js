"use strict";

/**
 * Autopilot Jump Zero - installer.
 *
 * The mod itself never edits EveJS source on disk; it is a loader that
 * transforms one file in memory. What has to be registered is the preload
 * itself, and each deployment offers a different place to do it:
 *
 *   Docker  docker/entrypoint.sh   --require /app/mods/beta-autopilotJumpZero/loader.js
 *   Native  StartServer.bat        NODE_OPTIONS=%NODE_OPTIONS% --require %EVEJS_REPO_ROOT%/mods/...
 *                                  (inherited by both npm start branches)
 *
 * Both registrations are idempotent, both are backed up before being written,
 * and `--server` may be pointed at either kind of checkout. The native one
 * appends to NODE_OPTIONS rather than assigning it, so it composes with other
 * loader mods instead of racing them for the variable.
 *
 * Usage:
 *   node install.js --server "D:\eve\v0.12.9"
 *   node install.js --server "D:\eve\v0.12.9" --dry-run
 *   node install.js --server "D:\eve\v0.12.9" --docker-only
 *   node install.js --status --server "D:\eve\v0.12.9"
 */

const fs = require("node:fs");
const path = require("node:path");

const deployment = require("./lib/deployment");
const register = require("./lib/register");

const INSTALLER_DIR = __dirname;
const COPY_EXCLUDES = new Set(deployment.DEV_ONLY_DIRECTORIES);
const COPY_EXCLUDED_FILES = new Set(deployment.DEV_ONLY_FILES);

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
  const options = {
    server: "",
    dockerOnly: false,
    nativeOnly: false,
    dryRun: false,
    force: false,
    status: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--server" && argv[index + 1]) options.server = argv[(index += 1)];
    else if (arg.startsWith("--server=")) options.server = arg.slice("--server=".length);
    else if (arg === "--docker-only") options.dockerOnly = true;
    else if (arg === "--native-only") options.nativeOnly = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--force") options.force = true;
    else if (arg === "--status") options.status = true;
    else if (arg === "--help" || arg === "-h") {
      out("Usage: node install.js [--server <EveJS root>] [--docker-only|--native-only]");
      out("                      [--dry-run] [--force] [--status]");
      process.exit(0);
    } else if (!arg.startsWith("--") && !options.server) options.server = arg;
  }
  if (options.dockerOnly && options.nativeOnly) {
    fail("--docker-only and --native-only are mutually exclusive");
  }
  return options;
}

// The payload is the mod folder shipped beside the installer (`mod/` and
// `beta-autopilotJumpZero/` are both accepted), and this installer's parent
// directory in the development tree, where the mod is the git checkout itself.
function payloadCandidates() {
  return [
    path.join(INSTALLER_DIR, deployment.PAYLOAD_DIRNAME),
    path.join(INSTALLER_DIR, deployment.MOD_ID),
    path.dirname(INSTALLER_DIR),
    path.join(path.dirname(INSTALLER_DIR), deployment.MOD_ID),
    path.dirname(path.dirname(INSTALLER_DIR)),
  ];
}

function resolvePayload() {
  const candidates = payloadCandidates();
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "loader.js")) && fs.existsSync(path.join(dir, "evejs-launcher.mod.json"))) {
      let version = "unknown";
      try {
        version = JSON.parse(fs.readFileSync(path.join(dir, "evejs-launcher.mod.json"), "utf8")).version || version;
      } catch (_error) {
        version = "unknown";
      }
      return { dir, version };
    }
  }
  return fail("could not find the mod payload (loader.js + evejs-launcher.mod.json) next to this installer");
}

function promptForRoot(roots) {
  if (!process.stdin.isTTY) return "";
  out("Several EveJS installations were found:");
  roots.forEach((root, index) => out(`  [${index + 1}] ${root}`));
  out("  [0] none of these");
  process.stdout.write("  Choose one: ");
  const buffer = Buffer.alloc(64);
  let answer = "";
  try {
    const read = fs.readSync(0, buffer, 0, buffer.length, null);
    answer = buffer.slice(0, read).toString("utf8").trim();
  } catch (_error) {
    return "";
  }
  const choice = Number(answer);
  return Number.isInteger(choice) && choice >= 1 && choice <= roots.length ? roots[choice - 1] : "";
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
  if (roots.length === 0) {
    fail("could not find an EveJS installation; pass --server <EveJS root>");
  }
  const chosen = promptForRoot(roots);
  if (chosen) return chosen;
  fail(`several EveJS installations were found; pass --server <root>. Candidates: ${roots.join(", ")}`);
}

function copyPayload(source, target) {
  fs.mkdirSync(target, { recursive: true });
  // Prune development-only leftovers so refreshing an existing install leaves
  // exactly the payload behind.
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (COPY_EXCLUDES.has(entry.name) || COPY_EXCLUDED_FILES.has(entry.name)) {
      fs.rmSync(path.join(target, entry.name), { recursive: true, force: true });
    }
  }
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (COPY_EXCLUDES.has(entry.name) || COPY_EXCLUDED_FILES.has(entry.name)) continue;
    // A local .env is the operator's configuration; never overwrite it on
    // reinstall. Delete it first if the shipped defaults are wanted.
    if (entry.name === ".env" && fs.existsSync(path.join(target, ".env"))) continue;
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) copyPayload(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

function applyRegistration(options) {
  const { file, label, result, write } = options;
  if (!result.ok) {
    out(`[WARN] ${label}: ${result.reason}`);
    out(`       ${label} was left untouched; register the preload by hand:`);
    out(`       ${file}`);
    return { changed: false, failed: true };
  }
  if (!result.changed) {
    out(`[SKIP] ${label}: preload already registered`);
    return { changed: false, failed: false };
  }
  if (options.dryRun) {
    out(`[PLAN] ${label}: would ${result.upgraded ? "upgrade" : "add"} ${options.preload}`);
    return { changed: true, failed: false };
  }
  write();
  if (result.upgraded) {
    out(`[ OK ] ${label}: upgraded the preload block to the append-only form`);
  } else {
    out(`[ OK ] ${label}: added ${options.preload}`);
  }
  return { changed: true, failed: false };
}

function reportStatus(root, payload, deployments) {
  const modDir = path.join(root, "mods", deployment.MOD_ID);
  const installed = fs.existsSync(path.join(modDir, "loader.js"));
  out(`EveJS root : ${root}`);
  out(`Mod folder : ${modDir}`);
  out(`             ${installed ? `installed (${deployment.digestTree(modDir).slice(0, 12)}${payload ? `, shipped ${deployment.digestTree(payload.dir).slice(0, 12)}` : ""})` : "not installed"}`);
  if (deployments.docker.present) {
    const text = deployment.readText(deployments.docker.entrypoint);
    const registered = register.hasEntrypointPreload(text, { requirePath: register.containerRequirePath(deployment.MOD_ID) });
    out(`Docker     : ${registered ? "registered" : "NOT registered"} (${deployments.docker.entrypoint})`);
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
    const state = !registered ? "NOT registered" : current ? "registered" : "registered (legacy form)";
    out(`Native     : ${state} (${deployments.native.startServerBat})`);
    if (registered && !current) {
      out("             re-run the installer to upgrade it to the append-only form");
    }
  }
  return installed;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const payload = resolvePayload();
  const root = resolveRoot(options);
  const deployments = deployment.detectDeployments(root);

  if (options.status) {
    reportStatus(root, payload, deployments);
    return;
  }

  const useDocker = deployments.docker.present && !options.nativeOnly;
  const useNative = deployments.native.present && !options.dockerOnly;
  if (!useDocker && !useNative) {
    fail(`no ${options.dockerOnly ? "Docker" : "native"} integration point found under ${root}`);
  }

  out("============================================================");
  out(`  Autopilot Jump Zero v${payload.version} - Installer`);
  out("============================================================");
  out(`  EveJS root : ${root}`);
  out(`  Payload    : ${payload.dir}`);
  out(`  Targets    : ${[useDocker ? "docker" : null, useNative ? "native" : null].filter(Boolean).join(" + ")}`);
  if (options.dryRun) out("  DRY RUN    : nothing will be written");
  out("------------------------------------------------------------");

  const backupRoot = path.join(root, deployment.BACKUP_DIRNAME, deployment.timestamp());
  const archived = new Set();
  const archiveOnce = (target) => {
    if (archived.has(target)) return;
    archived.add(target);
    deployment.archivePath(root, target, backupRoot);
  };

  // 1. The mod folder itself.
  const modDir = path.join(root, "mods", deployment.MOD_ID);
  const existed = fs.existsSync(path.join(modDir, "loader.js"));
  if (existed && !options.dryRun && !options.force) archiveOnce(modDir);
  if (options.dryRun) {
    out(`[PLAN] mods/${deployment.MOD_ID}: would ${existed ? "replace" : "create"} from payload`);
  } else {
    fs.mkdirSync(path.dirname(modDir), { recursive: true });
    copyPayload(payload.dir, modDir);
    out(`[ OK ] mods/${deployment.MOD_ID}: ${existed ? "updated" : "installed"}`);
  }

  // 2. Docker: preload the loader from docker/entrypoint.sh.
  if (useDocker) {
    const file = deployments.docker.entrypoint;
    const preload = register.containerRequirePath(deployment.MOD_ID);
    const text = deployment.readText(file);
    const result = register.applyEntrypointPreload(text, { requirePath: preload });
    applyRegistration({
      file,
      label: "docker/entrypoint.sh",
      preload,
      result,
      dryRun: options.dryRun,
      write() {
        archiveOnce(file);
        deployment.writeText(file, result.text);
      },
    });
  }

  // 3. Native: preload the loader from the Windows launcher.
  if (useNative) {
    const file = deployments.native.startServerBat;
    const preload = register.nativeRequirePath(deployment.MOD_ID);
    const text = deployment.readText(file);
    const result = register.applyStartServerPreload(text, {
      requirePath: preload,
      existPath: register.nativeExistPath(deployment.MOD_ID),
    });
    applyRegistration({
      file,
      label: "StartServer.bat",
      preload,
      result,
      dryRun: options.dryRun,
      write() {
        archiveOnce(file);
        deployment.writeText(file, result.text);
      },
    });
  }

  out("------------------------------------------------------------");
  if (archived.size > 0) out(`  Backups    : ${backupRoot}`);
  out("");
  out("  Next steps");
  if (useDocker) {
    out("    Docker : docker compose build");
    out("             docker compose up -d --no-deps server");
    out("             (mods/ is inside the image, so a rebuild is required)");
  }
  if (useNative) {
    out("    Native : restart the server with StartServer.bat");
  }
  out("");
  out(`  Confirm a boot line: [beta-autopilotJumpZero] v${payload.version} active`);
  out("");
  out("  Configuration");
  out("    Native : mods/beta-autopilotJumpZero/.env (EVEJS_AUTOPILOT_JUMP_ZERO_WARP_IN_METERS)");
  out("    Docker : .env is excluded from the image; add the same keys to the");
  out("             server service `environment:` in compose.yaml.");
  out("             The shipped defaults (enabled, 0 m) need no configuration.");
}

try {
  main();
} catch (error) {
  if (!process.exitCode) process.exitCode = 1;
  if (process.env.EVEJS_AUTOPILOT_JUMP_ZERO_DEBUG) out(error.stack);
}