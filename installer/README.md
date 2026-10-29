# Autopilot Jump Zero v1.2.1 - Installer

Makes the EveJS autopilot warp to the target itself instead of stopping about
10 km short, so a stargate jump fires the moment the warp ends and a station
destination docks on arrival. The landing is also sized to the hull, so a
carrier or a titan no longer lands inside a stargate. No client update is
required and the mod never edits EveJS source on disk - it transforms two files
in memory at startup.

This installer lives inside the mod folder, beside `loader.js`. The mod itself
is the folder above; its [README](../README.md) covers the seam and the
configuration table, and [HOW-IT-WORKS.md](../HOW-IT-WORKS.md) has the full
mechanism.

## Requirements

- EveJS 261018.1 (native Windows install, or the Docker Compose project).
- Node.js 18 or newer on `PATH` to run the installer.

## Install

```text
install.bat --server "C:\path\to\EveJS"
```

`--server` may be omitted: the installer then looks for an EveJS root next to
itself, in the current directory, and one level up, and asks which one to use
when several are found.

The installer always copies the mod to `<EveJS root>\mods\autopilotJumpZero`,
and then registers the preload in every deployment it finds:

| Deployment | Registered in | Entry added |
|---|---|---|
| Docker | `docker/entrypoint.sh` | `--require /app/mods/autopilotJumpZero/loader.js` |
| Docker build context | `.dockerignore` | `!mods/` and `!mods/**`, because 261018.1's allowlist does not mention `mods/` |
| Native | `StartServer.bat` | `NODE_OPTIONS=<existing> --require "…\mods\autopilotJumpZero\loader.js"` (appended) |

