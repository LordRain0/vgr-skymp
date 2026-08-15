# VGR Frontend Notifications

The frontend notification system provides a shared way to display temporary gameplay messages without each UI owning its own toast element.

## Files

- `vgr-frontend/css/ingame/notifications.css`
- `vgr-frontend/js/ingame/notifications.js`
- Notification DOM root in `vgr-frontend/index.html`

## API

```js
vgr_send_notification(notification_type, notification_msg_string, options);
```

`vgrSendNotification` is also available as a camel-case alias in frontend JavaScript.

Frontend code should call the function directly:

```js
window.vgr_send_notification(
  2,
  "[b]Trade request sent[/b]\n[muted]Waiting for response[/muted]",
  { variant: "trade", durationMs: 4500 }
);
```

Gamemode extensions should use the shared server helper:

```js
mp.vgrSendNotification(
  pcFormId,
  2,
  "[red][b]Access denied[/b][/red]\nYou do not have permission to open this.",
  { variant: "access" }
);
```

`mp.vgrSendNotification` resolves the actor to its connected user, sends a `vgrNotification` custom packet, and the client calls `window.vgr_send_notification(...)`. It does not use changeforms.

The old generic frontend shell payload bridge has been removed. Do not reintroduce notification delivery through `mp.vgrSendFrontendEvent`, `window.VGRFrontend.onServerEvent("notifications", ...)`, feature-specific `action: "toast"` payloads, or `toastMessage` fields. Server-owned UI payloads should only carry the state that UI needs to render; temporary feedback should use the shared notification helper.

Current gameplay/admin/social systems should use notification type `2`. Type `1` remains available for future central-screen moments, but it is not used by current feature code.

## Gamemode Transport

Most gamemode code should prefer `mp.vgrSendNotification(...)`. If low-level code needs to send the custom packet directly, use this packet shape:

```js
const userId = mp.getUserByActor(pcFormId);

mp.sendCustomPacket(userId, JSON.stringify({
  customPacketType: "vgrNotification",
  type: 2,
  message: "[gold]Trade request accepted.[/gold]",
  options: {
    variant: "trade",
    durationMs: 4500
  }
}));
```

The client-side `VgrNotificationService` receives `customPacketType: "vgrNotification"` and runs:

```js
window.vgr_send_notification(type, message, options);
```

Notification strings sent this way support the same safe formatting tags as direct frontend calls, including custom color spans like `[color=#7fd1ff]frost blue[/color]`.

## Notification Types

| Type | Name | Placement | Intended Use |
| --- | --- | --- | --- |
| `1` | Central | Center of screen, large text | Important discoveries, quest-style messages, major status changes |
| `2` | Corner | Bottom-right stack, smaller text | Regular feedback, errors, trade/access/admin status messages |

Constants are also exposed:

```js
VGR_NOTIFICATION_TYPE.CENTRAL;
VGR_NOTIFICATION_TYPE.CORNER;
```

## Variants

Variants control tone and accent color. The type controls where the notification appears.

| Variant | Use |
| --- | --- |
| `default` | Neutral general-purpose message |
| `success` | Completed action |
| `warning` | Soft caution or recoverable issue |
| `error` | Failed or blocked action |
| `info` | System or context update |
| `quest` | Discovery/objective-style central message |
| `trade` | Trade request/session feedback |
| `access` | Door/container permission feedback |

Unknown variants fall back to `default`.

## Formatting

Notification messages use a small safe formatting syntax. Raw HTML is not interpreted.

Supported tags:

| Tag | Effect |
| --- | --- |
| `[b]text[/b]` | Bold |
| `[i]text[/i]` | Italic |
| `[u]text[/u]` | Underline |
| `[gold]text[/gold]` | Gold text |
| `[red]text[/red]` | Red text |
| `[green]text[/green]` | Green text |
| `[blue]text[/blue]` | Blue text |
| `[white]text[/white]` | Bright parchment/white text |
| `[gray]text[/gray]` | Gray text |
| `[orange]text[/orange]` | Orange text |
| `[purple]text[/purple]` | Purple text |
| `[muted]text[/muted]` | Muted text |
| `[color=#ff00ff]text[/color]` | Custom hex color |
| `[small]text[/small]` | Smaller text |
| `[large]text[/large]` | Larger text |

Newlines in the message string are rendered as line breaks.

Custom colors are intentionally strict:

- Only `#RGB` and `#RRGGBB` values are recognized.
- Invalid color tags are rendered as literal text.
- CSS functions, variables, arbitrary named colors, and style strings are not interpreted.

## Options

```js
{
  variant: "default",
  durationMs: 4500
}
```

`durationMs` is clamped between `500` and `30000`.

Default durations:

| Type | Default Duration |
| --- | --- |
| Central | `3200ms` |
| Corner | `4500ms` |

## Examples

Central notification:

```js
vgr_send_notification(
  VGR_NOTIFICATION_TYPE.CENTRAL,
  "[large][gold]Quest Updated[/gold][/large]\nFind the old key.",
  { variant: "quest" }
);
```

Corner notification:

```js
vgr_send_notification(
  VGR_NOTIFICATION_TYPE.CORNER,
  "[b]Trade request sent[/b]\n[muted]Waiting for response[/muted]",
  { variant: "trade", durationMs: 4500 }
);
```

Error notification:

```js
vgr_send_notification(
  2,
  "[red][b]Access denied[/b][/red]\nYou do not have permission to open this.",
  { variant: "error" }
);
```

Success notification:

```js
vgr_send_notification(
  2,
  "[green]Bindings removed.[/green]",
  { variant: "success" }
);
```

Custom color notification:

```js
vgr_send_notification(
  2,
  "Rune color: [color=#7fd1ff]frost blue[/color]",
  { variant: "info" }
);
```

## Behavior

- Central notifications replace the current central notification.
- Corner notifications stack in the bottom-right corner.
- The corner stack keeps up to four visible notifications; older ones dismiss first.
- The notification layer is persistent in the gameplay layer and does not take pointer input.

## Migration Notes

Existing feature-specific toast functions can be migrated incrementally:

- Access control messages can use variant `access`.
- Trading messages can use variant `trade`.
- Admin feedback can use `success`, `warning`, or `error`.
- Important gameplay messages can use central type `1` with variant `quest`.
