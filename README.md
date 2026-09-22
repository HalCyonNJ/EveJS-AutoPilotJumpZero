# Autopilot Jump Zero Beta for EveJS 0.12.9

EveJS 0.12.9 Beta mod for both supported deployments - native (Windows) and Docker - that makes the in-game autopilot warp to the target itself instead of stopping roughly 10 km short of it, so a stargate jump fires the moment the warp ends and a station destination docks on arrival.

It patches EveJS only in memory. No vendor source file is edited on disk, and the game client is not touched at all.

See [HOW-IT-WORKS.md](HOW-IT-WORKS.md) for the full mechanism - the client/server split, the exact seam, the in-memory transform, the fail-closed gate, and the invariants to preserve if you modify it.

[CHANGELOG.md](CHANGELOG.md) lists what each release contains.

## At a glance

The autopilot warp lands **on** its target instead of stopping roughly 10 km short, so a stargate jump
fires the moment the warp ends and a station destination docks on arrival:

- 🚀 gates: the warp lands inside the client's jump bubble, so the jump goes out as the warp ends,
- 🛰️ stations and structures: the warp lands inside docking range, so the autopilot docks on arrival,
- 🎛️ one number is the whole tuning surface - `EVEJS_AUTOPILOT_JUMP_ZERO_WARP_IN_METERS`, default `0`,
- 🖱️ manual warps, fleet warps, scan-result warps and agent warps carry their own range and are untouched,
- 🧱 a seam that is missing, duplicated or already owned by another patch makes the mod **fail closed**: it
  logs why and the server keeps vanilla autopilot,
- 🎁 no client change and no source file edited on disk - one file is transformed in memory at startup.

`EVEJS_AUTOPILOT_JUMP_ZERO=0` disables it. A value outside `0`-`1000000` is rejected at load time and the
mod goes inert rather than guessing. Settings live in `.env` beside `loader.js` - every variable is
documented in `.env.example` - or as environment variables on the `server` service in Compose.

Everything in this repository - `README.md`, `HOW-IT-WORKS.md` and `installer/README.md` - is written
to be read by a person or fed to an AI, so the mod can be understood and changed.
## Why this works on the server

The retail client autopilot (`eve/client/script/parklife/autopilot.py`) does two separate things:

- it asks the server to warp with `michelle.GetRemotePark().CmdWarpToStuffAutopilot(destinationID)` - a bare target, no range - so the landing point is entirely the server's decision;
- it decides on its own to jump once the **surface** distance to the gate drops under `const.maxStargateJumpingDistance` (2500 m), and to dock once the surface distance to a station drops under `const.maxDockingDistance` (2500 m).

EveJS 0.12.9 hardcodes that autopilot landing to `{ minimumRange: 10000 }` in `Handle_CmdWarpToStuffAutopilot`. Landing 10 km from the gate puts the ship outside the jump bubble, so the autopilot has to burn an extra approach leg before it can jump - the slow part of travelling.

Raising the server's stargate jump range does not help, because the client never reads it. The warp-in distance is the only server-side lever, and this mod changes it.

## What it changes

Exactly one seam, in `server/src/services/ship/beyonceService.js`:

```js
// vanilla 0.12.9
const result = spaceRuntime.warpToEntity(session, targetID, { minimumRange: 10000 });

// with the mod installed
const result = spaceRuntime.warpToEntity(session, targetID, { minimumRange: globalThis[Symbol.for("evejs.betaAutopilotJumpZero")]?.warpInDistanceMeters ?? 0 }); /* beta-autopilotJumpZero: autopilot warp-in distance */
```

Only the autopilot warp is affected. Manual "Warp to", fleet warps, scan-result warps, agent/dungeon warps and every other warp call carry their own explicit range and are left untouched.

With the default of `0`:

- a stargate warp lands on the gate surface, inside the jump bubble the client checks, so `CmdStargateJump` goes out as the warp ends;
- a station or structure warp lands inside docking range, so the autopilot docks on arrival.

## Install

Get this folder into `<EveJS root>\mods\beta-autopilotJumpZero` - clone the repository, copy the
folder, or take `Source code (zip)` from the release you want - and run the installer from inside it.

The folder name matters: the preload points at `mods\beta-autopilotJumpZero`, so a GitHub archive
whose top-level folder is named `EveJS-AutoPilotJumpZero-*` has to be renamed to that.

### Installer (native and Docker)

Run the installer with no arguments and it assumes EveJS is installed on this computer and
finds the root itself. Use `--server "C:\path\to\EveJS"` only to override that search.

```text
installer\install.bat
```

It copies this folder to `<EveJS root>\mods\beta-autopilotJumpZero` and registers the preload in
every deployment it finds:

| Deployment | Registered in | Entry added |
|---|---|---|
| Docker | `docker/entrypoint.sh`, in both `run_server()` and `run_all()` | `--require /app/mods/beta-autopilotJumpZero/loader.js` |
| Native | `StartServer.bat`, whose `NODE_OPTIONS` both `npm start` branches inherit | `NODE_OPTIONS=<existing> --require "…\mods\beta-autopilotJumpZero\loader.js"` (appended) |

