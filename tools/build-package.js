"use strict";

/**
 * Builds the distributable artifacts from this checkout.
 *
 *   autopilotJumpZero-<version>-EveJS-<evejs>.zip
 *     README.md install.bat uninstall.bat status.bat
 *     install.js uninstall.js lib/            <- installer
 *     autopilotJumpZero/                       <- payload it copies into mods/
 *
 *   autopilotJumpZero-<version>-EveJS-<evejs>-launcher.zip
 *     autopilotJumpZero/                       <- the same folder, alone
 *
 * The second artifact exists because EveJS Launcher consumes a ZIP whose root
 * is the mod folder and has no use for the installer files.
 *
 * Usage: node tools/build-package.js
 */

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const deployment = require("../installer/lib/deployment");

const MOD_ID = "autopilotJumpZero";
const MOD_DIR = path.resolve(__dirname, "..");
const INSTALLER_DIR = path.join(MOD_DIR, "installer");
const DIST_DIR = path.join(MOD_DIR, "dist");
const PAYLOAD_EXCLUDES = new Set(deployment.DEV_ONLY_DIRECTORIES);
// Development-only helpers at the payload root that are not part of the mod.
const PAYLOAD_EXCLUDED_FILES = new Set(deployment.DEV_ONLY_FILES);

const INSTALLER_FILES = Object.freeze([
  "README.md",
  "install.bat",
  "install.js",
  "status.bat",
  "uninstall.bat",
  "uninstall.js",
  "lib/deployment.js",
  "lib/register.js",
]);

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[index]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

// Fixed DOS timestamp keeps the archives byte-identical between runs.
const DOS_DATE = ((2026 - 1980) << 9) | (9 << 5) | 17;
const DOS_TIME = 0;

function zipEntries(entries) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = entry.data;
    const crc = crc32(data);
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const stored = deflated.length < data.length ? deflated : data;
    const method = stored === deflated ? 8 : 0;

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    locals.push(local, stored);

    const header = Buffer.alloc(46 + name.length);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt16LE(DOS_TIME, 12);
    header.writeUInt16LE(DOS_DATE, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(stored.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE(0, 38);
    header.writeUInt32LE(offset, 42);
    name.copy(header, 46);
    central.push(header);

    offset += local.length + stored.length;
  }

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuffer, end]);
}

function collect(directory, prefix, excludes, collected = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (excludes.has(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collect(full, `${prefix}${entry.name}/`, excludes, collected);
    } else if (entry.isFile() && !PAYLOAD_EXCLUDED_FILES.has(entry.name)) {
      collected.push({ name: `${prefix}${entry.name}`, data: fs.readFileSync(full) });
    }
  }
  return collected;
}

function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(MOD_DIR, "evejs-launcher.mod.json"), "utf8"));
  const version = manifest.version;
  const evejsVersion = (manifest.compatibility && manifest.compatibility.evejsVersions[0]) || "unknown";
  const payload = collect(MOD_DIR, `${MOD_ID}/`, PAYLOAD_EXCLUDES);
  if (!payload.some((entry) => entry.name === `${MOD_ID}/loader.js`)) {
    throw new Error("payload is missing loader.js");
  }
  if (payload.some((entry) => entry.name.startsWith(`${MOD_ID}/installer/`))) {
    throw new Error("installer scaffolding leaked into the payload");
  }

  fs.mkdirSync(DIST_DIR, { recursive: true });
  const base = `${MOD_ID}-${version}-EveJS-${evejsVersion}`;

  const installerEntries = INSTALLER_FILES.map((relative) => ({
    name: relative,
    data: fs.readFileSync(path.join(INSTALLER_DIR, ...relative.split("/"))),
  }));

  const artifacts = [
    { name: `${base}.zip`, entries: [...installerEntries, ...payload] },
    { name: `${base}-launcher.zip`, entries: payload },
  ];

  for (const artifact of artifacts) {
    const buffer = zipEntries(artifact.entries);
    fs.writeFileSync(path.join(DIST_DIR, artifact.name), buffer);
    process.stdout.write(`${artifact.name}  ${buffer.length} bytes  ${artifact.entries.length} files\n`);
  }

  // The development tree is not a launcher target; keep the shipped folder out
  // of it so `mods/` is only ever populated by the installer.
  process.stdout.write(`\nWrote ${artifacts.length} artifacts to ${DIST_DIR}\n`);
}

main();