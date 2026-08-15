# VGR Server Manager

Desktop control panel for the Vengeful Realms server, ported from the Alduinak
server manager and rewired for this VPS + the full skymp-vgr monorepo checkout.
Runs on the server box. **Run it as Administrator** - service control (nssm)
needs it.

```bash
cd server-manager
setup.bat             # first run - installs deps then launches the app
Run.bat               # everyday launch (self-elevates for service control)
```

## What it targets on this box

| Piece | Where |
|-------|-------|
| Backend | `skymp-vgr\skymp5-backend`, Windows service **SkyrpBackend** (nssm), port 4000 / relay 7778 |
| Nginx | `C:\nginx`, Windows service **vengefulrealmsNginx** |
| Game server | `C:\skymp\server` (found via `SERVER_SETTINGS_PATH` in the backend `.env`) |
| News data | `skymp5-backend\data\news.json` + images in `skymp5-backend\public\images` |
| Logs | `C:\logs` (plus whatever nssm reports per service) |

The game server has **no Windows service yet** (it was started manually via
`launch_server.bat`). Run `tools\install-game-service.bat` once as Administrator
to create **VgrGameServer** (and **VgrLiveKit** / **VgrVoiceAgent** for voice);
after that the Console tab can start/stop/restart it like the others. Services
are installed stopped - nothing starts until you say so.

## Tabs

- **Console** - start/stop/restart the `nginx`, `backend`, and `game` services,
  a live tail of the real service logs (asks nssm where each service writes its
  stdout/stderr), and a command box. `help`, `status`, `start|stop|restart
  <svc|all>`, and `build gamemode` run locally; anything else goes to the game
  server console over the backend WS relay (port/secret read live from
  `skymp5-backend\.env`).
- **News** - add / edit / delete / reorder the entries the launcher shows
  (`data/news.json`), with a picker for the `.gif` images in
  `public/images` (or import a new one from disk - it is copied into the
  folder). Saves go live in the launcher without a backend restart.
- **Players** - searchable player list from the backend database, editable
  username / display name / notes, factions, and the player's in-game
  characters read from the game server's MongoDB changeForms store, with the
  appearance / inventory editor. Player *deletion* stays with the backend's own
  character-deletion flow and is intentionally not exposed here.
- **Build** - drives the monorepo sources:
  - **Gamemode**: shows repo (`vgr-gamemode/`) vs live-server diff and merges
    the repo files onto the server. The deployed `gamemode.js` is a
    hand-written **loader** that `require()`s each extension - it is synced
    verbatim, never generated. Server-only extension files are never deleted;
    overwritten ones are backed up to `<serverDir>\manager-backups\<stamp>\`.
    **Restart the Game service after a sync** - extensions load once at
    startup (node's require cache); only `gamemode.js` itself is hot-watched.
  - **Game server**: `skymp5-server` TS bundle via `npm run build-ts`, deployed
    to `C:\skymp\server\dist_back` (previous bundle backed up). Restart the
    Game service to run it. `scam_native.node` still comes from the CI
    *PR Windows Flatrim* artifacts.
  - **Launcher**: version field writes `skymp5-launcher/package.json`,
    `LAUNCHER_LATEST_VERSION` in `.env`, and `routes/version.js` together
    (restart the Backend to serve it); Build installer runs electron-builder
    into `build/launcher`. Upload the installer to the download host yourself.
  - **Client files**: rebuilds `skymp5-client.js` into the CI payload at
    `build/dist/client`, then packages `skymp-client.zip` +
    `data/files-version.json` (vgr-frontend overlay included). **Careful:**
    while `CLIENT_ZIP_URL` points at the external host, a rebuild bumps the
    version launchers see but they still download the remote zip - upload the
    new zip there right away (or clear `CLIENT_ZIP_URL` to serve locally).
- **Modlist** - reads an MO2 profile (`VGR_MO2_ROOT`, not present on this box
  by default) and runs the backend's `compile-manifest.js`.
- **Settings** - structured forms for `C:\skymp\server\server-settings.json`
  and the backend `.env` (typed fields, masked secrets; unknown JSON keys
  round-trip through an *Other (raw JSON)* box).

## Online badges / item names

The Players tab asks the gamemode over the relay (`__playersjson`,
`__itemnamesjson`) for who is online and for item display names. If the VGR
gamemode does not implement those console queries the tab still works - the
badges and names just stay empty ("query timed out").

## Configuration (environment variables)

| Var | Default | Purpose |
|-----|---------|---------|
| `VGR_LOG_DIR` | `C:\logs` | Fallback log directory (nssm-configured paths win) |
| `VGR_SERVER_SETTINGS` | `SERVER_SETTINGS_PATH` from the backend `.env` | Game server settings file |
| `VGR_SERVER_DIR` | folder of server-settings.json | Game server working dir |
| `VGR_NEWS_IMAGES_DIR` | `skymp5-backend\public\images` | Folder the News tab picks images from |
| `VGR_MO2_ROOT` / `VGR_GAME_ROOT` / `VGR_MO2_PROFILE` | `X:\MO2` / … / `Default` | Modlist tab inputs |

The repo path, service names, and the WS relay port/secret (from the backend
`.env`) are detected automatically.
