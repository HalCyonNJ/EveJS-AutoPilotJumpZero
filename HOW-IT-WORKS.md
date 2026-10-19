# How Autopilot Jump Zero works

> **Who this is for.** Humans who want to know what this mod actually does before
> they run it, and AI agents that have to reason about, port, or modify it later.
> Everything below is checkable against the source in this folder: file names,
> function names and the exact strings the mod matches on are all quoted, so a
> reader can jump straight to the code.

**Target:** EveJS 261018.1 (`beyonceService.js` and `warpTargets.js`, build shipped with SDE 3396210)
**Mod version:** 1.2.0 · **Manifest kind:** `loader` · **Backends:** native and Docker (both registered by the installer, see §8)
**Runtime requirement:** Node.js 18+ (the installer needs it on `PATH` too)

---

## 0. The short version

The EveJS server decides where an autopilot warp ends, and it hardcodes that
landing point to **10,000 m** from the target. The game client only starts a
stargate jump once the ship is within about **2,500 m** of the gate, so every
autopilot hop carries an extra ~7.5 km crawl at sub-warp speed before the jump
finally fires. That crawl - not the warp itself - is what makes autopilot travel
feel slow.

This mod rewrites that one number to **0**, *in memory, while the server is
starting*. Autopilot warps then land on the target: a stargate jump goes out the
moment the warp ends, and a station destination docks on arrival. It also makes
the stargate exit point recognise the ship's own size, because "on the gate" as
the server computes it means the hull's **centre** on the gate's surface - fine
for a frigate, a collision bounce for a titan.

- No file on disk is modified - not EveJS, not the mod's own copy of it.
- No game client change - **there is nothing to install on the game client**.
- One optional setting and no configuration file, and it fails closed rather than guessing (§5).

---

## 1. The problem, precisely

### 1.1 Client and server split the work

The retail client autopilot (`eve/client/script/parklife/autopilot.py`) does two
independent things:

1. **It asks for a warp with no range.** It calls
   `michelle.GetRemotePark().CmdWarpToStuffAutopilot(destinationID)` - just a
   target ID. It never says how close it wants to land, so the landing point is
   entirely the server's decision.
2. **It decides on its own when to jump or dock.** Once the *surface* distance
   from the ship to the target drops far enough, the autopilot issues its own
   `CmdStargateJump` (gate) or `CmdDock` (station). Those thresholds are client
   constants - roughly 2.5 km for a gate and 50 km for a station - and the
   server does not read them.

Because of (1), the effective autopilot range is 100% server-side. Because of
(2), the server cannot fix the pacing by making the jump range larger: the client
never asks the server whether it is allowed to jump.

### 1.2 Why raising the stargate jump range does nothing

A natural first idea is to increase the server's stargate jump range so that a
ship sitting 10 km away counts as "at the gate". That changes nothing, because
the client's jump decision does not consult any server-side range - it compares
its own surface distance against its own constant. The ship still has to close to
~2,500 m, and closing that gap is exactly the slow part.

The **warp-in distance** is therefore the only server-side lever over autopilot
travel time. This mod pulls that lever.

### 1.3 What the vanilla server does

`server/src/services/ship/beyonceService.js`, abridged (comments added):

```js
  Handle_CmdWarpToStuffAutopilot(args, session) {
    const targetID = normalizeNumber(args && args[0], 0);
    log.info(
      `[Beyonce] CmdWarpToStuffAutopilot char=${session && session.characterID} target=${targetID}`,
    );
    const activeAbyssalRun = getActiveAbyssalRunForSession(session);
    if (activeAbyssalRun) {
      // ...abyssal runs cannot warp out...
      throwAbyssalWarpBlockedError();
    }
    // <<< the seam: the warp-in distance for autopilot travel
    const result = spaceRuntime.warpToEntity(session, targetID, { minimumRange: 10000 });
    if (!result || !result.success) {
      // ...log + throw a user-facing error...
    }
    return null;
  }
```

`10000` is a literal. There is no config key, no environment variable and no
server-side constant for it anywhere else in 261018.1 - this call site is the whole story.

### 1.4 The consequence in game

