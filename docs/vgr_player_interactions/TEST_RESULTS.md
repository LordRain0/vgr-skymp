# Test Results

Date: 2026-08-05

Automated checks run:

- `node --check vgr-gamemode/gamemode_extensions/vgr_player_interactions.js`
- `node --check build/dist/server/gamemode_extensions/vgr_player_interactions.js`
- `node --check vgr-gamemode/gamemode_extensions/vgr_player_interaction_helpers.js`
- `node --check vgr-gamemode/gamemode_extensions/vgr_trading.js`
- `node --check vgr-gamemode/gamemode_extensions/vgr_access_control.js`
- `node --check vgr-gamemode/gamemode_extensions/vgr_mining.js`
- `node --check vgr-gamemode/gamemode_extensions/vgr_woodcutting.js`
- `node --check vgr-gamemode/gamemode_extensions/vgr_emotes.js`
- `node --check vgr-frontend/js/ingame/player_interactions.js`
- `node --check vgr-frontend/js/ingame/ui_manager.js`
- `node --test vgr-gamemode/tests/access_control.test.js`
- `node --test vgr-gamemode/tests/player_interactions.test.js`

Results:

- Access-control tests: 4 passed, 0 failed.
- Player-interaction tests: 4 passed, 0 failed.
- Introduced-player overhead nameplates: syntax-checked only; live Skyrim Platform Text Reference rendering requires in-game verification.
- Patch archive: `tools/VGR_Player_Interactions_Patch.zip`

Attempted and blocked in this environment:

- `cmake --build .`
- `ctest --verbose`
- Live three-client Skyrim/SkyMP tests.

Reason:

- `cmake --build .` from `build` failed because `cmake` is not on PATH.
- `ctest --verbose` from `build` failed because `ctest` is not on PATH.
- Native prompt suppression, overhead nameplate positioning, dead-player routing, visual cuffs, movement restriction, and true three-client race behavior require a running SkyMP server and multiple clients.
