"use strict";

module.exports = (mp) => {
  const LOG = "[VGR activation]";
  const activation = require("./vgr_helpers").activation;

  if (mp.vgrActivationService && mp.vgrActivationService.installed) {
    return mp.vgrActivationService;
  }

  const blockers = [];
  const handlers = [];
  const defaultActivatePass = new Set();
  const fallbackOnActivate = typeof mp.onActivate === "function" ? mp.onActivate : null;
  let nextOrder = 0;

  function sortEntries(entries) {
    entries.sort((a, b) => a.priority - b.priority || a.order - b.order);
  }

  function unregisterEntry(entries, name) {
    const id = String(name || "").trim();
    if (!id) return false;
    const index = entries.findIndex((entry) => entry.name === id);
    if (index === -1) return false;
    entries.splice(index, 1);
    return true;
  }

  function registerEntry(entries, unregister, name, priority, fn) {
    const id = String(name || "").trim();
    if (!id || typeof fn !== "function") return () => false;

    unregister(id);
    entries.push({
      name: id,
      priority: Number.isFinite(Number(priority)) ? Number(priority) : 100,
      order: nextOrder++,
      fn,
    });
    sortEntries(entries);

    return () => unregister(id);
  }

  function unregisterActivationBlocker(name) {
    return unregisterEntry(blockers, name);
  }

  function registerActivationBlocker(name, priority, fn) {
    return registerEntry(blockers, unregisterActivationBlocker, name, priority, fn);
  }

  function unregisterActivateHandler(name) {
    return unregisterEntry(handlers, name);
  }

  function registerActivateHandler(name, priority, fn) {
    return registerEntry(handlers, unregisterActivateHandler, name, priority, fn);
  }

  function isActivationBlocked(targetFormId, actorFormId) {
    for (const blocker of blockers.slice()) {
      try {
        if (blocker.fn(targetFormId, actorFormId) === false) return true;
      } catch (e) {
        console.error(LOG, "blocker failed:", blocker.name, e && e.stack ? e.stack : e);
        return true;
      }
    }
    return false;
  }

  function runDefaultActivate(targetFormId, actorFormId) {
    const key = activation.activateKey(targetFormId, actorFormId);
    defaultActivatePass.add(key);
    try {
      mp.callPapyrusFunction("method", "ObjectReference", "Activate", activation.asForm(mp, targetFormId), [activation.asForm(mp, actorFormId), true]);
    } catch (e) {
      defaultActivatePass.delete(key);
      console.error(LOG, "default activation failed:", e && e.message ? e.message : e);
    }
  }

  mp.onActivate = (targetFormId, actorFormId) => {
    const key = activation.activateKey(targetFormId, actorFormId);
    if (defaultActivatePass.has(key)) {
      defaultActivatePass.delete(key);
      return fallbackOnActivate ? fallbackOnActivate(targetFormId, actorFormId) : true;
    }

    if (isActivationBlocked(targetFormId, actorFormId)) return false;

    for (const handler of handlers.slice()) {
      try {
        if (handler.fn(targetFormId, actorFormId) === false) return false;
      } catch (e) {
        console.error(LOG, "handler failed:", handler.name, e && e.stack ? e.stack : e);
        return false;
      }
    }

    return fallbackOnActivate ? fallbackOnActivate(targetFormId, actorFormId) : true;
  };

  const api = {
    installed: true,
    isActivationBlocked,
    registerActivationBlocker,
    registerActivateHandler,
    unregisterActivationBlocker,
    unregisterActivateHandler,
    runDefaultActivate,
    state() {
      return {
        blockers: blockers.map((entry) => ({ name: entry.name, priority: entry.priority })),
        handlers: handlers.map((entry) => ({ name: entry.name, priority: entry.priority })),
      };
    },
  };

  mp.vgrActivationService = api;
  mp.vgrIsActivationBlocked = isActivationBlocked;
  mp.vgrRegisterActivationBlocker = registerActivationBlocker;
  mp.vgrRegisterActivateHandler = registerActivateHandler;
  mp.vgrUnregisterActivationBlocker = unregisterActivationBlocker;
  mp.vgrUnregisterActivateHandler = unregisterActivateHandler;
  mp.vgrRunDefaultActivate = runDefaultActivate;

  if (typeof mp.makeEventSource === "function") {
    mp.makeEventSource("_vgrActivationService", `
      if (!ctx.state.vgrActivation) ctx.state.vgrActivation = {};

      ctx.state.vgrActivation.isRestrained = () => {
        return !!(ctx.state.vgrRestraint && ctx.state.vgrRestraint.active === true);
      };

      ctx.state.vgrActivation.notify = (message, variant) => {
        const text = String(message || "You cannot use that while restrained.");
        const style = String(variant || "warning");
        try {
          ctx.sp.browser.executeJavaScript(
            "window.vgr_send_notification?.(2, " + JSON.stringify(text) + ", { variant: " + JSON.stringify(style) + " })"
          );
        } catch (_) {}
      };

      ctx.state.vgrActivation.blockIfRestrained = (message, variant) => {
        if (!ctx.state.vgrActivation.isRestrained()) return false;
        ctx.state.vgrActivation.notify(message, variant);
        return true;
      };

      ctx.state.vgrActivation.blockAnimationIfRestrained = (animCtx, message, variant) => {
        if (!ctx.state.vgrActivation.blockIfRestrained(message, variant)) return false;
        if (animCtx) {
          try { animCtx.animEventName = ""; } catch (_) {}
        }
        return true;
      };
    `);
  }

  return api;
};