| Leg | Vanilla 261018.1 | With this mod (default `0`, clearance `500`) |
|---|---|---|
| Warp to gate | warp ends 10,000 m from the gate | warp ends just outside the gate - the hull's radius plus the clearance |
| Approach leg | ~7,500 m at sub-warp speed | none for a frigate; none to a short hop for a capital |
| Jump | after the approach leg | as the warp ends |
| Warp to station | warp ends 10,000 m out, then an approach, then dock | warp ends inside docking range, docks on arrival |

---

## 2. The change

### 2.1 The first seam: the autopilot landing

Exactly one line changes in that handler, in `server/src/services/ship/beyonceService.js`:

```js
// vanilla 261018.1
const result = spaceRuntime.warpToEntity(session, targetID, { minimumRange: 10000 });

// as seen by the running server with this mod installed (one source line)
const result = spaceRuntime.warpToEntity(session, targetID, { minimumRange: globalThis[Symbol.for("evejs.autopilotJumpZero")]?.warpInDistanceMeters ?? 0 }); /* autopilotJumpZero: autopilot warp-in distance */
```

That is the autopilot half of the change. It moves the landing in; it does not say
anything about the *shape* of the ship that lands, which is what the second seam is
for.

### 2.1.1 The second seam: the stargate landing geometry

One more line changes, in `server/src/space/destiny/simulation/warpTargets.js`, inside
`getStargateWarpExitEnvelopePoint` - the single function that turns "warp to a stargate"
into an exit point:

```js
// vanilla 261018.1
scaleVector(fromGateToShip, gateRadius + explicitSurfaceRange),

// with the mod installed
scaleVector(fromGateToShip, gateRadius + explicitSurfaceRange + (globalThis[Symbol.for("evejs.autopilotJumpZero")]?.stargateSurfaceOffset?.(entity) ?? 0)), /* autopilotJumpZero: stargate surface offset */
```

**Why it is needed.** Vanilla computes the exit distance from the gate alone. With the
autopilot distance at `0` the requested surface range is `0`, so the exit point is
exactly `gateRadius` from the gate's centre: the hull's *centre* lands on the gate's
surface. The surface distance the client uses is `centre - gateRadius - shipRadius`,
which is therefore **negative by the ship's own radius** - the hull is inside the gate:

| Ship | radius | vanilla surface distance | with the mod (clearance 500) |
|---|---:|---:|---:|
| frigate (Rifter) | 31 m | -31 m | 31 m |
| battleship (Raven) | 250 m | -250 m | 250 m |
| carrier (Archon) | 1,643 m | -1,643 m | 500 m |
| supercarrier (Nyx) | 3,820 m | -3,820 m | 500 m |
| titan (Erebus) | 7,500 m | -7,500 m | 500 m |

A frigate's 31 m of overlap is invisible; a carrier's 1.6 km and a titan's 7.5 km are not -
the client resolves the overlap by throwing the ship clear. That is the "bounced by the
gate" report, and it is a geometry bug the autopilot distance alone cannot fix: a value
at or below 2500 that would express "half a kilometre of clearance" is ignored by vanilla
(`explicitSurfaceRange` only applies above 2500), and any value above 2500 that is small
enough to keep the landing inside the client's jump bubble still has to be larger than
the ship.

**What the mod adds.** `stargateSurfaceOffset(entity)` returns
`shipRadius + min(surfaceClearanceMeters, shipRadius)`: the hull's radius, so the centre
is never inside the gate, plus a clearance that never exceeds the hull itself. A frigate
therefore keeps a landing 31 m out, while a carrier or a titan gets the configured 500 m
on top of its own radius. The result leaves the landing inside the client's 2500 m jump
bubble (the vendor adds a random 0-2500 m scatter on top, so a minority of landings end
just outside it and cost a short approach).

This seam is *not* autopilot-only: every warp to a stargate uses this function, manual
ones included, and every one of them becomes correct for large hulls. Warps to stations,
structures, planets, belts and everything else take a different branch and are untouched.

### 2.2 A literal `0` for the distance, a `globalThis[Symbol.for(...)]` lookup for the clearance

The two seams differ on purpose. The autopilot distance has no reason to be tunable any
more - the hull-sized geometry owns the landing - so it is compiled in as a literal `0`.
The clearance *is* tunable, so its line reads the running value:

