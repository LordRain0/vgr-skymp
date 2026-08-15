# API Assumptions

Confirmed from the repo:

- `mp.onActivate(targetFormId, actorFormId)` is cancellable. Returning `false` blocks normal activation.
- `mp.get(actorFormId, "profileId")` returns the stable selected character profile.
- `private.indexed.discordId` and `private.discordRoles` are server-owned actor fields set by login/spawn systems.
- Skyrim Platform provides `Game.getCurrentCrosshairRef()`, `ObjectReference.getBaseObject()`, and `FormType.Door` / `FormType.Container`.
- `ctx.getFormIdInServerFormat()` is used by existing VGR gameplay code and is used for the X-key target form ID.
- `mp.get(formId, "baseDesc")`, `mp.lookupEspmRecordById()`, and `mp.getIdFromDesc()` are available for runtime object classification.
- Existing UI open/close messages are `vgr:ui:open` and `vgr:ui:close`.

Operational assumptions:

- The backend `characters` collection is reachable from the game server Mongo URI unless overridden with `vgrAccessControl.backendDatabaseUri`.
- Access admins configure at least one `vgr.access.manage` source before production use.
