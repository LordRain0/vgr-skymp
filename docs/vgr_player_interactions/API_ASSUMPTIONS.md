# API Assumptions and Verified Local References

Used APIs already present in repository code or docs:

- `ctx.sp.Game.getCurrentCrosshairRef()`
- `ctx.getFormIdInServerFormat(formId)`
- `ctx.getFormIdInClientFormat(formId)`
- `ctx.sp.on("buttonEvent")`
- `ctx.sp.on("browserMessage")`
- `ctx.sp.Ui.isTextInputEnabled()`
- `ctx.sp.Ui.isMenuOpen(name)`
- `ctx.sp.createText(x, y, text, color, font)`
- `ctx.sp.destroyText(textId)`
- `ctx.sp.setTextString(textId, text)`
- `ctx.sp.setTextColor(textId, color)`
- `ctx.sp.setTextSize(textId, size)`
- `ctx.sp.setTextDepth(textId, depth)`
- `ctx.sp.setTextRefr(textId, refrFormId)`
- `ctx.sp.setTextRefrNode(textId, nodeName)`
- `ctx.sp.setTextRefrOffset(textId, offset)`
- `ctx.sp.setTextRefrScreenOffset(textId, offset)`
- `mp.makeEventSource`
- `mp.makeProperty`
- `mp.get(actor, "profileId")`
- `mp.get(actor, "inventory")`
- `mp.get(actor, "pos")`
- `mp.get(actor, "worldOrCellDesc")`
- `mp.get(0xff000000, "onlinePlayers")`
- `mp.set(actor, "inventory", value)`
- `mp.onActivate(targetFormId, actorFormId)`

Best-effort/unverified:

- Dead-state detection probes several known/likely fields. A live build should confirm the authoritative field.
- Native prompt suppression for `Talk to NAME` requires live client verification.
- Visual cuff equip and hard movement restriction require live Skyrim Platform verification.
- Dear Diary is a UI/HUD replacer, not a server API. The overhead names are therefore implemented through Skyrim Platform's Text Reference Attachment API with Dear Diary-like Tavern/gold styling.