- **The clearance stays configurable at runtime** without re-transforming anything:
  the running line reads whatever the loader published at startup, so it can be
  retuned (§6) without touching the transform.
- **`Symbol.for("evejs.autopilotJumpZero")` is a registry symbol**, so any other
  server-side code can find the mod's API without `require`-ing the mod or
  depending on its path - and the mod can be dropped into any load order.
- **`?? 0` is a fail-safe default, not an accident.** If the API is missing (for
  example someone applies this transform to a file but forgets the preload), the
  envelope falls back to the vanilla distance and only the radius is added, instead
  of throwing inside a warp. The mod never writes that transformed text to disk
  anyway; it only ever exists in the compiled module.

### 2.3 The marker comments

Each transformed line ends with its own marker:

```js
/* autopilotJumpZero: autopilot warp-in distance */
/* autopilotJumpZero: stargate surface offset */
```

A marker is how the mod recognises **its own** work later (§4.2): a file that
already carries it is reported as `installed` and left alone (idempotency), and a
marker found anywhere outside its owned scope aborts that transform instead of
being silently duplicated.

---

## 3. How the mod gets loaded

The loader is a single Node module, `loader.js`, preloaded with `--require`
before the server's own entry point. Nothing is copied into the server tree and
no `require` inside EveJS is edited.

### 3.1 Step 0 - the preload

```text
# Docker (docker/entrypoint.sh, both run_server() and run_all())
    --require /app/mods/autopilotJumpZero/loader.js \

# Native (StartServer.bat, once the installer has added its preload block)
# appended to the list, keeping whatever another loader mod put there
NODE_OPTIONS=<existing> --require "<root>/mods/autopilotJumpZero/loader.js"

# Native, manual
node --require ../mods/autopilotJumpZero/loader.js .
```

`loader.js` computes the EveJS root from its own location:

```js
const MOD_DIR = __dirname;                              // .../mods/autopilotJumpZero
const RUNTIME_ROOT = path.resolve(MOD_DIR, "../..");    // the EveJS root
```

So the mod must live at `<EveJS root>/mods/autopilotJumpZero/`. That is the only
installation requirement.

### 3.2 Step 1 - gates before anything is installed

`install()` runs immediately as the preload executes, and refuses in order:

| Gate | Condition | Result |
|---|---|---|
| Worker threads | `isMainThread === false` | inert, reason `worker-thread` |
| Double install | `globalThis.__autopilotJumpZeroLoaderInstalled` already set | inert, reason `already-installed` |
| Disabled | `EVEJS_AUTOPILOT_JUMP_ZERO=0` | inert, logs "mod disabled", vanilla behaviour |
| Bad config | any value fails validation | **no hook installed**, each problem logged |
| Viability | either target file is not the expected shape | **no hook installed**, each failing check logged |

Every one of these is "leave the server alone", never "try anyway".

### 3.3 Step 2 - hook `Module._load`

If all gates pass, the loader wraps Node's module loader:

```js
Module._load = hookedLoad;   // previousLoad kept for pass-through and rollback
```

`hookedLoad` is intentionally cheap because it sees **every** `require()` in the
server:

1. `Module.isBuiltin(request)` → straight through (never touches `node:` internals).
2. Resolve the request with Node's own parent-aware resolver,
   `Module._resolveFilename(request, parent, isMain)`; if it throws, pass through.
3. Canonicalise the resolved filename (see §3.4) and look it up in a `Map` that
   only contains the mod's owned targets. A miss - i.e. essentially every call -
   passes straight through.
4. A hit is transformed and compiled, and the resulting `exports` are cached in
   `loadedTargets` so repeat requires are a `Map.get`.

### 3.4 Step 3 - path identity, not string matching

Matching a file by "does the path end with `beyonceService.js`" is unsafe (a
different file could share the basename, and on Windows the same file can be
spelled many ways). Instead the loader builds its target map from real filesystem
identities:

```js
const TARGETS = Object.freeze({
  beyonceService: "server/src/services/ship/beyonceService.js",
  warpTargets: "server/src/space/destiny/simulation/warpTargets.js",
});
```

