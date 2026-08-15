# Patch Notes

- Added `vgr_player_interactions.js` server extension.
- Added `vgr_player_interaction_helpers.js` helper module.
- Added shared `_vgrContextualX` DIK 45 event source.
- Removed access-control's independent DIK 45 button handler; access-control is now reached through the shared router.
- Added passive player prompt: `(X) MENU`.
- Added introduced-player overhead nameplates using Skyrim Platform text references attached to the actor head node.
- Disabled the old crosshair prompt name variant by default with `promptShowsTargetName: false`.
- Added compact player interaction menu.
- Added directional introduction persistence and cache.
- Added incoming/outgoing trade request UI.
- Added exact-target trade service integration to `vgr_trading.js`.
- Disabled F4 nearest-player and direct browser target trade opening in production mode.
- Added viewer-specific trade partner labels for exact-target trades.
- Added binding and release service for the three configured cuff base IDs.
- Added `vgrRestraintState` owner-visible property.
- Added restraint guards for mining, woodcutting, and emotes.
- Added player interaction frontend CSS/JS/HTML and UI registry entries.
- Added local DEV server-settings block for `vgrPlayerInteractions`.
