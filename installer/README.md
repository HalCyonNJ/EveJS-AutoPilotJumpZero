# Autopilot Jump Zero v1.1.1 - Installer

Makes the EveJS autopilot warp to the target itself instead of stopping about
10 km short, so a stargate jump fires the moment the warp ends and a station
destination docks on arrival. No client update is required and the mod never
edits EveJS source on disk - it transforms one file in memory at startup.

The mod itself is in [`autopilotJumpZero/`](autopilotJumpZero/); see its
[README](autopilotJumpZero/README.md) for how the seam works and for the
configuration table.

## Requirements

- EveJS 0.12.8 (native Windows install, or the Docker Compose project).
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
| Native | `StartServer.bat` | `NODE_OPTIONS=<existing> --require "…\mods\autopilotJumpZero\loader.js"` (appended) |

Both registrations are idempotent, so running the installer twice changes
nothing the second time. Every file it is about to rewrite is copied to
`<EveJS root>\_autopilotjumpzero-backup\<timestamp>\` first.

Options:

| Option | Effect |
|---|---|
| `--docker-only` | Register in `docker/entrypoint.sh` only. |
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

## Confirm it loaded

The server prints one line per launch:

```text
[autopilotJumpZero] v1.1.1 active - autopilot warp-in distance 0 m
[autopilotJumpZero] in-memory transform applied: beyonceService autopilot warp-in distance 0 m
```

Inside the container:

```text
docker compose logs server | findstr autopilotJumpZero
```

If instead you see `viability gate failed` or `inert`, the mod refused to touch
a file it did not recognise and the server is running vanilla behaviour. That is
deliberate - it never guesses - and the reason is printed on the next line.

## Configuration

| Setting | Default | Meaning |
|---|---:|---|
| `EVEJS_AUTOPILOT_JUMP_ZERO` | `1` | `0` disables the mod and restores vanilla behaviour. |
| `EVEJS_AUTOPILOT_JUMP_ZERO_WARP_IN_METERS` | `0` | Autopilot warp-in distance, `0` to `1000000`. |
| `EVEJS_AUTOPILOT_JUMP_ZERO_VERBOSE` | `0` | Logs extra hook details. |

- Native: edit `mods\autopilotJumpZero\.env`. A real environment variable wins
  over the file, and the installer never overwrites an existing `.env`.
- Docker: images built from this project exclude dotfiles, so the mod-local
  `.env` never reaches the container. Add the same keys to the `environment:`
  block of the `server` service in `compose.yaml`:

```yaml
    environment:
      EVEJS_AUTOPILOT_JUMP_ZERO_WARP_IN_METERS: "0"
```

The shipped defaults (enabled, 0 m) need no configuration in either deployment.

## Uninstall

```text
uninstall.bat --server "C:\path\to\EveJS"
```

This removes exactly the two `--require` entries the installer added - so it
never undoes a mod that registered itself later - archives the mod folder under
`_autopilotjumpzero-backup\`, and leaves the rest of the checkout untouched.
Add `--keep-files` to unregister the preload but keep the folder, or
`--dry-run` to see what would happen.

Then rebuild and restart:

```text
Docker : docker compose build && docker compose up -d --no-deps server
Native : restart the server
```

The autopilot returns to warping 10 km short and approaching the gate.

## Verifying the mod itself

```text
autopilotJumpZero\RunTests.bat
```

runs the mod's own suite (config, transform, fail-closed paths, installer
transform round-trips, and an end-to-end install/reinstall/uninstall against a
throwaway EveJS tree).