Each target is resolved against `RUNTIME_ROOT`, run through `fs.realpathSync`
(symlinks resolved), normalised and - on Windows - lower-cased with `/` folded
to `\`. Resolution results are memoised, but **only successful realpath calls are
cached**, so a path that does not exist yet can still become a match later.

### 3.5 Step 4 - transform and compile in memory

When the server eventually requires the target, the loader:

1. reads the file with `fs.readFileSync(filename, "utf8")`,
2. runs it through `transformSource()` (§4) - which throws on anything unexpected,
3. compiles the transformed text with `new Module(...)` + `compiled._compile(...)`,
4. installs it into `Module._cache[filename]` and marks it loaded.

The file on disk is never written to. If compilation throws, the cache entry is
deleted and the loader raises, so the server sees a hard failure instead of a
half-transformed module.

Two extra guards protect against ordering hazards:

- **`transforming` recursion set**: a transform that re-enters the loader for its
  own target returns the partially-built module's exports rather than recursing.
- **Pre-cached target check**: if the target module was *already* in
  `Module._cache` before the hook was installed, the loader refuses to install at
  all (`required target already cached before hook installation`). Silently
  mis-patching an already-loaded module would be worse than not installing.

### 3.6 Step 5 - publish the API

```js
globalThis[Symbol.for("evejs.autopilotJumpZero")] = Object.freeze({
  version: "1.2.0",
  warpInDistanceMeters: 0,     // the configured autopilot distance
  surfaceClearanceMeters: 500, // the configured stargate clearance
  stargateSurfaceOffset,       // (entity) => hull radius + capped clearance
  config,                      // the full resolved config, frozen
});
```

If anything later in `install()` throws, the loader rolls back: it restores the
original `Module._load`, deletes the symbol and clears the install flag, then
logs `loader failed before activation`. A failed load can never leave a
half-installed hook behind.

---

## 4. The transform algorithm

`lib/sourceTransforms.js` owns both edits. It never uses a whole-file regex
replace; each seam is found through its own owning function and counted.

### 4.1 Finding the owned scope, twice

```js
const HANDLER_ANCHOR = "  Handle_CmdWarpToStuffAutopilot(args, session) {";
const ENVELOPE_ANCHOR = "  function getStargateWarpExitEnvelopePoint(";
```

Each anchor must appear **exactly once** in its file. From the anchor, the
transform takes everything up to the next `"\n  }"` - which is the closing brace
of that function, because the service member and the factory-local function are
both indented by two spaces. That gives the only region the transform is allowed
to touch: one in each file.

### 4.2 The four recognised states, per seam

Inside a scope the transform counts three tokens:

| Seam | Vanilla token | Owned token | Foreign token |
|---|---|---|---|
| autopilot landing | `spaceRuntime.warpToEntity(session, targetID, { minimumRange: 10000 })` | the rewritten line including its marker | `minimumRange: warpInDistanceMeters` |
| stargate envelope | `scaleVector(fromGateToShip, gateRadius + explicitSurfaceRange),` | the rewritten line including its marker | `const shipRadius` inside the function |

and derives a state per seam:

| State | Condition | Action |
|---|---|---|
| `vanilla` | vanilla token ×1, owned token ×0, marker ×0 | **replace** the seam |
| `installed` | vanilla ×0, owned ×1, marker ×1 | leave it, report `alreadyInstalled` |
| `foreign` | vanilla ×0, owned ×0, and the foreign token present | **abort** |
| `missing` | anything else (0 or >1 of a token, marker outside the scope, no closing brace, no anchor) | **abort** |

`foreign` is what makes this mod a good citizen: a server that already carries a
hand-applied config-driven warp-in patch, or one whose envelope already adds the
ship radius, is detected and left alone rather than patched twice.

### 4.3 Invariants the transform enforces

- **Exactly one** anchor, **exactly one** seam and **exactly one** marker **per owned function**.
- A marker may not appear outside its owned scope.
- **The line count must not change** (`transformSource` compares before/after and
  fails if it does) - so an edit that accidentally swallows or duplicates a line
  is rejected even if the token counts worked out.
- Only the two-space-indented function that follows the anchor is rewritten; the
  rest of the file is copied through byte for byte.

---

## 5. Failing closed: the viability gate

Before installing any hook, `lib/viability.js` independently probes **both** files
for shape - deliberately using anchors that the transforms themselves do not
consume, so the two checks cannot both be satisfied by the same accident:

```js
const SOURCE_REQUIREMENTS = [{
  key: "beyonceServiceShape",
  file: "server/src/services/ship/beyonceService.js",
  required: [
    "  Handle_CmdWarpToStuffAutopilot(args, session) {",
    "  Handle_CmdDock(args, session) {",
    "[Beyonce] CmdWarpToStuffAutopilot char=",
  ],
}, {
  key: "warpTargetsShape",
  file: "server/src/space/destiny/simulation/warpTargets.js",
  required: [
    "  function getStargateWarpExitEnvelopePoint(",
    "function resolveStargateWarpTarget(",
  ],
}];
```

Each token must appear exactly once. If not - wrong EveJS version, a modified or
renamed function, a file that is not what it claims to be - the gate fails, the
mod logs `viability gate failed - no hooks installed` plus the reason, and the
server keeps running with vanilla autopilot. **The mod never guesses and never
partially applies.**

---

## 6. Configuration

There is **no configuration file** and no file source: `config.js` reads environment
variables and nothing else. The autopilot distance is fixed at `0` by the transform, so
the only tunable value is the stargate clearance.

| Key | Default | Range / values | Effect |
|---|---|---|---|
| `EVEJS_AUTOPILOT_JUMP_ZERO` | `1` | boolean-ish (`1/true/yes/on/enabled`, `0/false/no/off/disabled`) | `0` = mod inert, vanilla behaviour |
| `EVEJS_AUTOPILOT_JUMP_ZERO_SURFACE_CLEARANCE_METERS` | `500` | finite number, `0` .. `2000` | stargate surface clearance, capped at the ship's own radius |
| `EVEJS_AUTOPILOT_JUMP_ZERO_VERBOSE` | `0` | boolean-ish | extra hook-detail logging |

The clearance only shapes a stargate landing, and only for hulls big enough to use it:

| Value | Behaviour |
|---|---|
| `0` | the hull's radius alone - the centre never enters the gate, but the hull exactly touches its surface |
| `500` (default) | up to 500 m of gap on top of the hull's radius; a frigate gains 31 m, a battleship 250 m, a carrier or titan 500 m |
| above `500` | safer still, but more landings fall outside the client's jump bubble and cost a short approach |

The clearance is capped at the ship's own radius, so the smallest hulls keep the landing
they had before this setting existed. It cannot be expressed through the warp range at
all: vanilla ignores any requested surface range at or below 2500, which is exactly why
the geometry had to be transformed instead.

An out-of-range or non-numeric value is **rejected at load time**: the mod logs
the problem and goes inert. It does not clamp, and it does not guess.

**Docker note.** Set the variables on the `server` service in `compose.yaml`; there is no
file to ship, and an old `.env` beside `loader.js` would not reach a container anyway
(the project's `.dockerignore` excludes `**/.env`):

```yaml
    environment:
      EVEJS_AUTOPILOT_JUMP_ZERO_SURFACE_CLEARANCE_METERS: "500"
