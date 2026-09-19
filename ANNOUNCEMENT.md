🚀 **EveJS v0.12.8 — Autopilot Jump Zero**

Ever watched your autopilot warp to a gate, stop **10 km short**, and then spend the next twenty seconds crawling the rest of the way before it finally jumps?

Autopilot Jump Zero makes the autopilot warp land **on** its target, so the gate jump fires the moment the warp ends. ⚡

No client mod. No patched EveJS source on disk. **Your players install nothing.** 🎁

---

🧠 **Why vanilla autopilot is slow**

The retail client autopilot does two separate things:

1. It asks the server to warp with a **bare destination and no range** — so the landing point is entirely the server's decision.
2. It jumps on its own, once the *surface* distance to the gate drops under ~2500 m.

EveJS 0.12.8 hardcodes that autopilot landing to `{ minimumRange: 10000 }`. Landing 10 km out puts you outside the jump bubble, so the autopilot has to burn an extra approach leg first.

Raising the server's stargate jump range doesn't help — the client never reads it. The warp-in distance is the **only server-side lever** over autopilot travel time, and that's exactly the number this mod changes.

---

🎛️ **One setting is the whole tuning surface**

`EVEJS_AUTOPILOT_JUMP_ZERO_WARP_IN_METERS=0`

| Value | Result |
|---|---|
| **0** (default) | Land on the target — gates jump on arrival, stations **dock on arrival** |
| up to **2500** | Still inside the client's jump bubble |
| **15000** | Retail-style — back to the 10 km crawl |

Also:

`EVEJS_AUTOPILOT_JUMP_ZERO=0` disables it and restores vanilla behaviour.

Native: put it in `mods\autopilotJumpZero\.env`.
Docker: put it in the `environment:` block of the `server` service.

Changing a value needs a server restart, not an image rebuild. An out-of-range or non-numeric value is rejected and the mod goes inert — it never guesses.

---

🎯 **Scope**

Affects:

✅ Autopilot warps only — stargate jumps **and** station docking

Does not touch:

❌ Manual warp / warp-to-within
❌ Fleet warps, scan-result warps, mission and abyssal warps
❌ Any game client file — **nothing to distribute to players**
❌ Any EveJS source file on disk — it transforms one file in memory at startup
❌ Stargate jump range, aggro, or docking rules

Manual warps carry their own explicit range, so they behave exactly as before. The mod changes one number on one line.

---

🤝 **Compatibility**

Running on the same server as:

✅ Solo Progression Balance
✅ Moon Ore Anomalies
✅ Four-Mode Asteroid Belts

If another server-side patch already owns this seam, the mod detects it and **stays inert** instead of fighting it. Same if the seam is missing, duplicated or renamed — it fails closed, logs the reason, and the server keeps running vanilla autopilot. It never guesses and never applies halfway.

---

📦 **Installation**

**EveJS Launcher (recommended)**

1. Grab `autopilotJumpZero-1.1.1-EveJS-0.12.8-launcher.zip` — **don't extract it**
2. EveJS Launcher → **Mods** → **Add ZIP**
3. Enable **Autopilot Jump Zero**
4. **Apply & Restart Server**

**Native + Docker, one command**

```
install.bat --server "C:\path\to\EveJS"
```

It copies the mod to `mods\autopilotJumpZero`, then registers the preload for every deployment it finds — `docker/entrypoint.sh` (*both* server launch paths) and `StartServer.bat` for native. Registration is idempotent, and every file it touches is backed up first.

Docker users: rebuild after installing, since `mods\` is baked into the image.

**Confirm it loaded**

```
[autopilotJumpZero] v1.1.1 active — autopilot warp-in distance 0 m
[autopilotJumpZero] in-memory transform applied: beyonceService autopilot warp-in distance 0 m
```

If you see `viability gate failed` or `inert` instead, the mod refused to touch a file it didn't recognise and your server is running vanilla autopilot. That's deliberate, and the reason is printed on the next line.

---

✅ **EveJS v0.12.8 verification**

Mechanical suite:

**25/25 PASS**

✅ config surface + validation (env, `.env`, defaults, rejection)
✅ transform + idempotency
✅ fail-closed paths — missing anchor, duplicated seam, seam owned by another patch
✅ worker-thread guard
✅ child-process run proving the hook really feeds the configured range into the warp handler
✅ installer round-trip: install → reinstall → uninstall, with `server/package.json` byte-identical throughout

In game, on a live server:

✅ nine consecutive autopilot gate hops, every one a clean **warp → jump** (12–28 s per hop, no approach leg in between)

Target: EveJS v0.12.8

📄 **Want the mechanism?** `HOW-IT-WORKS.md` ships with the mod — the seam, the in-memory transform, the fail-closed gate, and the invariants behind them, written for humans *and* AI agents.

⛏️ Fly safe, and stop crawling to gates.

---

💡 **Legacy note**

Earlier attempts at this were source patches applied by hand. This release is a native mod: it never edits EveJS source on disk, and uninstalling is just removing the registration.