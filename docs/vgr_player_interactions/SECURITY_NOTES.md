# Security Notes

- Browser payloads never decide target identity, known-name state, admin permission, restraint state, or action availability.
- The client sends only the current crosshair target form ID. The server validates online player membership, self-targeting, range, cell, life-state best-effort checks, session token, and action ID.
- Interaction session IDs and trade request IDs use `crypto.randomBytes`.
- Introductions are directional and stored as `viewerCharacterId + knownCharacterId` with a unique compound index.
- Unknown names are resolved server-side. The browser no longer receives the prompt-name variant by default, and overhead nameplates are only sent for players already introduced to that specific viewer.
- Trade requests are bound to exact requester and exact target. Other players cannot accept or deny them by replaying the request ID.
- Binding uses allowlisted cuff base IDs only and moves one inventory entry with metadata preserved.
- Active restraints use a partial unique index on active target character ID.
- Admin force release uses the existing trusted `vgr.access.manage` permission source.
- Mongo startup failure disables persistence mutations and makes name visibility fail closed to `Stranger`.

Unverified live-engine areas:

- Native player prompt suppression must be confirmed in-game. The patch blocks server-side activation of online player actors, but static code inspection cannot prove native prompt text suppression.
- Hard movement/weapon controls for restrained players depend on verified Skyrim Platform methods and are not claimed as fully enforced by this static patch.