```

---

## 7. Runtime picture

```mermaid
flowchart LR
  A["Client autopilot<br/><i>parklife/autopilot.py</i>"] -->|"CmdWarpToStuffAutopilot(destID)<br/>no range given"| B["Server<br/><i>beyonceService</i> Handle_CmdWarpToStuffAutopilot"]
  B --> C["spaceRuntime.warpToEntity(<br/>session, targetID,<br/>{ minimumRange: X })"]
  C --> D["Ship lands X metres from the target surface"]
  D --> E{"Client re-checks its own<br/>surface distance each tick"}
  E -->|"under ~2500 m, target is a gate"| F["CmdStargateJump"]
  E -->|"under ~50 km, target is a station"| G["CmdDock"]
  E -->|"still too far"| H["Approach leg at sub-warp speed<br/>(the slow part)"]
```

`X` = `10000` in vanilla 261018.1, `0` with this mod. The mod only moves `X`; every
arrow to its right is the game's own behaviour and is left alone. When the target is a
stargate, the exit point itself is produced by `getStargateWarpExitEnvelopePoint`, which is
where the second seam adds the ship's radius and the clearance (section 2.1.1).

In one sentence: *the client asks for a warp without a range, the server picks
the range, and this mod makes the server pick zero - and makes the stargate landing
point account for how big the ship is.*

---

## 8. Registration, per deployment

The mod is a preload, so it has to be registered once per launch path. The
installer (`installer/install.bat` → `installer/install.js`) covers every supported
path idempotently.

| Deployment | File | Entry added | Rebuild needed? |
|---|---|---|---|
| Docker, separate server service (Docker Compose project) | `docker/entrypoint.sh`, `run_server()` | `--require /app/mods/autopilotJumpZero/loader.js` | yes - `mods/` is baked into the image |
| Docker, single-container "all" mode (the image's default `CMD ["all"]`) | `docker/entrypoint.sh`, `run_all()` | same | yes |
| Docker build context | `.dockerignore` | `!mods/` and `!mods/**` (261018.1 starts from `**` and does not list `mods/`; without them `COPY . .` never brings the payload into the image, and the preload above then dies with `Cannot find module`) | yes |
| Native Windows | `StartServer.bat`, once the installer adds the block (this checkout's launcher has none) | `NODE_OPTIONS=<existing> --require "<root>/mods/autopilotJumpZero/loader.js"` (appended) | no |
| EveJS Launcher (third-party) | `Mods > Add ZIP` in the launcher, then its mod list | enable the entry `evejs-launcher.mod.json` declares (`kind: "loader"`, `activation.strategy: "loader_rename"`) | Docker yes, native no |

That last row is a **manifest** registration rather than a file the installer edits.
`evejs-launcher.mod.json` declares `schemaVersion: 3`, `"kind": "loader"`,
`"activation": { "strategy": "loader_rename" }`, `supportedBackends: ["native", "docker"]`,
`compatibility.evejsVersions: ["261018.1"]` and `restart: "game_server"`; the launcher enables
the entry by renaming the loader payload rather than by patching anything, which is all this
mod needs because it is server-side only - there is no client component, no login handshake
and no vendor file to patch. The manifest declares no `settings` block, so the launcher's
Configure panel has nothing to offer this mod. **The launcher path is implemented but
untested by us**: no EveJS Launcher exists on the machine this mod is developed on, so treat
it as unverified and fall back to the native or Docker install if anything looks wrong.

Three deliberate implementation details, all learned the hard way:

- **`server/package.json` is not touched.** It is an input to the Docker image's
  dependency layer (`COPY server/package.json server/package-lock.json ./` +
  `npm ci`), so any byte change there forces `npm ci` to re-run on the next image
  build. Where better-sqlite3 cannot download its prebuilt binary, `npm ci`
  compiles it from source instead, and that source build aborts on Node 24 - an
  install done that way once took a live server into a `restart: always` crash
  loop. `StartServer.bat` is not in the Docker build context at all, so
  registering there cannot affect any image build.
- **`NODE_OPTIONS` needs forward slashes.** Node's `NODE_OPTIONS` parser treats
  backslashes as escapes, so `--require="C:\path\loader.js"` silently becomes
  `C:pathloader.js`. The injected block converts with
  `%EVEJS_REPO_ROOT:\=/%` while the `if exist` guard keeps native separators, and
  the block does nothing at all if the loader is not where it expects to be.
- **The block appends to `NODE_OPTIONS`; it never claims it.** `NODE_OPTIONS` is
  a list, and another loader mod may already own it, so the block writes
  `%NODE_OPTIONS% --require=...` and assigns outright only while the variable is
  still empty. The two simpler forms are both wrong: `set "NODE_OPTIONS=..."`
  drops whatever was there, and `if not defined NODE_OPTIONS set "..."` reads
  like a guard but is not one - later installs are inserted *above* earlier ones,
  so a neighbour that lands ahead of the block claims the variable first and this
  mod is then skipped without a word. v1.1.1 shipped that guard, and installing
  any other loader mod afterwards did exactly that: this mod went silent while the
  server kept running. `--require` order is hook order, and this loader replaces
  its target module instead of wrapping it, so the block also has to stay at the
  head of the preload group - innermost - where a wrapping neighbour loaded later
  still sees the exports this transform produced. Appending is what makes that
  position safe.

Uninstall is the mirror image: `installer/uninstall.bat` removes **exactly** the entries
the installer added (never a whole-file restore, so it cannot undo a mod that
registered itself later), archives the mod folder to
`<root>/_autopilotjumpzero-backup/<timestamp>/`, and leaves the rest of the
checkout alone. `--keep-files` unregisters without deleting the folder.

---

## 9. What is verified

`RunTests.bat` (or `node test/run.js`) runs the mechanical suite. The development
checkout has 36 checks, all passing on Node 24, grouped as:

| Group | Covers |
|---|---|
| config (6) | defaults, environment overrides, rejection of a non-numeric / out-of-range clearance, disabling, the hull-offset arithmetic, and that no configuration file ships or is read |
| manifest (1) | `evejs-launcher.mod.json` version and `compatibility` match the loader |
| transform (10) | both seams rewritten in place; both idempotent; fail-closed on a missing anchor, on a duplicated seam and on a seam owned by another patch (for the autopilot seam *and* the stargate envelope); unrelated files are left alone; the envelope's arithmetic against a live-shaped file |
| viability (1) | a tree without the autopilot handler is rejected |
| loader guards (1) | the loader stays inert in worker threads |
| child process (2) | the installed hook drives the handler to `0 m` and feeds the hull offset into the envelope - i.e. both behaviours really arrive, end to end |
| live tree (1) | a real EveJS checkout still reports a recognised seam state for both files |
| installer (14) | Docker preload insertion, idempotency and removal; `.dockerignore` allowlist insertion, idempotency and the no-allowlist case; refusal when no launch path exists; native preload insertion, legacy upgrade, damaged-block refusal and composition with another loader mod; an end-to-end install → reinstall → uninstall round trip that leaves `server/package.json` byte-identical; and live-tree launch probes |

In game on 0.12.9 (the earlier release line) the verification run showed
`CmdWarpToStuffAutopilot` followed by `CmdStargateJump` for the same character,
with no `CmdFollowBall` or `CmdSetSpeedFraction` in between.

On **261018.1** the same arrival behaviour was accepted in game on the live
server with a **titan** and a **freighter**: both autopilot jumps fire as the
warp ends and the hull is no longer thrown clear by the stargate's collision
volume. That is the acceptance this release was waiting for; the mechanical
suite and the live-file probes above are what guard it in a checkout.

---

## 10. What the mod deliberately does not do

- **It does not touch the autopilot range of any warp call except `Handle_CmdWarpToStuffAutopilot`.** `Warp to`,
  `Warp to within`, fleet warps, scan-result warps, mission/agent warps, abyssal
  warps - every other warp call site carries its own explicit range and is not
  transformed.
- **It does correct the stargate landing geometry for every warp**, manual ones included:
  without the ship radius the exit point is measured from the gate alone, which is what puts a
  capital hull inside the gate. This is a fix to a place every warp shares, not a new range for
  them - a manual "Warp to 10 km" still lands 10 km out, it just no longer buries the hull.
- **It does not change stargate jump range, aggro, or docking rules.** It only
  changes where a warp stops and how far outside the gate that point is.
- **It does not write to disk.** No vendor file, no lock file, no generated
  source. Uninstall is removal of the registration, not a revert.
- **It does not ship or require anything on the client side.** There is nothing
  for a game client to install.
- **It does not disable itself for the faster docking.** Docking on arrival is a
  consequence of the same seam, not a separate feature.

---

## 11. Tuning, disabling, uninstalling

```text
# give capitals more room at a gate (0-2000; capped at the ship's radius)
# native: set it in the environment StartServer.bat runs in, then restart
EVEJS_AUTOPILOT_JUMP_ZERO_SURFACE_CLEARANCE_METERS=1000

# turn the mod off entirely, keeping it installed
EVEJS_AUTOPILOT_JUMP_ZERO=0

# remove it
installer\uninstall.bat --server "<EveJS root>"   # then rebuild Docker, restart native
```

Docker deployments set the same variables on the `server` service, then run
`docker compose up -d --no-deps server` - no image rebuild is needed to change a
*value*, only to add or remove the *mod*.

---

## 12. Troubleshooting: reading the log

| Log line | Meaning |
|---|---|
| `[autopilotJumpZero] v1.2.0 active - autopilot warp-in distance 0 m, stargate surface clearance up to 500 m` | installed and enabled |
| `[autopilotJumpZero] in-memory transform applied: beyonceService autopilot warp-in distance 0 m` | the autopilot seam was actually rewritten in memory |
| `[autopilotJumpZero] in-memory transform applied: stargate landing geometry, up to 500 m surface clearance` | the stargate envelope was actually rewritten in memory |
| `... in-memory transform already present:` | the file already carried the mod's own seam |
| `viability gate failed - no hooks installed` (+ reason lines) | a target file is not the shape the mod expects → **server runs vanilla** |
| `the autopilot warp-in distance is already owned by a server-side patch` | another patch owns the autopilot seam → **server runs that patch's behaviour** |
| `the stargate landing geometry already accounts for the ship radius` | the server already fixes the hull-size landing → **server runs its own geometry** |
| `invalid mod-owned configuration - no hooks installed` | a config value failed validation → **server runs vanilla** |
| `inert - mod disabled; vanilla EveJS autopilot behaviour retained` | `EVEJS_AUTOPILOT_JUMP_ZERO=0` |
| `required target already cached before hook installation` | load-order problem: the server required a target before the preload ran |
| `loader failed before activation` | the hook could not be installed; the loader rolled itself back |

In every failure case the server still starts and still runs - it just runs
vanilla autopilot. Runtime speed and correctness of the server are never traded
for the mod being present.

---

## 13. File map

```text
mods/autopilotJumpZero/
  loader.js                 entry point: gates, Module._load hook, API publication
  config.js                 environment variable resolution + validation (no file)
  lib/sourceTransforms.js   both seams, the anchors, the state machines
  lib/viability.js          independent shape checks (both files), fail-closed gate
  evejs-launcher.mod.json   EveJS Launcher manifest (schemaVersion 3, kind loader)
  README.md                 install / configure / verify
  HOW-IT-WORKS.md           this document
  CHANGELOG.md              what each release contains
  LICENSE                   AGPL-3.0
  test/run.js               mechanical suite
  test/installer.js         installer round-trip tests

installer/                  development only; pruned from an installed mods/ folder
  install.bat  install.js   detect the EveJS root, copy, register, back up
  uninstall.bat uninstall.js
  status.bat                report what is registered
  lib/deployment.js         root discovery, backup, copy, digests, prune lists
  lib/register.js           pure text transforms for entrypoint.sh / StartServer.bat / .dockerignore
```

---

## 14. Invariants to keep if you modify this mod

For anyone (human or agent) extending this code:

1. **Never write the transformed source to disk.** The whole safety story rests
   on the vendor tree staying pristine; `server/package.json` byte-identity is
   asserted by a test for the same reason.
2. **Keep transformations token-counted and scoped.** No whole-file regex
   replaces, no "find the first `minimumRange`" shortcuts. Both targets follow the
   same rule: locate the owning function, count the exact seam, refuse ambiguity.
3. **Keep the line-count invariant.** A transform that changes a file's line
   count must fail, not proceed.
4. **Keep failing closed.** New failure modes must log a reason and install
   nothing, never install partially.
5. **Keep `foreign` detection.** If another patch owns the seam, stay inert.
6. **Register preloads in all server launch paths** (`run_server()`, `run_all()`,
   `StartServer.bat`) - a mod that loads in one Docker mode and not the other is
   a bug, not a simplification.
7. **Leave `server/package.json` alone.** Register in `StartServer.bat` instead.
8. **Use forward slashes in `NODE_OPTIONS`.** A backslash there is an
   escape, not a separator.
9. **Append to `NODE_OPTIONS`, never claim it.** A launcher block that assigns,
   or that guards with `if not defined`, silently disables whichever loader mod
   registers next to it.
10. **Keep `mods/` in the Docker build context.** 261018.1's `.dockerignore` starts
    from `**` and does not mention `mods/`, and the image is built with `COPY . .`;
    without `!mods/` and `!mods/**` the payload never reaches `/app/mods` and the
    preload dies with `Cannot find module`. The installer adds them - a manual
    Docker install must too.