Both registrations are idempotent, so running the installer twice changes
nothing the second time. Every file it is about to rewrite is copied to
`<EveJS root>\_autopilotjumpzero-backup\<timestamp>\` first. The `.dockerignore`
lines stay in place if the mod is uninstalled later - another loader mod may
still depend on them.

Options:

| Option | Effect |
|---|---|
| `--docker-only` | Register in `docker/entrypoint.sh` and patch `.dockerignore` only. |
| `--native-only` | Register in `StartServer.bat` only. |
| `--dry-run` | Report what would change without writing anything. |
| `--force` | Replace an existing `mods\autopilotJumpZero` without archiving it. |
| `--status` | Report what is currently installed and registered. |

### Native registration

`StartServer.bat` is patched, not `server/package.json`. The launcher resolves
its own root, and the injected block sits before the point where both branches
reach `npm start`, so "server only" and "server + play" both inherit it:

```bat
rem --- autopilotJumpZero: preload the server-side loader ---
if exist "%EVEJS_REPO_ROOT%\mods\autopilotJumpZero\loader.js" (
  if defined NODE_OPTIONS (
    set "NODE_OPTIONS=%NODE_OPTIONS% --require="%EVEJS_REPO_ROOT:\=/%/mods/autopilotJumpZero/loader.js""
  ) else (
    set "NODE_OPTIONS=--require="%EVEJS_REPO_ROOT:\=/%/mods/autopilotJumpZero/loader.js""
  )
)
rem --- autopilotJumpZero: end autopilotJumpZero preload ---
```

Three details here are deliberate:

- **`server/package.json` is left alone.** It is an input to the Docker image's
  dependency layer, so editing it forces the next `docker compose build` to
  re-run `npm ci`. Where better-sqlite3 cannot download its prebuilt binary,
  `npm ci` compiles it from source instead, and that source build aborts on
  Node 24 (`RemoveEnvironmentCleanupHook` assertion) - one install took a live
  server into a restart loop that way. `StartServer.bat` is not part of the
  Docker build context, so this registration cannot affect an image build.
- **The `NODE_OPTIONS` value uses forward slashes.** Node's `NODE_OPTIONS`
  parser treats backslashes as escapes, so `--require="C:\path\loader.js"`
  quietly becomes `C:pathloader.js`. The `if exist` test still uses native
  separators.

- **The block appends instead of claiming the variable.** `NODE_OPTIONS` is a
  list and another loader mod may already own it, so the value is written as
  `%NODE_OPTIONS% --require=...` and assigned outright only while the variable is
  still empty. Two simpler forms are both wrong: assigning drops whatever was
  there, and `if not defined NODE_OPTIONS set "..."` drops whichever mod
  registers second - and since a later install is inserted above an earlier one,
  "second" is the mod that was already installed. v1.1.1 shipped that guard form,
  so installing any other loader mod afterwards silenced this one. A block left
  by v1.1.1 is rewritten in place when you re-run the installer, and `--status`
  reports it as `registered (legacy form)` until then.

An `NODE_OPTIONS` you set yourself is respected, and the block does nothing if
the loader is not where it expects to be. Starting the server some other way
still works by hand - see the `NODE_OPTIONS` line in the mod README.

### Docker registration

`docker/entrypoint.sh` contains two server launches, `run_server()` (used by
this project's `compose.yaml`, which runs the server as its own service) and
`run_all()` (used when one container runs the market and the server together,
the image's default `CMD`). The installer adds the preload to both.

`mods\` is baked into the image, so a rebuild is required:

```text
docker compose build
docker compose up -d --no-deps server
```

The same step also adds `!mods/` and `!mods/**` to `.dockerignore`. EveJS 261018.1
builds its `.dockerignore` as `**` plus an allowlist that does not mention
`mods/`, and the image is built with `COPY . .`; without those two lines the
payload never reaches `/app/mods`, and the preload fails at startup with
`Cannot find module`. The lines are added once, before the `**/node_modules`
block, and are left in place if the mod is uninstalled later.

## Confirm it loaded

The server prints one line per launch:

```text
[autopilotJumpZero] v1.2.1 active - autopilot warp-in distance 0 m, stargate surface clearance up to 500 m
[autopilotJumpZero] in-memory transform applied: beyonceService autopilot warp-in distance 0 m
[autopilotJumpZero] in-memory transform applied: stargate landing geometry, up to 500 m surface clearance
```

Inside the container:

```text
docker compose logs server | findstr autopilotJumpZero
```

If instead you see `viability gate failed` or `inert`, the mod refused to touch
a file it did not recognise and the server is running vanilla behaviour. That is
deliberate - it never guesses - and the reason is printed on the next line.

## Configuration

There is no configuration file and nothing is seeded. The autopilot distance is fixed at `0`; the only
value worth touching is the stargate clearance, and it is an environment variable:

| Setting | Default | Meaning |
|---|---:|---|
| `EVEJS_AUTOPILOT_JUMP_ZERO` | `1` | `0` disables the mod and restores vanilla behaviour. |
| `EVEJS_AUTOPILOT_JUMP_ZERO_SURFACE_CLEARANCE_METERS` | `500` | Stargate surface clearance, `0` to `2000`, capped at the ship's radius. |
| `EVEJS_AUTOPILOT_JUMP_ZERO_VERBOSE` | `0` | Logs extra hook details. |

Docker deployments set it on the `server` service:

```yaml
    environment:
      EVEJS_AUTOPILOT_JUMP_ZERO_SURFACE_CLEARANCE_METERS: "500"
```

The shipped defaults (enabled, `0` m distance, `500` m clearance) need no configuration in either deployment.

## Uninstall

```text
uninstall.bat --server "C:\path\to\EveJS"
```

This removes exactly the `--require` entries the installer added - so it never
undoes a mod that registered itself later - archives the mod folder under
`_autopilotjumpzero-backup\`, and leaves the rest of the checkout untouched. The
`!mods/` / `!mods/**` lines in `.dockerignore` are deliberately kept, because
another loader mod may still need them. Add `--keep-files` to unregister the
preload but keep the folder, or `--dry-run` to see what would happen.

Then rebuild and restart:

```text
Docker : docker compose build && docker compose up -d --no-deps server
Native : restart the server
```

The autopilot returns to warping 10 km short and approaching the gate.

## Verifying the mod itself

```text
..\RunTests.bat
```

runs the mod's own suite (config, transform, fail-closed paths, installer
transform round-trips, and an end-to-end install/reinstall/uninstall against a
throwaway EveJS tree).