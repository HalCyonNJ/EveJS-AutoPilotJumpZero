# Autopilot Jump Zero for EveJS 261018.1

EveJS 261018.1 mod for both supported deployments - native (Windows) and Docker - that makes the in-game autopilot warp to the target itself instead of stopping roughly 10 km short of it, so a stargate jump fires the moment the warp ends and a station destination docks on arrival. The landing is also sized to the hull, so a carrier or a titan no longer materialises inside a stargate's collision volume.

It patches EveJS only in memory. No vendor source file is edited on disk, and the game client is not touched at all.

See [HOW-IT-WORKS.md](HOW-IT-WORKS.md) for the full mechanism - the client/server split, the exact seam, the in-memory transform, the fail-closed gate, and the invariants to preserve if you modify it.

[CHANGELOG.md](CHANGELOG.md) lists what each release contains.

## At a glance

The autopilot warp lands **on** its target instead of stopping roughly 10 km short, so a stargate jump
fires the moment the warp ends and a station destination docks on arrival:

- 🚀 gates: the warp lands inside the client's jump bubble, so the jump goes out as the warp ends,
- 🛰️ stations and structures: the warp lands inside docking range, so the autopilot docks on arrival,
- 📏 the landing is sized to the hull: the ship's own radius is added to the gate's exit point, plus a
  clearance capped at that radius, so a carrier or a titan lands beside the gate instead of inside it,
- 🎛️ one optional setting: `EVEJS_AUTOPILOT_JUMP_ZERO_SURFACE_CLEARANCE_METERS` (default `500`);
  the autopilot distance itself is fixed at `0` and has no knob,
- 🖱️ manual warps, fleet warps, scan-result warps and agent warps carry their own range and are untouched,
- 🧱 a seam that is missing, duplicated or already owned by another patch makes the mod **fail closed**: it
  logs why and the server keeps vanilla autopilot,
- 🎁 no client change and no source file edited on disk - two files are transformed in memory at startup.

`EVEJS_AUTOPILOT_JUMP_ZERO=0` disables it. There is **no configuration file**: read the environment
variable on the `server` service in Compose (or export it before starting a native server). A value
outside the documented range is rejected at load time and the mod goes inert rather than guessing.

Everything in this repository - `README.md`, `HOW-IT-WORKS.md` and `installer/README.md` - is written
to be read by a person or fed to an AI, so the mod can be understood and changed.
## Why this works on the server

The retail client autopilot (`eve/client/script/parklife/autopilot.py`) does two separate things:

- it asks the server to warp with `michelle.GetRemotePark().CmdWarpToStuffAutopilot(destinationID)` - a bare target, no range - so the landing point is entirely the server's decision;
- it decides on its own to jump once the **surface** distance to the gate drops under `const.maxStargateJumpingDistance` (2500 m), and to dock once the surface distance to a station drops under `const.maxDockingDistance` (50000 m).

EveJS 261018.1 (and 0.12.9 before it) hardcodes that autopilot landing to `{ minimumRange: 10000 }` in `Handle_CmdWarpToStuffAutopilot`. Landing 10 km from the gate puts the ship outside the jump bubble, so the autopilot has to burn an extra approach leg before it can jump - the slow part of travelling.

Raising the server's stargate jump range does not help, because the client never reads it. The server owns two levers: the warp-in distance (now fixed at 0 by the mod) and the geometry that turns a stargate into an exit point (sized to the hull).

## What it changes

Two seams, both transformed in memory.

**1. The autopilot landing**, in `server/src/services/ship/beyonceService.js`:

```js
// vanilla
const result = spaceRuntime.warpToEntity(session, targetID, { minimumRange: 10000 });

// with the mod installed
const result = spaceRuntime.warpToEntity(session, targetID, { minimumRange: 0 }); /* autopilotJumpZero: autopilot warp-in distance */
```

Only the autopilot warp's *range* is affected by this seam. Manual "Warp to", fleet warps, scan-result warps, agent/dungeon warps and every other warp call carry their own explicit range and are left untouched.

**2. The stargate landing geometry**, in `server/src/space/destiny/simulation/warpTargets.js`:

```js
// vanilla
scaleVector(fromGateToShip, gateRadius + explicitSurfaceRange),

// with the mod installed
scaleVector(fromGateToShip, gateRadius + explicitSurfaceRange + (globalThis[Symbol.for("evejs.autopilotJumpZero")]?.stargateSurfaceOffset?.(entity) ?? 0)), /* autopilotJumpZero: stargate surface offset */
```

