(function () {
  "use strict";

  const state = {
    sessionId: null,
    selectedIndex: 0,
    pending: false,
    pendingTimer: null,
    tradeRequestId: null,
    tradeMode: null,
    countdownTimer: null,
    toastTimer: null,
    anchor: null,
    anchorLocked: false,
  };

  // Matches the injected client fallback when the target head is off-screen
  const ANCHOR_FALLBACK = { x: 0.56, y: 0.5 };
  const ANCHOR_OFFSET_X = 12;
  const ANCHOR_MARGIN = 8;
  const PENDING_WATCHDOG_MS = 10000;

  const els = {};

  function byId(id) {
    return document.getElementById(id);
  }

  function cache() {
    els.prompt = byId("vgr-player-prompt");
    els.promptKey = byId("playerPromptKey");
    els.promptName = byId("playerPromptName");
    els.menu = byId("vgr-player-interaction");
    els.menuTitle = byId("playerInteractionTitle");
    els.menuName = byId("playerInteractionName");
    els.actions = byId("playerInteractionActions");
    els.pending = byId("playerInteractionPending");
    els.close = byId("playerInteractionClose");
    els.trade = byId("vgr-trade-request");
    els.tradeTitle = byId("tradeRequestTitle");
    els.tradeName = byId("tradeRequestName");
    els.tradeMessage = byId("tradeRequestMessage");
    els.tradeCountdown = byId("tradeRequestCountdown");
    els.tradeActions = byId("tradeRequestActions");
    els.tradeClose = byId("tradeRequestClose");
    els.toast = byId("playerInteractionToast");
    if (!els.toast && els.menu && els.menu.parentElement) {
      // The rolled-back markup lacks the toast node; create it so toasts render
      const toast = document.createElement("div");
      toast.id = "playerInteractionToast";
      toast.className = "player-interaction-toast";
      els.menu.parentElement.appendChild(toast);
      els.toast = toast;
    }
  }

  function send(name, payload) {
    window.skyrimPlatform?.sendMessage?.(name, payload || {});
  }

  function setPanelVisible(el, visible) {
    if (!el) return;
    el.hidden = !visible;
    el.classList.toggle("visible", visible);
    el.setAttribute("aria-hidden", visible ? "false" : "true");
  }

  function hidePrompt() {
    if (!els.prompt) return;
    els.prompt.hidden = true;
    if (els.promptName) {
      els.promptName.textContent = "";
      els.promptName.hidden = true;
    }
  }

  function showPrompt(data) {
    if (!els.prompt || isBlockingUiVisible()) return;
    els.promptKey.textContent = data.prompt || "(X) MENU";
    const showName = data.showTargetName !== false && !!String(data.targetName || "").trim();
    if (els.promptName) {
      els.promptName.textContent = showName ? data.targetName : "";
      els.promptName.hidden = !showName;
    }
    els.prompt.hidden = false;
  }

  function isBlockingUiVisible() {
    return (els.menu && !els.menu.hidden) || (els.trade && !els.trade.hidden);
  }

  function showToast(message) {
    if (!els.toast) return;
    els.toast.textContent = String(message || "");
    els.toast.classList.add("visible");
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => els.toast.classList.remove("visible"), 2200);
  }

  function setPending(text) {
    state.pending = !!text;
    if (els.pending) els.pending.textContent = text || "";
    clearTimeout(state.pendingTimer);
    state.pendingTimer = null;
    // Watchdog: never let a lost server reply brick the menu in a pending state
    if (state.pending) {
      state.pendingTimer = setTimeout(() => setPending(""), PENDING_WATCHDOG_MS);
    }
  }

  function closeMenu(sendClose) {
    state.sessionId = null;
    state.anchor = null;
    state.anchorLocked = false;
    setPending("");
    setPanelVisible(els.menu, false);
    if (sendClose) send("vgr:playerInteraction:close", {});
  }

  function closeTradeRequest(response) {
    const requestId = state.tradeRequestId;
    const mode = state.tradeMode;
    state.tradeRequestId = null;
    state.tradeMode = null;
    clearInterval(state.countdownTimer);
    state.countdownTimer = null;
    setPanelVisible(els.trade, false);
    if (response && requestId) {
      send("vgr:tradeRequest:respond", {
        requestId,
        response: response === "cancel" && mode !== "outgoing" ? "deny" : response,
      });
    }
  }

  function makeButton(label, className, onClick, disabled) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.disabled = !!disabled;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      if (button.disabled || state.pending) return;
      onClick();
    });
    button.textContent = label;
    return button;
  }

  function renderMenu(data) {
    hidePrompt();
    state.sessionId = data.sessionId || null;
    state.selectedIndex = 0;
    setPending("");
    els.menuTitle.textContent = "PLAYER INTERACTION";
    els.menuName.textContent = data.targetName || "STRANGER";
    els.actions.textContent = "";

    const actions = Array.isArray(data.actions) ? data.actions : [];
    actions.forEach((action, index) => {
      const button = makeButton(action.label || action.id, "player-interaction-button", () => {
        state.selectedIndex = index;
        setPending("Pending...");
        send("vgr:playerInteraction:select", {
          sessionId: state.sessionId,
          actionId: action.id,
        });
      }, action.enabled !== true);
      if (index === state.selectedIndex) button.classList.add("selected");
      if (action.reason) {
        const reason = document.createElement("span");
        reason.className = "player-interaction-reason";
        reason.textContent = action.reason;
        button.appendChild(reason);
      }
      els.actions.appendChild(button);
    });

    setPanelVisible(els.menu, true);
    state.anchorLocked = false;
    applyAnchor();
    if (data.toastMessage) showToast(data.toastMessage);
    focusSelectedAction();
  }

  function renderBindOptions(data) {
    hidePrompt();
    state.sessionId = data.sessionId || state.sessionId;
    setPending("");
    els.menuTitle.textContent = "USE BINDS";
    els.menuName.textContent = data.targetName || "STRANGER";
    els.actions.textContent = "";
    const list = document.createElement("div");
    list.className = "bind-option-list";
    (Array.isArray(data.options) ? data.options : []).forEach((option) => {
      const label = `${option.label || "Prisoner's Cuffs"} x${Number(option.count || 0)}`;
      list.appendChild(makeButton(label, "bind-option-button", () => {
        setPending("Applying bindings...");
        send("vgr:playerInteraction:bindVariant", {
          sessionId: state.sessionId,
          baseId: option.baseId,
        });
      }));
    });
    list.appendChild(makeButton("Back", "trade-request-button secondary", () => closeMenu(true)));
    els.actions.appendChild(list);
    setPanelVisible(els.menu, true);
    state.anchorLocked = false;
    applyAnchor();
    focusSelectedAction();
  }

  // Anchored quickloot-style placement: normalized coords in, clamped px out
  function applyAnchor() {
    if (!els.menu || els.menu.hidden) return;
    const anchor = state.anchor || ANCHOR_FALLBACK;
    const vw = window.innerWidth || 1280;
    const vh = window.innerHeight || 720;
    const width = els.menu.offsetWidth || 240;
    const height = els.menu.offsetHeight || 180;
    let left = anchor.x * vw + ANCHOR_OFFSET_X;
    let top = anchor.y * vh - height / 2;
    left = Math.max(ANCHOR_MARGIN, Math.min(left, vw - width - ANCHOR_MARGIN));
    top = Math.max(ANCHOR_MARGIN, Math.min(top, vh - height - ANCHOR_MARGIN));
    els.menu.style.left = left + "px";
    els.menu.style.top = top + "px";
  }

  function setAnchor(anchor) {
    const x = Number(anchor && anchor.x);
    const y = Number(anchor && anchor.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    state.anchor = { x, y };
    // Place the panel at the target once per open; it must not follow them around
    if (state.anchorLocked) return;
    applyAnchor();
    if (els.menu && !els.menu.hidden) state.anchorLocked = true;
  }

  function focusSelectedAction() {
    const buttons = Array.from(els.actions.querySelectorAll("button:not(:disabled)"));
    if (!buttons.length) return;
    const index = Math.min(Math.max(state.selectedIndex, 0), buttons.length - 1);
    window.setTimeout(() => buttons[index].focus(), 0);
  }

  function moveSelection(delta) {
    const buttons = Array.from(els.actions.querySelectorAll(".player-interaction-button"));
    if (!buttons.length) return;
    let index = state.selectedIndex;
    for (let i = 0; i < buttons.length; i++) {
      index = (index + delta + buttons.length) % buttons.length;
      if (!buttons[index].disabled) break;
    }
    buttons.forEach((button) => button.classList.remove("selected"));
    state.selectedIndex = index;
    buttons[index].classList.add("selected");
    buttons[index].focus();
  }

  function renderTradeRequest(data) {
    hidePrompt();
    state.tradeRequestId = data.requestId || null;
    state.tradeMode = data.mode || "incoming";
    clearInterval(state.countdownTimer);
    els.tradeTitle.textContent = data.title || "TRADE REQUEST";
    els.tradeName.textContent = data.requesterName || data.partnerName || "";
    els.tradeMessage.textContent = data.message || "";
    els.tradeActions.textContent = "";

    if (state.tradeMode === "incoming") {
      els.tradeActions.appendChild(makeButton("Accept", "trade-request-button", () => closeTradeRequest("accept")));
      els.tradeActions.appendChild(makeButton("Deny", "trade-request-button secondary", () => closeTradeRequest("deny")));
    } else {
      els.tradeActions.appendChild(makeButton("Cancel", "trade-request-button secondary", () => closeTradeRequest("cancel")));
    }

    setPanelVisible(els.trade, true);
    updateCountdown(data.expiresAt);
    state.countdownTimer = setInterval(() => updateCountdown(data.expiresAt), 500);
    const first = els.tradeActions.querySelector("button");
    if (first) window.setTimeout(() => first.focus(), 0);
  }

  function updateCountdown(expiresAt) {
    if (!els.tradeCountdown) return;
    const remaining = Math.max(0, Math.ceil((Number(expiresAt || 0) - Date.now()) / 1000));
    els.tradeCountdown.textContent = remaining > 0 ? `${remaining}s remaining` : "Expired";
    if (remaining <= 0) {
      clearInterval(state.countdownTimer);
      state.countdownTimer = null;
    }
  }

  function applyServerUpdate(data) {
    if (!data || data.version !== 1) return;
    // Batched pushes: the server coalesces same-tick actions so none get lost
    // to property-write races; apply them in order.
    if (Array.isArray(data.batch)) {
      data.batch.forEach(applyAction);
      return;
    }
    applyAction(data);
  }

  function applyAction(data) {
    if (!data) return;
    if (data.action === "prompt") return showPrompt(data);
    if (data.action === "promptClear") return hidePrompt();
    if (data.action === "toast") {
      // A toast is a terminal server reply; always release the pending lock
      setPending("");
      return showToast(data.message);
    }
    if (data.action === "open") return renderMenu(data);
    if (data.action === "bindOptions") return renderBindOptions(data);
    if (data.action === "tradeRequest") return renderTradeRequest(data);
    if (data.action === "close") {
      if (data.ui === "trade_request") return closeTradeRequest(null);
      return closeMenu(false);
    }
  }

  function onMenuKeyDown(event) {
    if (!els.menu || els.menu.hidden) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu(true);
      return;
    }
    if (event.key === "ArrowDown" || event.key.toLowerCase() === "s") {
      event.preventDefault();
      moveSelection(1);
      return;
    }
    if (event.key === "ArrowUp" || event.key.toLowerCase() === "w") {
      event.preventDefault();
      moveSelection(-1);
      return;
    }
    if (event.key === "Enter") {
      const selected = els.actions.querySelector(".player-interaction-button.selected:not(:disabled)");
      if (selected) {
        event.preventDefault();
        selected.click();
      }
    }
  }

  function onTradeKeyDown(event) {
    if (!els.trade || els.trade.hidden) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeTradeRequest(state.tradeMode === "outgoing" ? "cancel" : "deny");
    }
  }

  function init() {
    cache();
    els.close?.addEventListener("click", () => closeMenu(true));
    els.tradeClose?.addEventListener("click", () => closeTradeRequest(state.tradeMode === "outgoing" ? "cancel" : "deny"));
    document.addEventListener("keydown", onMenuKeyDown);
    document.addEventListener("keydown", onTradeKeyDown);
    window.addEventListener("resize", applyAnchor);

    window.addEventListener("vgr:ui_manager:open:player_interaction", () => setPanelVisible(els.menu, true));
    window.addEventListener("vgr:ui_manager:close:player_interaction", () => setPanelVisible(els.menu, false));
    window.addEventListener("vgr:ui_manager:open:trade_request", () => setPanelVisible(els.trade, true));
    window.addEventListener("vgr:ui_manager:close:trade_request", () => setPanelVisible(els.trade, false));
  }

  window.vgrPlayerInteractionUpdate = applyServerUpdate;
  window.vgrPlayerInteractionAnchor = setAnchor;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
