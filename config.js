"use strict";

const fs = require("node:fs");
const path = require("node:path");

const KEYS = Object.freeze({
  enabled: "EVEJS_AUTOPILOT_JUMP_ZERO",
  warpInDistanceMeters: "EVEJS_AUTOPILOT_JUMP_ZERO_WARP_IN_METERS",
  verbose: "EVEJS_AUTOPILOT_JUMP_ZERO_VERBOSE",
});

const DEFAULTS = Object.freeze({
  enabled: true,
  // 0 = autopilot warps land on the target surface, exactly like a manual
  // "Warp to within 0 m". That puts a stargate landing inside the 2500 m jump
  // bubble the client checks, and a station landing inside docking range.
  warpInDistanceMeters: 0,
  verbose: false,
});

const MIN_WARP_IN_DISTANCE_METERS = 0;
const MAX_WARP_IN_DISTANCE_METERS = 1000000;

function readEnvFile(file) {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (_error) {
    return {};
  }
  const result = {};
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (value.length >= 2 && ["\"", "'"].includes(value[0]) && value.endsWith(value[0])) {
      value = value.slice(1, -1);
    }
    if (key) result[key] = value;
  }
  return result;
}

function readBoolean(value, fallback) {
  if (value == null || String(value).trim() === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on", "enabled"].includes(normalized)) return true;
  if (["0", "false", "no", "off", "disabled"].includes(normalized)) return false;
  return fallback;
}

function load(modDir, environment = process.env) {
  const fileValues = readEnvFile(path.join(modDir, ".env"));
  const pick = (key) => (
    environment[key] != null && String(environment[key]).trim() !== ""
      ? environment[key]
      : fileValues[key]
  );
  const problems = [];
  const readDistance = () => {
    const key = KEYS.warpInDistanceMeters;
    const raw = pick(key);
    if (raw == null || String(raw).trim() === "") return DEFAULTS.warpInDistanceMeters;
    const numeric = Number(raw);
    if (
      !Number.isFinite(numeric) ||
      numeric < MIN_WARP_IN_DISTANCE_METERS ||
      numeric > MAX_WARP_IN_DISTANCE_METERS
    ) {
      problems.push(
        `${key} must be a finite number between ${MIN_WARP_IN_DISTANCE_METERS} and ${MAX_WARP_IN_DISTANCE_METERS}`,
      );
      return DEFAULTS.warpInDistanceMeters;
    }
    return numeric;
  };
  return Object.freeze({
    enabled: readBoolean(pick(KEYS.enabled), DEFAULTS.enabled),
    warpInDistanceMeters: readDistance(),
    verbose: readBoolean(pick(KEYS.verbose), DEFAULTS.verbose),
    problems: Object.freeze(problems),
  });
}

module.exports = {
  DEFAULTS,
  KEYS,
  MAX_WARP_IN_DISTANCE_METERS,
  MIN_WARP_IN_DISTANCE_METERS,
  load,
  readBoolean,
  readEnvFile,
};