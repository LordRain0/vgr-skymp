# Legacy Audit

Inspected legacy archive:

- `C:\Users\PC\Downloads\server gamemode_extensions.zip`
- Files reviewed: `vgr_locks.js`, `vgr_locks_door_pair.js`, `vgr_locks_door_probe.js`, `vgr_ui_manager.js`

Findings:

- Legacy ownership used actor form descriptions, which are not stable character IDs.
- Legacy admin/key-handler authority came from configured form descriptions or Mongo dynamic fields, not the current server-side permission model.
- Legacy activation opened management UI for owners during normal activation; the new system keeps management on contextual X only.
- Legacy code overrode `mp.onTakeItem` and `mp.onPutItem` to persist container inventory. The new system does not touch those hooks.
- Door-pair XTEL parsing was useful and was reimplemented as a dedicated access-control helper.
- The legacy UI manager was not copied. The existing live `vgr_ui_manager.js` remains authoritative.
