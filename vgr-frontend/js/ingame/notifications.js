(function () {
  "use strict";

  const TYPE_CENTRAL = 1;
  const TYPE_CORNER = 2;
  const DEFAULT_CENTER_DURATION_MS = 3200;
  const DEFAULT_CORNER_DURATION_MS = 4500;
  const MAX_CORNER_NOTIFICATIONS = 4;
  const LEAVE_MS = 190;
  const VALID_VARIANTS = new Set([
    "default",
    "success",
    "warning",
    "error",
    "info",
    "quest",
    "trade",
    "access",
  ]);
  const HEX_COLOR_PATTERN = /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i;
  const FORMATTING_TAGS = new Set([
    "b",
    "i",
    "u",
    "gold",
    "red",
    "green",
    "blue",
    "white",
    "gray",
    "orange",
    "purple",
    "muted",
    "small",
    "large",
  ]);

  let centerTimer = null;

  function byId(id) {
    return document.getElementById(id);
  }

  function rootElement() {
    return byId("vgr-notifications");
  }

  function centerContainer() {
    return byId("vgr-notification-center");
  }

  function cornerContainer() {
    return byId("vgr-notification-corner");
  }

  function clampDuration(value, fallback) {
    const duration = Number(value);
    if (!Number.isFinite(duration)) return fallback;
    return Math.max(500, Math.min(30000, Math.floor(duration)));
  }

  function normalizeVariant(value) {
    const variant = String(value || "default").toLowerCase();
    return VALID_VARIANTS.has(variant) ? variant : "default";
  }

  function normalizeOptions(type, options) {
    const opts = options && typeof options === "object" ? options : {};
    const fallbackDuration = type === TYPE_CENTRAL ? DEFAULT_CENTER_DURATION_MS : DEFAULT_CORNER_DURATION_MS;
    return {
      durationMs: clampDuration(opts.durationMs, fallbackDuration),
      variant: normalizeVariant(opts.variant),
    };
  }

  function formattingNode(tag, color) {
    if (tag === "b") return document.createElement("strong");
    if (tag === "i") return document.createElement("em");
    const span = document.createElement("span");
    if (tag === "color") {
      span.style.color = color;
      return span;
    }
    span.className = "vgr-notification-token--" + tag;
    return span;
  }

  function appendText(parent, text) {
    if (!text) return;
    parent.appendChild(document.createTextNode(text));
  }

  function appendLineBreak(parent) {
    parent.appendChild(document.createElement("br"));
  }

  function closeFormattingTag(stack, tag, literal) {
    for (let i = stack.length - 1; i > 0; i--) {
      if (stack[i].tag === tag) {
        stack.length = i;
        return;
      }
    }
    appendText(stack[stack.length - 1].node, literal);
  }

  function renderMessage(message) {
    const fragment = document.createDocumentFragment();
    const stack = [{ tag: "", node: fragment }];
    const text = String(message || "");
    const tokenPattern =
      /\[color=(#[0-9a-f]{3}(?:[0-9a-f]{3})?)\]|\[\/color\]|\[(\/?)(b|i|u|gold|red|green|blue|white|gray|orange|purple|muted|small|large)\]|\n/gi;
    let cursor = 0;
    let match = tokenPattern.exec(text);

    while (match) {
      appendText(stack[stack.length - 1].node, text.slice(cursor, match.index));

      if (match[0] === "\n") {
        appendLineBreak(stack[stack.length - 1].node);
      } else if (match[1]) {
        const color = String(match[1]).toLowerCase();
        if (HEX_COLOR_PATTERN.test(color)) {
          const node = formattingNode("color", color);
          stack[stack.length - 1].node.appendChild(node);
          stack.push({ tag: "color", node });
        } else {
          appendText(stack[stack.length - 1].node, match[0]);
        }
      } else if (match[0].toLowerCase() === "[/color]") {
        closeFormattingTag(stack, "color", match[0]);
      } else {
        const closing = match[2] === "/";
        const tag = String(match[3] || "").toLowerCase();
        if (!FORMATTING_TAGS.has(tag)) {
          appendText(stack[stack.length - 1].node, match[0]);
        } else if (closing) {
          closeFormattingTag(stack, tag, match[0]);
        } else {
          const node = formattingNode(tag);
          stack[stack.length - 1].node.appendChild(node);
          stack.push({ tag, node });
        }
      }

      cursor = tokenPattern.lastIndex;
      match = tokenPattern.exec(text);
    }

    appendText(stack[stack.length - 1].node, text.slice(cursor));
    return fragment;
  }

  function notificationElement(type, message, options) {
    const node = document.createElement("div");
    const typeClass = type === TYPE_CENTRAL ? "central" : "corner";
    node.className = [
      "vgr-notification",
      "vgr-notification--" + typeClass,
      "vgr-notification--" + options.variant,
      "vgr-notification--enter",
    ].join(" ");
    node.setAttribute("role", "status");
    node.appendChild(renderMessage(message));
    return node;
  }

  function dismissNotification(node) {
    if (!node || node.dataset.dismissed === "true") return;
    node.dataset.dismissed = "true";
    node.classList.remove("vgr-notification--enter");
    node.classList.add("vgr-notification--leave");
    window.setTimeout(() => node.remove(), LEAVE_MS);
  }

  function showCentral(message, options) {
    const container = centerContainer();
    if (!container) return null;

    window.clearTimeout(centerTimer);
    Array.from(container.children).forEach((child) => dismissNotification(child));

    const node = notificationElement(TYPE_CENTRAL, message, options);
    container.appendChild(node);
    centerTimer = window.setTimeout(() => dismissNotification(node), options.durationMs);
    return node;
  }

  function showCorner(message, options) {
    const container = cornerContainer();
    if (!container) return null;

    const node = notificationElement(TYPE_CORNER, message, options);
    container.appendChild(node);

    const overflow = container.children.length - MAX_CORNER_NOTIFICATIONS;
    for (let i = 0; i < overflow; i++) {
      dismissNotification(container.children[i]);
    }

    window.setTimeout(() => dismissNotification(node), options.durationMs);
    return node;
  }

  function sendNotification(type, message, options) {
    if (!rootElement()) return null;
    const normalizedType = Number(type) === TYPE_CENTRAL ? TYPE_CENTRAL : TYPE_CORNER;
    const normalizedOptions = normalizeOptions(normalizedType, options);
    if (normalizedType === TYPE_CENTRAL) return showCentral(message, normalizedOptions);
    return showCorner(message, normalizedOptions);
  }

  window.VGR_NOTIFICATION_TYPE = {
    CENTRAL: TYPE_CENTRAL,
    CORNER: TYPE_CORNER,
  };

  window.vgr_send_notification = sendNotification;
  window.vgrSendNotification = sendNotification;
}());