That function is the one place a stargate warp's exit point is produced. Vanilla builds it as *gate radius
plus the requested surface range* and never adds the ship's own radius, so a "warp to 0" ends with the hull's
**centre on the gate's surface**: a frigate (31 m) shrugs that off, a carrier (1.6 km) and a titan (7.5 km)
land with most of the hull inside the gate, and the client throws them clear. The mod adds the hull's radius
plus a clearance capped at that radius, so the landing surface distance is never negative and the hull's own
size is what decides how far out it lands.

With the defaults (`0` m and `500` m clearance):

- a stargate warp lands just outside the gate - the hull's own radius plus the clearance - inside the jump bubble the client checks, so `CmdStargateJump` goes out as the warp ends;
- a station or structure warp lands inside docking range, so the autopilot docks on arrival.

## Install

Get this folder into `<EveJS root>\mods\autopilotJumpZero` - clone the repository, copy the
folder, or take `Source code (zip)` from the release you want - and run the installer from inside it.

The folder name matters: the preload points at `mods\autopilotJumpZero`, so a GitHub archive
whose top-level folder is named `EveJS-AutoPilotJumpZero-*` has to be renamed to that.

### Installer (native and Docker)

Run the installer with no arguments and it assumes EveJS is installed on this computer and
finds the root itself. Use `--server "C:\path\to\EveJS"` only to override that search.

```text
installer\install.bat
```

It copies this folder to `<EveJS root>\mods\autopilotJumpZero` and registers the preload in
every deployment it finds:

