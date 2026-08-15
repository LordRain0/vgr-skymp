# Compatibility Report

- Access control: compatible. The new contextual X router delegates door/container targets to `mp._vgrAccessControl`.
- Trading: compatible. Existing full trade offer/final-accept flow remains in `vgr_trading.js`; player interactions only add request/approval.
- Death looting: no matching local VGR death-looting module was present. Dead-player delegation remains a documented extension point.
- Social/admin UI: no direct changes beyond UI registry additions.
- Mining/woodcutting: now reject restrained players server-side and client-side where practical.
- Emotes: now reject restrained players using replicated `vgrRestraintState`.
- Voice/VOIP: no changes.
- UI focus: new panels are event-driven blocking UIs and use the existing UI manager.
- Existing access-control passive door/container hint remains unchanged.
