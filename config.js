"use strict";

// There is no configuration file. The mod reads three environment variables and
// nothing else: the shipped defaults are the intended behaviour, and the only
// value worth touching is the stargate clearance (see the README).
const KEYS = Object.freeze({
  enabled: "EVEJS_AUTOPILOT_JUMP_ZERO",
  surfaceClearanceMeters: "EVEJS_AUTOPILOT_JUMP_ZERO_SURFACE_CLEARANCE_METERS",
  verbose: "EVEJS_AUTOPILOT_JUMP_ZERO_VERBOSE",
});

const DEFAULTS = Object.freeze({
  enabled: true,
  // Extra room between the hull and a stargate's surface, so a capital ship
  // does not materialise inside the gate's collision volume. Capped at the
  // ship's own radius, so a frigate keeps the old landing and only hulls that
  // are actually big gain the offset.
  surfaceClearanceMeters: 500,
  verbose: false,
});

const MIN_SURFACE_CLEARANCE_METERS = 0;
const MAX_SURFACE_CLEARANCE_METERS = 2000;

function readBoolean(value, fallback) {
  if (value == null || String(value).trim() === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on", "enabled"].includes(normalized)) return true;
  if (["0", "false", "no", "off", "disabled"].includes(normalized)) return false;
  return fallback;
}

function load(environment = process.env) {
  const pick = (key) => (
    environment[key] != null && String(environment[key]).trim() !== ""
      ? environment[key]
      : null
  );
  const problems = [];
  const readClearance = () => {
    const key = KEYS.surfaceClearanceMeters;
    const raw = pick(key);
    if (raw == null) return DEFAULTS.surfaceClearanceMeters;
    const numeric = Number(raw);
    if (
      !Number.isFinite(numeric) ||
      numeric < MIN_SURFACE_CLEARANCE_METERS ||
      numeric > MAX_SURFACE_CLEARANCE_METERS
    ) {
      problems.push(
        `${key} must be a finite number between ${MIN_SURFACE_CLEARANCE_METERS} and ${MAX_SURFACE_CLEARANCE_METERS}`,
      );
      return DEFAULTS.surfaceClearanceMeters;
    }
    return numeric;
  };
  return Object.freeze({
    enabled: readBoolean(pick(KEYS.enabled), DEFAULTS.enabled),
    surfaceClearanceMeters: readClearance(),
    verbose: readBoolean(pick(KEYS.verbose), DEFAULTS.verbose),
    problems: Object.freeze(problems),
  });
}

module.exports = {
  DEFAULTS,
  KEYS,
  MAX_SURFACE_CLEARANCE_METERS,
  MIN_SURFACE_CLEARANCE_METERS,
  load,
  readBoolean,
};
