# Rollback

Fast rollback:

1. Set `vgrPlayerInteractions.enabled` to `false`.
2. Restart the server.

Full file rollback:

1. Restore the backed-up `vgr-gamemode/gamemode.js`.
2. Restore modified extension files:
   - `vgr_access_control.js`
   - `vgr_trading.js`
   - `vgr_mining.js`
   - `vgr_woodcutting.js`
   - `vgr_emotes.js`
3. Remove the added player interaction files.
4. Restore `vgr-frontend/index.html` and `vgr-frontend/js/ingame/ui_manager.js`.
5. Remove player interaction CSS/JS.
6. Restart server and relaunch/resync client UI.

Data rollback:

- Introductions, restraint, and audit records are durable. Do not delete them unless deliberately resetting RP identity/restraint state.
