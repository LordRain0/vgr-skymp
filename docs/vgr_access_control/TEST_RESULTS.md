# Test Results

Date: 2026-08-05

Passed:

- `node --check vgr-gamemode/gamemode_extensions/vgr_access_control.js`
- `node --check vgr-gamemode/gamemode_extensions/vgr_access_identity.js`
- `node --check vgr-gamemode/gamemode_extensions/vgr_access_permissions.js`
- `node --check vgr-gamemode/gamemode_extensions/vgr_access_door_pair.js`
- `node --check vgr-gamemode/gamemode_extensions/vgr_access_door_probe.js`
- `node --check vgr-frontend/js/ingame/access_control.js`
- `node --check tools/migrate_vgr_legacy_locks.js`
- `node --test vgr-gamemode/tests/access_control.test.js`
- Re-ran after reverting offline-dev memory-store changes and after the access-control modal visibility fix.
- Re-ran after changing locked-object activation so owners/admins must unlock before normal activation.
- Re-ran after adding passive locked/unlocked owner hints and closed-menu activation toasts.
- Re-ran after moving the passive hint above the native activation prompt and removing the redundant locked toast.
- Re-ran after suppressing the passive hint while the `X` access-control menu is open.
- Re-ran after removing the passive hint backing box and the lock-toggle toast.
- Re-ran after changing the admin owner UI from owner removal to assign/replace.
- Re-ran after adding replacement wording and current-owner no-op guard.
- Re-ran after restricting non-admin owners to lock/unlock plus guest removal; guest addition and ownership replacement stay admin-only.

Node unit result:

- 4 tests passed.
- 0 tests failed.

Blocked in this environment:

- `cmake --build .` from `build` failed because `cmake` is not on PATH.
- `ctest --verbose` from `build` failed because `ctest` is not on PATH.

Manual in-game and Mongo outage acceptance tests require a running SkyMP server, Skyrim client, and MongoDB instance and are tracked in `MANUAL_ACCEPTANCE_TESTS.md`.
