# Rollback

1. Preferred: set the feature kill switch in server settings:

```json
"vgrAccessControl": {
  "enabled": false
}
```

2. If you need a code rollback, remove or comment this line in `vgr-gamemode/gamemode.js`:

```js
require(path.join(extensionsDir, 'vgr_access_control.js'))(mp);
```

3. Remove the `access_control` registry entry from `vgr-frontend/js/ingame/ui_manager.js`.
4. Remove the `access_control.css` link, `access_control.js` script, and `#vgr-access-control` markup from `vgr-frontend/index.html`.
5. Restart the game server and frontend delivery process.

Mongo rollback:

- The migration tool does not mutate legacy `locked_objects`.
- To disable new data without deleting it, leave `vgr_access_objects` intact and remove the gamemode require.
- To remove new data after export, drop only the configured access collection, not `changeForms`, `characters`, or legacy `locked_objects`.
