# Changelog

Autopilot Jump Zero for EveJS 0.12.9. Newest release first.

Every release is a drop-in replacement for the one before it: put the folder at
`mods\autopilotJumpZero` and run `installer\install.bat`. No vendor file is edited on disk, no
game client installs anything, and an existing `.env` is never overwritten.

---

## 1.1.3 - 2026-10-03

**The third installation path is documented, and it says plainly that it is not tested.**

- **The third-party EveJS Launcher is now documented beside the native Windows installer and
  Docker.** `README.md` covers `Mods > Add ZIP` with the release ZIP, enabling the entry, the
  restart of the game server, and how to disable or remove the mod; `HOW-IT-WORKS.md` §8 describes
  what the manifest declares (`kind: "loader"`, `activation.strategy: "loader_rename"`,
  `supportedBackends: ["native", "docker"]`) and that there is no client half and no settings panel.
- **The same honest caveat appears in both documents:** the launcher path is **implemented but has
  not been tested by the authors**, because no EveJS Launcher is available on the machine this mod is
  developed on, so it is unverified and the native or Docker install is the fallback.
- No code, configuration or gameplay changes: the autopilot still warps to the target surface by
  default, and every other warp path is untouched.
- Verified with the development suite at **28/28 PASS**.

---

## 1.1.2 - 2026-09-25

**EveJS 0.12.9 release.**

- Targets EveJS 0.12.9 while keeping the same single in-memory autopilot seam.
- Uses the `autopilotJumpZero` mod identity, API symbol, preload path and backup path.
- No gameplay logic changes from 1.1.1: autopilot still warps to the target surface by default, and every other warp path is untouched.
- Verified with the development suite at **28/28 PASS** and with the installed payload at **18/18 PASS**.
- In-game acceptance on EveJS 0.12.9 confirmed `CmdWarpToStuffAutopilot` followed by `CmdStargateJump`, with no `CmdFollowBall` or `CmdSetSpeedFraction` in between.

---

## 1.1.1 - 2026-09-19

**The autopilot warp lands on its target, and the mod is published as the repository itself -
no packaging step and no distribution archives.**

### The mod

- **The autopilot warp lands on its target** instead of stopping roughly 10 km short, so
  `CmdStargateJump` goes out the moment the warp ends and a station destination docks on
  arrival. Only `Handle_CmdWarpToStuffAutopilot` is changed, and only in memory.
- **One number is the whole tuning surface**: `EVEJS_AUTOPILOT_JUMP_ZERO_WARP_IN_METERS`,
  default `0`, valid `0` to `1000000`. `EVEJS_AUTOPILOT_JUMP_ZERO=0` disables the mod and
  restores vanilla behaviour. An out-of-range or non-numeric value is rejected at load time
  and the mod goes inert rather than guessing.
- **Manual warps, fleet warps, scan-result warps and agent or dungeon warps are untouched.**
  They carry their own explicit range, so the mod changes nothing about them.
- **Fail-closed.** A seam that is missing, duplicated, or already owned by another patch means
  no hook is installed, the reason is logged, and the server keeps vanilla autopilot.

### Changed

- **`dist/` and the packaging step are gone.** `dist/`, `BuildPackage.bat` and
  `tools/build-package.js` were deleted on 2026-09-20: the artifact is the repository's own
  `Source code (zip)` for a tag, because the repository root *is* the mod folder.
- **`ANNOUNCEMENT.md` is merged into `README.md`** as `## At a glance`.
- **The install docs describe a checkout, not an archive.** The folder has to sit at
  `mods\autopilotJumpZero`, and the installer is run from inside it.
- **`LICENSE` (AGPL-3.0) added**, and `.env` is ignored instead of committed; `.env.example`
  stays as the documented template.

### Verification

- `node test/run.js` - **28/28 PASS**: the config surface and its validation, the transform and
  its idempotency, the fail-closed paths, the worker-thread guard, a child-process run that
  proves the hook feeds the configured range into the warp handler, and an install, reinstall
  and uninstall round trip that leaves `server/package.json` byte-identical.
- In game, on a live server: nine consecutive autopilot gate hops, each a clean warp then jump
  (12-28 s per hop, with no approach leg in between).

---
