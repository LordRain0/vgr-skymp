# VGR UI Manager

The VGR UI manager owns registered gameplay UI open/close state, browser focus, blocking behavior, and key-driven UI toggles. Feature systems should let the UI manager open and close registered UI shells, while feature-specific frontend files render their own content.

## Files

- `vgr-frontend/js/ingame/ui_manager.js`
- `vgr-gamemode/gamemode_extensions/vgr_ui_manager.js`
- `skymp5-client/src/services/services/vgrUiManagerService.ts`
- Shared gamemode helpers in `vgr-gamemode/gamemode.js`

## Registered UI

Registered UI entries live in `VGR_REGISTERED_UI` in `vgr-frontend/js/ingame/ui_manager.js`.

A UI should be registered there when it needs shared UI-manager behavior such as focus, blocking, active UI tracking, key toggles, or close-key handling.

Examples of registered VGR UI names include:

- `admin_menu`
- `trading`
- `access_control`
- `player_interaction`
- `trade_request`

## Frontend Usage

Frontend UI files should use browser messages when they need to open or close a registered UI from client-side behavior:

```js
window.skyrimPlatform?.sendMessage?.("vgr:ui:open", "admin_menu");
window.skyrimPlatform?.sendMessage?.("vgr:ui:close", "admin_menu");
```

The gamemode UI manager eventsource receives these messages and applies focus/blocking rules. The frontend `vgrShowUI(name)` and `vgrHideUI(name)` functions are called by the UI manager after that state decision.

Feature UI files should listen for their own UI-manager events and render or hide their DOM:

```js
window.addEventListener("vgr:ui_manager:open:admin_menu", () => {
  // Show the admin menu DOM.
});

window.addEventListener("vgr:ui_manager:close:admin_menu", () => {
  // Hide the admin menu DOM.
});
```

Do not call `vgrShowUI(...)` or `vgrHideUI(...)` directly from feature UI code for normal gameplay behavior. Use `vgr:ui:open` and `vgr:ui:close` so the UI manager remains authoritative.

## Gamemode Usage

Gamemode extensions should use the shared helpers when server logic needs to open or close a registered UI for a specific player:

```js
mp.vgrOpenUI(pcFormId, "trading");
mp.vgrCloseUI(pcFormId, "trading");
```

The first argument is the actor form ID for the target player. The helper resolves that actor to the connected user, sends a custom packet, and the client forwards the request into the existing UI-manager browser events.

Use these helpers for UI shell state only. Feature data should still be sent through feature-specific functions or packets, for example `vgrAccessControl`, `vgrPlayerInteractions`, or trading UI payloads.

## Eventsource Usage

Code inside `mp.makeEventSource(...)` is already running in the client SkyrimPlatform context. It should open or close registered UI by firing the regular UI-manager browser message locally:

```js
ctx.sp.browser.executeJavaScript(
  'window.skyrimPlatform?.sendMessage?.("vgr:ui:open", "admin_menu")'
);

ctx.sp.browser.executeJavaScript(
  'window.skyrimPlatform?.sendMessage?.("vgr:ui:close", "admin_menu")'
);
```

Use `mp.vgrOpenUI(...)` and `mp.vgrCloseUI(...)` from server-side gamemode code outside an eventsource, where the server needs to target a specific connected player.

## Custom Packet Transport

Most gamemode code should prefer `mp.vgrOpenUI(...)` and `mp.vgrCloseUI(...)`. Low-level code can send the packet directly with this shape:

```js
const userId = mp.getUserByActor(pcFormId);

mp.sendCustomPacket(userId, JSON.stringify({
  customPacketType: "vgrUiManager",
  action: "open",
  ui: "player_interaction"
}));
```

Close uses the same packet with `action: "close"`:

```js
mp.sendCustomPacket(userId, JSON.stringify({
  customPacketType: "vgrUiManager",
  action: "close",
  ui: "player_interaction"
}));
```

The client-side `VgrUiManagerService` receives `customPacketType: "vgrUiManager"` and runs the matching browser event:

```js
window.skyrimPlatform?.sendMessage?.("vgr:ui:open", uiName);
window.skyrimPlatform?.sendMessage?.("vgr:ui:close", uiName);
```

This does not use changeforms or the old frontend shell payload bridge.

## Legacy Bridge Status

The old generic shell frontend bridge has been removed from code. Do not use or reintroduce these symbols for gameplay UI payloads:

- `mp.vgrSendFrontendEvent`
- `vgrFrontendEvent`
- `window.vgrFrontendReceive`
- `window.VGRFrontend.onServerEvent(...)`

Use one of the current paths instead:

- UI shell open/close from server code: `mp.vgrOpenUI(...)` or `mp.vgrCloseUI(...)`
- UI shell open/close from frontend or eventsource code: `window.skyrimPlatform?.sendMessage?.("vgr:ui:open", uiName)` or `window.skyrimPlatform?.sendMessage?.("vgr:ui:close", uiName)`
- Feature-owned UI content: a feature-specific custom packet/service, such as `vgrAccessControl` or `vgrPlayerInteractions`
- Temporary feedback: `mp.vgrSendNotification(...)` or `window.vgr_send_notification(...)`

## Boundaries

- UI-manager packets only open or close registered UI shells.
- Do not attach feature state, menu entries, notifications, search results, trade snapshots, or other UI content to `vgrUiManager` packets.
- Registered UI open/close should not be represented as feature-specific `action: "open"` or `action: "close"` payloads.
- Client-only UI interactions can call `window.skyrimPlatform?.sendMessage?.("vgr:ui:open", uiName)` or `window.skyrimPlatform?.sendMessage?.("vgr:ui:close", uiName)` directly.
- Server-owned UI content should use feature-specific custom packets or direct frontend functions, then use `mp.vgrOpenUI(...)` or `mp.vgrCloseUI(...)` separately when the shell state must change.

## Example Flow

Opening the access-control manage UI from gamemode:

```js
mp.vgrOpenUI(pcFormId, "access_control");
sendAccessUi(pcFormId, "openManage", managePayload);
```

The UI-manager packet opens the registered shell. The access-control packet carries only the data needed to render the manage view.

Closing a UI from frontend:

```js
window.skyrimPlatform?.sendMessage?.("vgr:ui:close", "access_control");
```

Closing a UI from gamemode:

```js
mp.vgrCloseUI(pcFormId, "access_control");
```
