# VGR Access Control

This patch adds a production access-control system for doors, teleport door pairs, non-teleport doors, and containers.

The runtime entry point is `vgr-gamemode/gamemode_extensions/vgr_access_control.js`. It installs a cancellable server-side `mp.onActivate` handler, registers a contextual X-key event source, and drives the browser UI registered as `access_control`.

Key properties:

- `vgrAccessControl.enabled: false` disables the extension without removing files.
- Stable character identity is `profileId`.
- Server permissions come from `vgrAccessControl.permissions["vgr.access.manage"]`, evaluated against server-side `profileId`, Discord ID, and Discord role fields.
- Browser payloads never decide admin status or object authority.
- Locked object activation is denied server-side before normal processing, including for owners, keyholders, and access administrators.
- Owners and administrators must use `X` management to unlock a locked object before normal activation can open it.
- Unlocked authorized activation uses default ObjectReference activation and does not override inventory take/put handlers.
- Looking at a managed door/container shows a passive access hint without opening the `X` menu: red for locked, yellow for unlocked, with owner name.
- UI sessions use random tokens with 15 second target TTL, 60 second idle timeout, and 5 minute absolute timeout.
- Mongo updates use object revision filters and atomic `$set`, `$push`, `$pull`, and `$inc` operations.
- Startup database failure is fail-closed. Runtime write outage disables mutations while enforcing the last loaded cache.

Players use the standard activation key to open unregistered or unlocked managed objects. Locked managed objects must be unlocked through the `X` access-control UI before normal activation opens them. Looking at a managed target shows `Door Locked/Unlocked` or `Container Locked/Unlocked` plus the owner name as a passive hint. X is a contextual management key only: the client sends an inspect request only when the crosshair target is a door or container, and the server then validates the target, distance, cell, object type, session, and permissions.

In the owner controls, access administrators assign an owner when none exists or replace the current owner when one exists. The normal admin UI does not expose owner removal because that leaves the object unassigned.

Owners can manage lock state and remove guest/keyholder access for their own object. Adding guests and assigning/replacing ownership remain access-admin-only.

Collections:

- Access objects: `vgr_access_objects` in `vgrAccessControl.databaseName`.
- Character search: `characters` in `vgrAccessControl.backendDatabaseName`.
- Legacy source for migration: `locked_objects` from the old `vgrLocks` settings.

Migration:

```powershell
node tools/migrate_vgr_legacy_locks.js --settings C:\path\to\server-settings.json --report C:\temp\vgr-access-report.json
node tools/migrate_vgr_legacy_locks.js --settings C:\path\to\server-settings.json --commit --report C:\temp\vgr-access-report.json
```

Dry run is the default. The tool does not delete or edit the legacy source and intentionally ignores legacy inventory snapshots.