| Deployment | Registered in | Entry added |
|---|---|---|
| Docker | `docker/entrypoint.sh`, in both `run_server()` and `run_all()` | `--require /app/mods/autopilotJumpZero/loader.js` |
| Docker build context | `.dockerignore` | `!mods/` and `!mods/**`, because 261018.1 starts from `**` and does not mention `mods/` |
| Native | `StartServer.bat`, once the installer adds the block (this checkout's launcher has none) | `NODE_OPTIONS=<existing> --require "…\mods\autopilotJumpZero\loader.js"` (appended) |

Both registrations are idempotent, and every file the installer rewrites is
copied to `<EveJS root>\_autopilotjumpzero-backup\<timestamp>\` first. The
native block **appends** to `NODE_OPTIONS` instead of claiming it, so it composes
with other loader mods; a block left behind by v1.1.1 is upgraded in place by
re-running the installer. The `.dockerignore` lines are added once, before the
`**/node_modules` block, and are deliberately **left in place on uninstall** -
another loader mod may still need them.

`--docker-only` and `--native-only` restrict it to one deployment, `--dry-run`
reports without writing, and `installer\status.bat` shows what is currently registered.

Afterwards rebuild a Docker deployment, or restart a native one:

```text
Docker : docker compose build && docker compose up -d --no-deps server
Native : restart the server with StartServer.bat
```

### EveJS Launcher (third-party)

The third-party **EveJS Launcher** installs a mod from a ZIP, and this folder is already
the package it wants: `evejs-launcher.mod.json` sits beside `loader.js`, and the archive
built by `tools\BuildPackage.bat` has `autopilotJumpZero\` as its single top-level folder.

1. **Mods > Add ZIP**, and pick the ZIP from the release page - or the local
   `dist\autopilotJumpZero-<version>.zip`. (GitHub's own `Source code (zip)` unpacks as
   `EveJS-AutoPilotJumpZero-<version>\`; rename that folder to `autopilotJumpZero` if you
   use it instead.)
2. Turn on the toggle beside **Autopilot Jump Zero**.
3. There is no Configure panel: the manifest declares no `settings` block, and there is no
   configuration file either - the only value worth touching is an environment variable
   (see Configuration).
4. Restart the game server when the launcher asks. A Docker deployment still needs
   `docker compose build && docker compose up -d --no-deps server`, because `mods/` is
   baked into the image; a native one is a restart with `StartServer.bat`.

The manifest declares `kind: "loader"` and `activation.strategy: "loader_rename"`, and this
mod is server-side only: no client component, no login handshake and no vendor patch step,
so the launcher has no client half to prepare and a disable or a remove has nothing outside
`mods\autopilotJumpZero\` to undo.

**Implemented, not verified:** no EveJS Launcher is available on the machine this mod is
developed on, so this install path has **not been tested by the authors**. Treat it as
unverified - if anything looks wrong, fall back to `installer\install.bat` for a Windows
native install or to the Docker rebuild above.

### Manual

1. Copy this folder to `mods/autopilotJumpZero` inside your EveJS install.
2. Preload the loader before any other server module, next to the other `--require` entries:

```text
# Native, run from the server directory
node --require ../mods/autopilotJumpZero/loader.js .

# Native, without editing a vendor file. NODE_OPTIONS is a list, so append to
# it: overwriting it disables every other loader mod you have installed.
# Forward slashes are required - Node's NODE_OPTIONS parser eats backslashes,
# turning C:\a\loader.js into C:aloader.js.
NODE_OPTIONS=<existing> --require <evejs>/mods/autopilotJumpZero/loader.js

# Docker, in docker/entrypoint.sh - both run_server() and run_all()
    --require /app/mods/autopilotJumpZero/loader.js \

# Docker, in .dockerignore - a manual install must add BOTH lines, or the image
# never receives mods/ and the preload above fails with "Cannot find module":
!mods/
!mods/**
```

3. Restart the server. A `[autopilotJumpZero] v1.2.0 active — autopilot warp-in distance 0 m, stargate surface clearance up to 500 m` line confirms it.

No client update is required and none is produced.

## Configuration

There is **no configuration file** and nothing to copy. The autopilot distance is fixed at `0`; the only
value worth touching is the stargate clearance, and it is an ordinary environment variable:

| Setting | Default | Meaning |
|---|---:|---|
| `EVEJS_AUTOPILOT_JUMP_ZERO` | `1` | `0` disables the mod and restores vanilla behaviour. |
| `EVEJS_AUTOPILOT_JUMP_ZERO_SURFACE_CLEARANCE_METERS` | `500` | Extra room between the hull and a stargate's surface, `0` to `2000`. Capped at the ship's own radius. |
| `EVEJS_AUTOPILOT_JUMP_ZERO_VERBOSE` | `0` | Logs extra hook details. |

The clearance only matters for stargate landings and only for hulls big enough to reach it:

- the mod always adds the ship's own radius to the gate's exit point, so the hull never sits inside the gate;
- on top of that it adds `min(clearance, ship radius)`, so a frigate (31 m) gains ~31 m, a battleship
  250 m, and a carrier or titan the full 500 m;
- larger values are safer but push more landings past the client's 2500 m jump bubble, where the ship closes
  the last stretch at sub-warp speed. `0` gives the tightest landing and relies on touching being harmless.

An out-of-range or non-numeric value is rejected at load time and the mod goes inert rather than guessing.

Set it on the `server` service (Docker) or export it before starting the native launcher:

```yaml
    environment:
      EVEJS_AUTOPILOT_JUMP_ZERO_SURFACE_CLEARANCE_METERS: "500"
```

With no environment variable at all, the mod runs on its defaults, which are the intended settings
(enabled, `0` m distance, `500` m clearance).

## Compatibility and safety

The loader validates both target files before touching them and fails closed: if an anchor, a seam, or the surrounding file shape is missing, duplicated, or already modified, no hooks are installed and the reason is logged.

This includes a server whose own source already carries a config-driven autopilot warp-in distance (for example a hand-applied `{ minimumRange: warpInDistanceMeters }` patch), and a server whose stargate envelope already adds the ship radius. Both are reported as owned by another patch and the mod stays inert, so the two never fight.

The mod is inert in worker threads and refuses to install if a target module was already loaded.

Verified against EveJS 261018.1 (`beyonceService.js` and `warpTargets.js`, build shipped with SDE 3396210).

## Verification

```text
RunTests.bat
# or
node test/run.js
```

The suite covers the config surface, both transforms, idempotency, the fail-closed paths, the hull-size arithmetic, the worker-thread guard, and child-process runs that prove the installed hook hardcodes the zero range into the autopilot handler and feeds the configured offset into the stargate envelope. The development checkout passes 36/36 checks; an installed payload runs the payload subset (the installer cases skip).

On a live 261018.1 server the mod was accepted in game with a titan and a freighter: both jump on arrival and were not thrown clear by the stargate.

In the server log, confirmation is the same: `CmdWarpToStuffAutopilot` is followed within a second by `CmdStargateJump` for the same character, with no `CmdFollowBall` / `CmdSetSpeedFraction` in between.

## Uninstall

1. Stop the server.
2. Run `installer\uninstall.bat --server "<EveJS root>"`, or turn
   the mod off in the launcher, or remove the `--require .../autopilotJumpZero/loader.js`
   entries and the `mods/autopilotJumpZero` folder by hand.
3. Rebuild first if Docker is used, then restart.

The two transformed files are never rewritten: only the in-memory copies differ. Uninstall removes the
registrations it added; the `!mods/` / `!mods/**` lines in `.dockerignore` are deliberately left in place,
because another loader mod may still need them.
