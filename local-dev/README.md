# Local offline test environment

Test changes on this machine before pushing them live. Everything runs on
loopback in **offline mode**: no prod API, no Discord auth, no MongoDB, no
master-server registration.

```
Skyrim + SKSE  ──UDP 7777──>  game server (build\dist\server, node)
   (S: drive)                    │  web UI / manifest: http://localhost:3000
                                 │  world state: build\dist\server\world\  (file DB)
launcher (optional) ──HTTP──>  backend API  http://localhost:4000
                                 dashboard  http://localhost:4002
                                 WS relay   ws://localhost:7778
```

## One-time setup status

| Piece | State |
|---|---|
| CMake | portable 3.31.10 in `vcpkg\downloads\tools` (used for the build); CMake 4.4.1 installed user-scope via winget for new shells |
| yarn | installed globally via npm |
| `skymp5-backend\.env` | **replaced with local config** — prod copy backed up at `W:\SkyMPRepos\_env-backups\skymp-vgr-backend.env.prod-2026-07-31`, protected via `git update-index --skip-worktree skymp5-backend/.env` |
| `skymp5-launcher\.env` | created, `API_URL=http://localhost:4000` (gitignored) |
| VS 2022 C++ workload | **BROKEN as of 2026-07-31** — the 14.43 compiler files exist but `vcvarsall.bat` is missing and the instance isn't registered with C++ tools, so both vcpkg and the VS generator fall back to the too-old 2019 Build Tools (MSVC 14.29, no C++23 `std::to_underlying` → CommonLibSSE fails). Repair (elevated, click the UAC prompt): `& "C:\Program Files (x86)\Microsoft Visual Studio\Installer\setup.exe" modify --installPath "C:\Program Files\Microsoft Visual Studio\2022\Community" --add Microsoft.VisualStudio.Workload.NativeDesktop --includeRecommended --passive --norestart` |
| Server build | after the VS repair: `cmake .. -G "Visual Studio 17 2022" -DCMAKE_GENERATOR_INSTANCE="C:\Program Files\Microsoft Visual Studio\2022\Community" -DSKYRIM_DIR="S:/SteamLibrary/steamapps/common/Skyrim Special Edition"` then `cmake --build . --config Release` from `build\` (use the portable cmake in `vcpkg\downloads\tools\cmake-3.31.10-windows\...\bin` or the winget-installed one) — `OFFLINE_MODE=ON` is the default and stamps `offlineMode: true, master: ""` into the generated `build\dist\server\server-settings.json` on every build. `overlay_triplets/x64-windows-sp.cmake` pins `VCPKG_PLATFORM_TOOLSET v143` so vcpkg can't regress to the 2019 toolset. |

## Daily loop

**`local-dev\launch-local.bat`** — one double-click: starts local MongoDB (if
installed), starts the game server in its own window, writes offline client
settings, launches Skyrim. Prefers MO2 mode (full modlist via
`W:\VengefulRealms\MO2\ModOrganizer.exe`, profile `VengefulRealms`, SKSE
shortcut) since the launcher installed the modlist there on 2026-08-03; falls
back to direct `skse64_loader.exe` from the S: install. Auth is just the
integer `profileId` in `skymp5-client-settings.txt` — no launcher, no Discord.
The launcher wrote prod online-mode settings into the client mod; the .bat
overwrites them with the offline localhost shape on every run.

## Local MongoDB (installed 2026-08-03)

Official `mongodb-windows-x86_64-6.0.29.zip` from fastdl.mongodb.org
(SHA256-verified), extracted to `C:\mongodb-sp\mongodb-win32-x86_64-windows-6.0.29`,
plus official mongosh 2.9.2 at `C:\mongodb-sp\mongosh`. Loopback only
(`bindIp: 127.0.0.1`), auth enabled. Data: `C:\mongodb-sp\data`, log:
`C:\mongodb-sp\log\mongod.log`, config: `<mongo>\bin\mongod.cfg`.

- Admin user: `vgrAdmin` / `fb4b904ad483478b` (authSource `admin`; local-only creds)
- `local-dev\start-mongo.ps1` starts it as a hidden process (idempotent); the
  .bat calls it automatically. To register as a Windows service instead, run
  **from an elevated prompt**:
  `C:\mongodb-sp\mongodb-win32-x86_64-windows-6.0.29\bin\mongod.exe --config C:\mongodb-sp\mongodb-win32-x86_64-windows-6.0.29\bin\mongod.cfg --install --serviceName MongoDB` then `net start MongoDB`
- Backend uses it via `BACKEND_DATABASE_URI` in `skymp5-backend\.env` (already
  wired), so `/api/users/*` character/session routes work locally.
- For vgr_mining persistence: add
  `"databaseUri": "mongodb://vgrAdmin:fb4b904ad483478b@127.0.0.1:27017/vengeful_realms?authSource=admin"`
  to `build\dist\server\server-settings.json` and `npm install mongodb` inside
  `build\dist\server` (the backend auto-adopts that same URI — fine locally).
- Backup/restore (mongodump/mongorestore) needs the separate MongoDB Database
  Tools zip — not installed yet; grab it from mongodb.com when needed for
  pulling live data snapshots.

Pieces individually:
1. `local-dev\start-backend.ps1` — backend on :4000 (only needed for launcher testing; **offline play does not need the backend at all**)
2. `local-dev\start-server.ps1` — syncs the VGR gamemode into `build\dist\server`, then starts the game server (Ctrl+C to stop)
3. `local-dev\install-client-to-skyrim.ps1` — direct-mode alternative to the MO2 modlist: installs this repo's client into the S: Skyrim install (backs up the existing Keizaal client first; `restore-skyrim-client.ps1` reverses it), overlays the fresh TS bundle + working-tree `vgr-frontend` UI
4. `local-dev\write-offline-client-settings.ps1` — (re)writes the offline settings file into the MO2 client mod (`-Mo2Dir`) or a game dir (`-SkyrimDir`); launch-local.bat calls it every run

## Iterating on each layer

| You changed | Do this |
|---|---|
| `skymp5-server/ts/*` | `yarn --cwd skymp5-server build-ts` (rebundles into `build\dist\server\dist_back\` without touching C++), restart server |
| `skymp5-server/cpp/*` | `cmake --build . --config Release` from `build\`, restart server |
| `vgr-gamemode/gamemode.js` | `local-dev\sync-gamemode.ps1` — the running server hot-reloads gamemode.js |
| `vgr-gamemode/gamemode_extensions/*` | `local-dev\sync-gamemode.ps1` **and restart the server** (extensions are require()-cached, no hot reload) |
| `vgr-frontend/*` (in-game UI) | `cmake --build . --config Release --target vgr_frontend_client_ui` then re-run `install-client-to-skyrim.ps1` (or copy `vgr-frontend\*` straight into `<Skyrim>\Data\Platform\UI\`) |
| `skymp5-client/src/*` | `yarn --cwd skymp5-client build` (webpack → `build\dist\client\...\skymp5-client.js`) then re-run `install-client-to-skyrim.ps1`; or `yarn watch` + `DEPLOY_PLUGIN=true`/`SKYRIMPATH` for hot reload (see `docs/contributing/en/How to work with skymp5-client.md`) |
| `skymp5-backend/*` | nothing — `start-backend.ps1` runs `npm run dev` (auto-restart) |
| `skymp5-launcher/*` | `npm run dev` in `skymp5-launcher\` (needs backend on :4000) |

## Resetting the local world

Stop the server, then delete `build\dist\server\world\` and
`build\dist\server\data\server-loadorder-lastknown.json`. (Changing `loadOrder`
with an existing world triggers an interactive y/N migration prompt at startup —
deleting these resets cleanly instead.)

## Gamemode-script signing (why menus need a local key)

SkyMP servers sign every piece of gamemode JS sent to clients
(`// skymp:sig:y:CPP<alias>:<sig>`, see `PartOne.cpp`). The client rejects
unsigned scripts whenever its settings contain a `server-public-keys` object —
and due to how the settings service merges keys, that object exists (empty)
even when not configured, so an unkeyed local server means the client silently
drops the UI manager and every menu with "no signature found".

Fix (automatic): `write-offline-client-settings.ps1` runs
`ensure-server-key.js`, which generates a **local** ed25519 keypair on first
run, stores it as `serverKey` (alias `vgrlocal`) in
`build\dist\server\server-settings.json`, and pins the public key as
`CPPvgrlocal` in the client settings. Never copy prod's `serverKey` here.
If you wipe `build\dist\server`, the next launch regenerates a new pair
automatically — but the server must restart to sign with it.

## Skills & Levels system (v1, built 2026-08-03)

Implements the "Levels and Skills" proposal doc: general XP → level (+1 skill
point per level, soft cap 10), per-tree skill XP that only accrues after a
point is allocated, tier gating by tree XP, GM-only specialisations. Press
**K** in-game to open the menu.

| Piece | File |
|---|---|
| Tuning (trees, XP curves — all numbers placeholders) | `vgr-gamemode/gamemode_extensions/vgr_skills_config.json` |
| Server logic + state (`private.vgrSkills`, auto-persisted per character) | `vgr-gamemode/gamemode_extensions/vgr_skills.js` |
| XP hooks + Miner harvest gate | `vgr_mining.js`, `vgr_woodcutting.js` (guarded `mp.vgrSkillsOnGather`/`mp.vgrSkillsCanGather` calls) |
| Menu UI | `vgr-frontend/js/ingame/skills.js`, `css/ingame/skills.css`, `index.html` panel, `ui_manager.js` registry entry (KeyK) |

Design notes (v1.5, node model per the proposal mockups): trees are chains of
named nodes (1 SP each + tree-XP requirement; first node free). Mining nodes
carry `unlocks` ore lists — harvesting an ore requires an allocated node that
unlocks it (deny = toast + mining UI closes). Woodcutting harvest is ungated
(proposal user journey) but only grants tree XP once allocated; general XP
accrues from all harvesting. UI matches the mockups: node columns, green =
allocated / blue = unlockable (click to allocate) / grey = locked, Character
Level banner, allocated X/Y counter, GM-only specialisation at each column
foot. UI v2 ("Professions", 2026-08-05): left sidebar lists professions with
invested ones on top; main pane shows the selected tree; clicking the next
perk STAGES it (amber) and the top-right "N / M Skills Selected" + Apply
button commits via `vgr:skills:allocateBatch` (server-validated
all-or-nothing) — no accidental point spending. NOTE: the vgrSkillsUi mailbox
property holds ONE value per client frame — never push a notice and a state
refresh as separate mp.set calls; combine them into one payload.
GM APIs on `mp`: `vgrSkillsGrantPoints`, `vgrSkillsGrantSpecialization`
(admin-menu wiring pending). Backlog from the doc: spawn kits, milestones,
level-up HP/Mana/Stam choice, branching tree paths (Smithing weapons/armour),
crafting recipe gates via `mp.onCraft` + `tools/export_cobj_recipes.py`,
combat/craft XP sources.

Iterate: gamemode edits → `sync-gamemode.ps1` + server restart; UI edits →
relaunch via the .bat (auto-overlay). **UI preview without the game**:
`node local-dev\serve-frontend.js` then open http://localhost:8123/ — force
gameplay mode and inject mock state from the browser console to style panels
(no caching, edits show on refresh).

## Traps to know about

- **`skymp5-backend\.env` is tracked in git.** It currently holds LOCAL values
  and is skip-worktree'd so it can't be committed by accident. To work on prod
  config again: copy the backup from `W:\SkyMPRepos\_env-backups\` back over it,
  then `git update-index --no-skip-worktree skymp5-backend/.env`.
- **Don't run `npm run merge` / `npm run build-client` in skymp5-backend with
  the local .env if you intend to publish the result** — those rewrite the
  git-tracked `skymp5-backend/data/files-version.json` and the client zip that
  prod serves.
- **`skymp5-launcher\.env` gets bundled into packaged installers** by
  electron-builder. Delete/restore it before `npm run build:win` for a release.
- **Rebuilds re-stamp `offlineMode`/`master`** in
  `build\dist\server\server-settings.json` (cmake `OFFLINE_MODE=ON` default);
  hand-edits to those two keys don't survive a build. Other keys are preserved.
  Note the settings loader only applies *truthy* values for core keys — setting
  e.g. `"maxPlayers": 0` or `"master": ""` silently falls back to defaults.
- **Launcher offline play requires a Discord-login-derived profileId** in its
  electron-store (`%APPDATA%\vengeful-realms-launcher\config.json`), which this
  machine doesn't have — hence the launcher bypass in the daily loop. Launcher
  UI testing against :4000 works fine; only Play needs the profileId.
- **Voice/mining degrade gracefully offline**: no `voice` block in
  server-settings = LiveKit disabled; no MongoDB = mining UI works but veins
  grant no ore (`npm install mongodb` in `build\dist\server` + a local Mongo +
  `databaseUri` in server-settings.json enables it — note the backend adopts
  that same `databaseUri` automatically).
- **`VGR_TRADING_DEV` in `vgr-gamemode/gamemode_extensions/vgr_trading.js`**:
  flip to `true` locally for single-client F4 fake-partner trade testing —
  never commit it `true` (it also auto-accepts trades from offline partners).
- The in-game client sends protocol version `7_` — client binaries and the
  server must come from the same tree, or you get a misleading
  "update available" dialog. The install script prefers `build\dist\client`
  (same build as the server) over the older `build\client-files` bucket.