Both registrations are idempotent, and every file the installer rewrites is
copied to `<EveJS root>\_beta-autopilotjumpzero-backup\<timestamp>\` first. The
native block **appends** to `NODE_OPTIONS` instead of claiming it, so it composes
with other loader mods; a block left behind by v1.1.1 is upgraded in place by
re-running the installer.

`--docker-only` and `--native-only` restrict it to one deployment, `--dry-run`
reports without writing, and `installer\status.bat` shows what is currently registered.

Afterwards rebuild a Docker deployment, or restart a native one:

```text
Docker : docker compose build && docker compose up -d --no-deps server
Native : restart the server with StartServer.bat
```

### EveJS Launcher (native)

No separate mod ZIP is published - build one from this folder for the launcher:

1. Zip this folder so `beta-autopilotJumpZero\` is the archive root and
   `evejs-launcher.mod.json` sits inside it, beside `loader.js`.
2. Open **Mods** in EveJS Launcher and click **Add ZIP**.
3. Import it and turn on the toggle beside **Autopilot Jump Zero**.
4. Restart Game.

Keep the folder inside the ZIP named `beta-autopilotJumpZero`. The manifest describes
the launcher integration only; Docker is handled by `docker/entrypoint.sh`.

### Manual

1. Copy this folder to `mods/beta-autopilotJumpZero` inside your EveJS install.
2. Preload the loader before any other server module, next to the other `--require` entries:

```text
# Native, run from the server directory
node --require ../mods/beta-autopilotJumpZero/loader.js .

# Native, without editing a vendor file. NODE_OPTIONS is a list, so append to
# it: overwriting it disables every other loader mod you have installed.
# Forward slashes are required - Node's NODE_OPTIONS parser eats backslashes,
# turning C:\a\loader.js into C:aloader.js.
NODE_OPTIONS=<existing> --require <evejs>/mods/beta-autopilotJumpZero/loader.js

# Docker, in docker/entrypoint.sh - both run_server() and run_all()
    --require /app/mods/beta-autopilotJumpZero/loader.js \
```

3. Restart the server. A `[beta-autopilotJumpZero] v1.1.2-beta.1 active — autopilot warp-in distance 0 m` line confirms it.

No client update is required and none is produced.

## Configuration

Copy `.env.example` to `.env` beside `loader.js`, or set real environment variables (a real environment variable wins over the file).

| Setting | Default | Meaning |
|---|---:|---|
| `EVEJS_AUTOPILOT_JUMP_ZERO` | `1` | `0` disables the mod and restores vanilla behaviour. |
| `EVEJS_AUTOPILOT_JUMP_ZERO_WARP_IN_METERS` | `0` | Autopilot warp-in distance in meters, `0` to `1000000`. |
| `EVEJS_AUTOPILOT_JUMP_ZERO_VERBOSE` | `0` | Logs extra hook details. |

The distance is the whole tuning surface:

- `0` lands on the target surface and is the intended setting;
- up to `2500` keeps gate landings inside the client's jump bubble;
- above `2500` pushes gate landings back outside it, restoring the slow retail-style approach (retail sits around 15000), which is useful if you deliberately want the old pacing.

An out-of-range or non-numeric value is rejected at load time and the mod goes inert rather than guessing.

Docker images built from this project exclude dotfiles (`**/.env`, `**/.env.*`), so a `.env` inside the mod folder never reaches the container. Configure a Docker deployment with real environment variables on the `server` service instead:

```yaml
    environment:
      EVEJS_AUTOPILOT_JUMP_ZERO_WARP_IN_METERS: "0"
```

With no environment variable and no readable `.env`, the mod runs on its defaults, which are the intended settings (enabled, 0 m).

## Compatibility and safety

The loader validates the target file before touching it and fails closed: if the autopilot handler anchor, the seam, or the surrounding file shape is missing, duplicated, or already modified, no hooks are installed and the reason is logged.

This includes a server whose own source already carries a config-driven autopilot warp-in distance (for example a hand-applied `{ minimumRange: warpInDistanceMeters }` patch). That seam is reported as owned by another patch and the mod stays inert, so the two never fight.

The mod is inert in worker threads and refuses to install if the target module was already loaded.

Verified against EveJS 0.12.9 (`beyonceService.js`, build shipped with SDE 3396210).

## Verification

```text
RunTests.bat
# or
node test/run.js
```

The suite covers the config surface, the transform, idempotency, the fail-closed paths, the worker-thread guard, and a child-process run that proves the installed hook actually feeds the configured range into the autopilot handler. The development checkout passes 28/28 checks; an installed payload passes 18/18 checks.

In the server log, confirmation is the same: `CmdWarpToStuffAutopilot` is followed within a second by `CmdStargateJump` for the same character, with no `CmdFollowBall` / `CmdSetSpeedFraction` in between.

## Uninstall

1. Stop the server.
2. Run `installer\uninstall.bat --server "<EveJS root>"`, or turn
   the mod off in the launcher, or remove the `--require .../beta-autopilotJumpZero/loader.js`
   entries and the `mods/beta-autopilotJumpZero` folder by hand.
3. Rebuild first if Docker is used, then restart.

No source reversal is required: nothing on disk was modified.
