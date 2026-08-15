# VGR Player Interactions

This patch adds a shared contextual X-key player interaction layer for Vengeful Realms.

Runtime entry points:

- `vgr-gamemode/gamemode_extensions/vgr_player_interactions.js`
- `vgr-gamemode/gamemode_extensions/vgr_player_interaction_helpers.js`
- `vgr-frontend/js/ingame/player_interactions.js`
- `vgr-frontend/css/ingame/player_interactions.css`

The system owns DIK 45 through `_vgrContextualX`. The router validates the exact crosshair target on the server and uses this priority:

1. Living online player: open the player interaction menu.
2. Door/container: delegate to the existing `vgr_access_control` API.
3. Anything else: open nothing.

The top-level player menu is:

1. `INTRODUCE YOURSELF`
2. `TRADE`
3. `USE BINDS` or `REMOVE BINDS`

Identity privacy is directional. If A introduces to B, B can see A's current roleplay name, but A still sees B as `Stranger` until B introduces to A. The relationship stores stable character IDs derived from `profileId`; it does not store the name as authority. Current online actor appearance is used for the current display name.

Known-player overhead labels use Skyrim Platform text references attached to `NPC Head [Head]`. The labels are per-viewer: unknown players do not receive overhead labels, and the old crosshair prompt name variant is disabled by default through `promptShowsTargetName: false`.

MongoDB collections:

- `vgr_player_introductions`
- `vgr_player_restraints`
- `vgr_player_interaction_audit`

Required settings block:

```json
{
  "vgrPlayerInteractions": {
    "enabled": true,
    "interactionKeyDik": 45,
    "maxDistance": 300,
    "targetTokenTtlMs": 15000,
    "menuIdleTtlMs": 30000,
    "promptRefreshMs": 100,
    "promptShowsTargetName": false,
    "nameplatesEnabled": true,
    "nameplateMaxDistance": 1200,
    "nameplateRefreshMs": 1000,
    "nameplateFont": "Tavern",
    "nameplateTextSize": 0.82,
    "nameplateColor": [0.86, 0.72, 0.38, 1],
    "nameplateNode": "NPC Head [Head]",
    "nameplateWorldOffset": [0, 0, 18],
    "nameplateScreenOffset": [0, -36],
    "unknownName": "Stranger",
    "tradeRequestsEnabled": true,
    "tradeRequestTtlMs": 15000,
    "tradeRequestCooldownMs": 5000,
    "bindingsEnabled": true,
    "normalReleaseItemPolicy": "return_to_releaser",
    "adminReleaseItemPolicy": "leave_with_target",
    "cuffBaseIds": [1063233, 1105977, 1106648],
    "databaseName": "vengeful_realms",
    "introductionsCollection": "vgr_player_introductions",
    "restraintsCollection": "vgr_player_restraints",
    "auditCollection": "vgr_player_interaction_audit"
  }
}
```

Installation:

1. Back up `vgr-gamemode`, `vgr-frontend`, and `build/dist/server/server-settings.json`.
2. Back up MongoDB collections listed above, if they already exist.
3. Copy the patch files preserving repository paths.
4. Merge the `vgrPlayerInteractions` settings block.
5. Restart the server so Node `require()` loads the new extensions.
6. Relaunch or resync the client UI through `local-dev/launch-local.bat`.
7. Confirm startup logs show `[VGR player_interactions] module loaded`.
8. Run a three-client smoke test: A looks at B, A introduces, B sees A's name, A sends trade, B accepts, A applies/removes cuffs.

Rollback:

1. Set `vgrPlayerInteractions.enabled` to `false`, or remove the `require()` line from `gamemode.js`.
2. Restart the server.
3. Restore changed frontend files if needed.
4. Leave introduction/restraint/audit records intact unless a deliberate data rollback is required.

Verified local limitations:

- Exact crosshair target acquisition uses the same verified `Game.getCurrentCrosshairRef()` path already used by access control.
- Server-side activation of online player actors is blocked, but native `Talk to NAME` prompt suppression cannot be fully verified from static repo inspection. This needs live engine confirmation.
- Restrained visual equip/movement restrictions are represented by authoritative server state and inventory transfer. Hard movement/weapon restrictions require live engine validation.
