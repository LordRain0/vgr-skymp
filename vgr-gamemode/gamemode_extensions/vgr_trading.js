module.exports = (mp) => {
  const crypto = require("crypto");
  const vgrHelpers = require("./vgr_helpers");
  const tradeHelpers = vgrHelpers.trade;
  const {
    VGR_GOLD_BASE_ID,
    finalizeTrade,
    normalizeOffer,
    getItemCount,
    isTradableEntry,
  } = tradeHelpers;

  const LOG_TRADING = "[VGR trading]";
  const VGR_TRADE_TIMEOUT_MS = 5 * 60 * 1000;

  let settings = {};
  try {
    settings = mp.getServerSettings ? mp.getServerSettings() : {};
  } catch (e) {
    console.error(LOG_TRADING, "failed to read server settings:", e && e.message ? e.message : e);
  }

  const legacyInteractionConfig = settings.vgrPlayerInteractions || {};
  const config = Object.assign({}, legacyInteractionConfig, settings.vgrTrading || {});
  const TRADE_REQUESTS_ENABLED = config.tradeRequestsEnabled !== false;
  const TRADE_REQUEST_TTL_MS = Math.max(3000, Number(config.tradeRequestTtlMs) || 15000);
  const TRADE_REQUEST_COOLDOWN_MS = Math.max(0, Number(config.tradeRequestCooldownMs) || 5000);

  // Dev: offline partner reference for single-client debug testing.
  // formDesc is the MongoDB changeForms key (e.g. "1", "b") — NOT profileId.
  // runtimeFormId is only used when that actor is actually loaded in SkyMP memory.
  const VGR_TRADING_DEV = false;
  const DEBUG_PARTNER_FORM_DESC = "1";
  const DEBUG_PARTNER_DISPLAY_NAME = "Character 1 (offline)";
  const DEBUG_PARTNER_RUNTIME_FORM_ID = null;
  const DEBUG_PARTNER_OFFER = [{ baseId: VGR_GOLD_BASE_ID, count: 20 }];

  const vgrTradeSessions = new Map();
  const vgrPlayerTrade = new Map();
  const pendingTradeRequests = new Map();
  const incomingTradeByActor = new Map();
  const outgoingTradeByActor = new Map();
  const lastTradeRequestAt = new Map();
  let vgrTradingUiSeq = 0;
  const actors = vgrHelpers.playerInteractions.createActorHelpers(mp, {});

  const vgrMakeTradeId = () => "trade_" + Date.now() + "_" + crypto.randomBytes(9).toString("base64url");

  const sendTradingUI = (pcFormId, eventName, payload) => {
    if (!actors.exists(pcFormId)) return;
    const event = String(eventName || "");
    if (!event) return;
    try {
      mp.set(pcFormId, "vgrTradingUI", {
        seq: ++vgrTradingUiSeq,
        event: event,
        payload: payload == null ? null : payload,
      });
    } catch (e) {
      console.warn(LOG_TRADING, "failed to send trading UI event:", event, e && e.message ? e.message : e);
      return;
    }
    if (typeof mp.vgrOpenUI === "function" && (event === "snapshot" || event === "tradeRequest")) {
      mp.vgrOpenUI(pcFormId, event === "tradeRequest" ? "trade_request" : "trading");
    }
    if (typeof mp.vgrCloseUI === "function" && (event === "sessionClosed" || event === "tradeRequestEnded")) {
      mp.vgrCloseUI(pcFormId, event === "tradeRequestEnded" ? "trade_request" : "trading");
    }
  };

  const vgrNotifyActor = (pcFormId, message) => {
    if (typeof mp.vgrSendNotification === "function") {
      mp.vgrSendNotification(pcFormId, 2, String(message || ""), { variant: "trade" });
    }
  };

  const vgrVisibleName = (viewer, target) => {
    const api = mp._vgrNameplatesApi || null;
    if (api && typeof api.getVisibleName === "function") return api.getVisibleName(viewer, target);
    return "Stranger";
  };

  const vgrMapEspmType = (record) => {
    if (!record || !record.type) return "misc";
    const t = String(record.type).toUpperCase();
    if (t.indexOf("WEAP") !== -1) return "weapon";
    if (t.indexOf("ARMO") !== -1 || t.indexOf("ARMA") !== -1) return "armor";
    if (t.indexOf("ALCH") !== -1) return "potion";
    if (t.indexOf("INGR") !== -1) return "material";
    if (t.indexOf("MISC") !== -1) return "misc";
    return "misc";
  };

  const vgrEnrichItem = (entry) => {
    const baseId = entry.baseId;
    if (!baseId || baseId <= 0) return null;
    let name = "Item " + baseId.toString(16);
    let type = "misc";
    let description = "";

    try {
      const lookup = mp.lookupEspmRecordById(baseId);
      if (lookup && lookup.record) {
        if (lookup.record.fullName) name = String(lookup.record.fullName);
        else if (lookup.record.editorId) name = String(lookup.record.editorId);
        type = vgrMapEspmType(lookup.record);
      }
    } catch (e) { }

    return {
      id: String(baseId),
      name: name,
      type: type,
      qty: Number(entry.count) || 0,
      value: 0,
      weight: 0,
      description: description,
      baseId: baseId,
    };
  };

  const vgrSplitInventory = (inv) => {
    const entries = Array.isArray(inv.entries) ? inv.entries : [];
    let gold = 0;
    const items = [];

    for (const entry of entries) {
      if (!entry || typeof entry.baseId !== "number" || entry.baseId <= 0) continue;
      if (!isTradableEntry(entry)) continue;
      if (entry.baseId === VGR_GOLD_BASE_ID) {
        gold += Number(entry.count) || 0;
        continue;
      }
      const enriched = vgrEnrichItem(entry);
      if (enriched) items.push(enriched);
    }

    return { gold, items };
  };

  const vgrOfferToUiItems = (offer) => {
    return normalizeOffer(offer)
      .map((item) => vgrEnrichItem(item))
      .filter((item) => item != null);
  };

  const vgrGetGoldInOffer = (offer) => {
    const stack = normalizeOffer(offer).find((e) => e.baseId === VGR_GOLD_BASE_ID);
    return stack ? stack.count : 0;
  };

  const vgrSetGoldInOffer = (offer, gold) => {
    const next = normalizeOffer(offer).filter((e) => e.baseId !== VGR_GOLD_BASE_ID);
    const amount = Math.max(0, Math.floor(Number(gold) || 0));
    if (amount > 0) next.push({ baseId: VGR_GOLD_BASE_ID, count: amount });
    return next;
  };

  const vgrOpenOfflineDebugTrade = (pcFormId) => {
    const partnerId =
      DEBUG_PARTNER_RUNTIME_FORM_ID && actors.exists(DEBUG_PARTNER_RUNTIME_FORM_ID)
        ? DEBUG_PARTNER_RUNTIME_FORM_ID
        : null;
    let session = vgrCreateSession(pcFormId, partnerId, {
      partnerDisplayName: DEBUG_PARTNER_DISPLAY_NAME,
      partnerOffline: !partnerId,
      skipInitialPush: true,
    });
    if (!session) {
      const existing = vgrPlayerTrade.get(pcFormId);
      if (existing) session = vgrTradeSessions.get(existing);
    }
    if (session) {
      session.offerB = DEBUG_PARTNER_OFFER.map((e) => ({ ...e }));
      session.acceptedA = false;
      session.acceptedB = false;
      session.partnerDisplayName = DEBUG_PARTNER_DISPLAY_NAME;
      vgrPushBoth(session, "snapshot");
    }
    return session;
  };

  const vgrCloseTradingUi = (pcFormId, reason) => {
    sendTradingUI(pcFormId, "sessionClosed", { reason: reason || "" });
  };

  const vgrClearSession = (tradeId, reason) => {
    const session = vgrTradeSessions.get(tradeId);
    if (!session) return;

    if (session.timeout) clearTimeout(session.timeout);

    if (session.playerA) vgrCloseTradingUi(session.playerA, reason);
    if (session.playerB) vgrCloseTradingUi(session.playerB, reason);
	
    if (session.playerA) vgrPlayerTrade.delete(session.playerA);
    if (session.playerB) vgrPlayerTrade.delete(session.playerB);
    vgrTradeSessions.delete(tradeId);

    console.log(LOG_TRADING, "session cleared:", tradeId, reason || "");
  };

  const vgrResetAccept = (session) => {
    session.acceptedA = false;
    session.acceptedB = false;
    session.updatedAt = Date.now();
  };

  const vgrSubtractOfferFromItems = (items, offer) => {
    const offered = {};
    for (const o of normalizeOffer(offer)) {
      offered[o.baseId] = (offered[o.baseId] || 0) + o.count;
    }
    return items
      .map((item) => {
        const baseId = item.baseId != null ? item.baseId : Number(item.id);
        const take = offered[baseId] || 0;
        return { ...item, qty: Math.max(0, item.qty - take) };
      })
      .filter((item) => item.qty > 0);
  };

  const vgrBuildUiPayload = (session, pcFormId) => {
    const isA = pcFormId === session.playerA;
    const selfOffer = isA ? session.offerA : session.offerB;
    const otherOffer = isA ? session.offerB : session.offerA;
    const selfAccepted = isA ? session.acceptedA : session.acceptedB;
    const partnerAccepted = isA ? session.acceptedB : session.acceptedA;
    const partnerId = session.partnerOffline
      ? null
      : isA
        ? session.playerB
        : session.playerA;

    const selfInv = vgrSplitInventory(actors.inventory(pcFormId));
    const partnerOnline = partnerId != null && actors.exists(partnerId);
    const partnerInv = partnerOnline
      ? vgrSplitInventory(actors.inventory(partnerId))
      : { gold: 0, items: [] };
    const selfGoldOffer = vgrGetGoldInOffer(selfOffer);
    const partnerDisplayName = session.visibleNames && session.visibleNames[pcFormId]
      ? session.visibleNames[pcFormId]
      : session.partnerDisplayName || "Trade Partner";

    return {
      tradeId: session.id,
      playerName: actors.displayName(pcFormId, "Adventurer"),
      partnerName: partnerDisplayName,
      playerGold: Math.max(0, selfInv.gold - selfGoldOffer),
      partnerGold: partnerInv.gold,
      playerItems: vgrSubtractOfferFromItems(selfInv.items, selfOffer),
      playerOffer: vgrOfferToUiItems(selfOffer),
      partnerOffer: vgrOfferToUiItems(otherOffer),
      partnerGoldOffer: vgrGetGoldInOffer(otherOffer),
      playerGoldOffer: selfGoldOffer,
      selfAccepted: selfAccepted,
      partnerAccepted: partnerAccepted,
    };
  };

  const vgrPushUi = (pcFormId, extra) => {
    if (!actors.exists(pcFormId)) return;
    try {
      const tradeId = vgrPlayerTrade.get(pcFormId);
      if (!tradeId) {
        if (extra && extra.action === "close") vgrCloseTradingUi(pcFormId, extra.reason || "");
        return;
      }

      const session = vgrTradeSessions.get(tradeId);
      if (!session) return;

      const action = (extra && extra.action) || "update";
      const payload = vgrBuildUiPayload(session, pcFormId);
      sendTradingUI(pcFormId, action, payload);
    } catch (e) {
      console.error(LOG_TRADING, "pushUi failed:", e);
    }
  };

  const vgrPushBoth = (session, action) => {
    vgrPushUi(session.playerA, { action: action });
    if (session.playerB && actors.exists(session.playerB)) {
      vgrPushUi(session.playerB, { action: action });
    }
  };

  const vgrTradeRequestId = () => "trade_req_" + Date.now() + "_" + crypto.randomBytes(9).toString("base64url");

  const vgrCanRequestTrade = (requesterPcFormId, targetPcFormId) => {
    const requester = Number(requesterPcFormId);
    const target = Number(targetPcFormId);
    if (!TRADE_REQUESTS_ENABLED) return { ok: false, reasonCode: "service_unavailable", reason: "Trade requests are disabled." };
    if (!Number.isInteger(requester) || !Number.isInteger(target) || requester <= 0 || target <= 0) {
      return { ok: false, reasonCode: "player_busy", reason: "That player is no longer available." };
    }
    if (requester === target) return { ok: false, reasonCode: "player_busy", reason: "You cannot trade with yourself." };
    if (!actors.exists(requester) || !actors.exists(target)) {
      return { ok: false, reasonCode: "player_busy", reason: "That player is no longer available." };
    }
    if (vgrPlayerTrade.has(requester) || vgrPlayerTrade.has(target)) {
      return { ok: false, reasonCode: "player_busy", reason: "That player is busy." };
    }
    if (
      incomingTradeByActor.has(requester) ||
      outgoingTradeByActor.has(requester) ||
      incomingTradeByActor.has(target) ||
      outgoingTradeByActor.has(target)
    ) {
      return { ok: false, reasonCode: "player_busy", reason: "That player is busy." };
    }
    const last = lastTradeRequestAt.get(requester) || 0;
    if (Date.now() - last < TRADE_REQUEST_COOLDOWN_MS) {
      return { ok: false, reasonCode: "player_busy", reason: "Trade request cooldown." };
    }
    return { ok: true, reasonCode: "" };
  };

  const vgrCloseTradeRequestUi = (request) => {
    if (!request) return;
    sendTradingUI(request.requesterPcFormId, "tradeRequestEnded");
    sendTradingUI(request.targetPcFormId, "tradeRequestEnded");
  };

  const vgrRemoveTradeRequest = (request, closeUi) => {
    if (!request || request.consumed) return;
    request.consumed = true;
    if (request.timeout) clearTimeout(request.timeout);
    pendingTradeRequests.delete(request.id);
    incomingTradeByActor.delete(request.targetPcFormId);
    outgoingTradeByActor.delete(request.requesterPcFormId);
    if (closeUi !== false) vgrCloseTradeRequestUi(request);
  };

  const vgrExpireTradeRequest = (id) => {
    const request = pendingTradeRequests.get(id);
    if (!request || request.consumed) return;
    vgrRemoveTradeRequest(request, true);
    vgrNotifyActor(request.requesterPcFormId, "Trade request expired.");
    vgrNotifyActor(request.targetPcFormId, "Trade request expired.");
  };

  const vgrRequestTrade = (requesterPcFormId, targetPcFormId, context) => {
    const check = vgrCanRequestTrade(requesterPcFormId, targetPcFormId);
    if (!check.ok) return check;

    const requester = Number(requesterPcFormId);
    const target = Number(targetPcFormId);
    const ctx = context || {};
    const requesterIdentity = ctx.requesterIdentity || null;
    const targetIdentity = ctx.targetIdentity || null;
    const visibleNames = ctx.visibleNames || {};
    const requesterSeesTarget = visibleNames[requester] || vgrVisibleName(requesterIdentity, targetIdentity);
    const targetSeesRequester = visibleNames[target] || vgrVisibleName(targetIdentity, requesterIdentity);
    const id = vgrTradeRequestId();
    const request = {
      id,
      requesterPcFormId: requester,
      targetPcFormId: target,
      requesterIdentity,
      targetIdentity,
      visibleNames: {
        [requester]: requesterSeesTarget,
        [target]: targetSeesRequester,
      },
      createdAt: Date.now(),
      expiresAt: Date.now() + TRADE_REQUEST_TTL_MS,
      consumed: false,
      timeout: null,
    };
    request.timeout = setTimeout(() => vgrExpireTradeRequest(id), TRADE_REQUEST_TTL_MS + 250);

    pendingTradeRequests.set(id, request);
    incomingTradeByActor.set(target, id);
    outgoingTradeByActor.set(requester, id);
    lastTradeRequestAt.set(requester, Date.now());

    sendTradingUI(requester, "tradeRequest", {
      mode: "outgoing",
      requestId: id,
      partnerName: requesterSeesTarget,
      expiresAt: request.expiresAt,
    });
    sendTradingUI(target, "tradeRequest", {
      mode: "incoming",
      requestId: id,
      requesterName: targetSeesRequester,
      expiresAt: request.expiresAt,
    });
    return { ok: true, requestId: id };
  };

  const vgrActorRestrained = (pcFormId) => {
    try {
      return !!(mp._vgrPlayerInteractionsApi &&
        typeof mp._vgrPlayerInteractionsApi.isRestrained === "function" &&
        mp._vgrPlayerInteractionsApi.isRestrained(pcFormId));
    } catch (e) {
      return false;
    }
  };

  const vgrRespondTradeRequest = (pcFormId, payload) => {
    const id = payload && payload.requestId;
    const response = String((payload && payload.response) || "").toLowerCase();
    const request = pendingTradeRequests.get(id);
    if (!request || request.consumed) {
      vgrNotifyActor(pcFormId, "Trade request expired.");
      return;
    }
    if (Date.now() > request.expiresAt) {
      vgrExpireTradeRequest(id);
      return;
    }

    if (response === "cancel") {
      if (pcFormId !== request.requesterPcFormId) return;
      vgrRemoveTradeRequest(request, true);
      vgrNotifyActor(request.targetPcFormId, "Trade request denied.");
      return;
    }

    if (pcFormId !== request.targetPcFormId) return;

    if (response !== "accept") {
      vgrRemoveTradeRequest(request, true);
      vgrNotifyActor(request.requesterPcFormId, "Trade request denied.");
      return;
    }

    if (
      !actors.exists(request.requesterPcFormId) ||
      !actors.exists(request.targetPcFormId) ||
      vgrPlayerTrade.has(request.requesterPcFormId) ||
      vgrPlayerTrade.has(request.targetPcFormId) ||
      vgrActorRestrained(request.requesterPcFormId) ||
      vgrActorRestrained(request.targetPcFormId)
    ) {
      vgrRemoveTradeRequest(request, true);
      vgrNotifyActor(request.requesterPcFormId, "That player is no longer available.");
      vgrNotifyActor(request.targetPcFormId, "That player is no longer available.");
      return;
    }

    vgrRemoveTradeRequest(request, true);
    const opened = vgrCreateSession(request.requesterPcFormId, request.targetPcFormId, {
      partnerDisplayName: request.visibleNames[request.requesterPcFormId],
      visibleNames: request.visibleNames,
    });
    if (!opened) {
      vgrNotifyActor(request.requesterPcFormId, "That player is busy.");
      vgrNotifyActor(request.targetPcFormId, "That player is busy.");
      return;
    }

    vgrNotifyActor(request.requesterPcFormId, "Trade request accepted.");
    vgrNotifyActor(request.targetPcFormId, "Trade request accepted.");
  };

  const vgrCancelRequestsForActor = (pcFormId) => {
    const ids = new Set();
    const incoming = incomingTradeByActor.get(Number(pcFormId));
    const outgoing = outgoingTradeByActor.get(Number(pcFormId));
    if (incoming) ids.add(incoming);
    if (outgoing) ids.add(outgoing);
    for (const id of ids) {
      const request = pendingTradeRequests.get(id);
      if (!request) continue;
      vgrRemoveTradeRequest(request, true);
      const other = request.requesterPcFormId === Number(pcFormId) ? request.targetPcFormId : request.requesterPcFormId;
      vgrNotifyActor(other, "Trade request denied.");
    }
  };

  const vgrStartTimeout = (session) => {
    if (session.timeout) clearTimeout(session.timeout);
    session.timeout = setTimeout(() => {
      vgrClearSession(session.id, "timeout");
    }, VGR_TRADE_TIMEOUT_MS);
  };

  const vgrCreateSession = (playerA, playerB, options) => {
    const opts = options || {};
    if (vgrPlayerTrade.has(playerA)) return null;
    if (playerB && actors.exists(playerB) && vgrPlayerTrade.has(playerB)) return null;

    const tradeId = vgrMakeTradeId();
    const partnerOffline = !!(opts.partnerOffline || !playerB || !actors.exists(playerB));
    const session = {
      id: tradeId,
      playerA: playerA,
      playerB: partnerOffline ? null : playerB,
      partnerDisplayName: opts.partnerDisplayName || "Trade Partner",
      visibleNames: opts.visibleNames || null,
      partnerOffline: partnerOffline,
      offerA: [],
      offerB: [],
      acceptedA: false,
      acceptedB: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      timeout: null,
    };

    vgrTradeSessions.set(tradeId, session);
    vgrPlayerTrade.set(playerA, tradeId);
    if (playerB && actors.exists(playerB)) {
      vgrPlayerTrade.set(playerB, tradeId);
    }
    vgrStartTimeout(session);

    if (!opts.skipInitialPush) {
      vgrPushBoth(session, "snapshot");
    }
    console.log(
      LOG_TRADING,
      "session created:",
      tradeId,
      "playerA=" + playerA,
      "playerB=" + session.playerB,
      session.partnerOffline ? "(partner offline)" : ""
    );
    return session;
  };

  const vgrAddToOffer = (session, pcFormId, baseId, count) => {
    const isA = pcFormId === session.playerA;
    const offerKey = isA ? "offerA" : "offerB";
    const inv = actors.inventory(pcFormId);
    const amount = Math.max(1, Math.floor(Number(count) || 1));

    if (baseId === VGR_GOLD_BASE_ID) return false;
    if (getItemCount(inv, baseId) < amount) return false;

    const offer = normalizeOffer(session[offerKey]);
    const existing = offer.find((e) => e.baseId === baseId);
    const alreadyOffered = existing ? existing.count : 0;
    if (getItemCount(inv, baseId) < alreadyOffered + amount) return false;

    if (existing) {
      existing.count += amount;
    } else {
      offer.push({ baseId: baseId, count: amount });
    }

    session[offerKey] = offer;
    vgrResetAccept(session);
    return true;
  };

  const vgrRemoveFromOffer = (session, pcFormId, baseId, count) => {
    const isA = pcFormId === session.playerA;
    const offerKey = isA ? "offerA" : "offerB";
    const amount = Math.max(1, Math.floor(Number(count) || 1));
    const offer = normalizeOffer(session[offerKey]);
    const idx = offer.findIndex((e) => e.baseId === baseId);
    if (idx === -1) return false;

    offer[idx].count -= amount;
    if (offer[idx].count <= 0) offer.splice(idx, 1);
    session[offerKey] = offer;
    vgrResetAccept(session);
    return true;
  };

  const vgrClearOffer = (session, pcFormId) => {
    const isA = pcFormId === session.playerA;
    session[isA ? "offerA" : "offerB"] = [];
    vgrResetAccept(session);
  };

  const vgrSetOfferGold = (session, pcFormId, gold) => {
    const isA = pcFormId === session.playerA;
    const offerKey = isA ? "offerA" : "offerB";
    const inv = actors.inventory(pcFormId);
    const maxGold = getItemCount(inv, VGR_GOLD_BASE_ID);
    const amount = Math.max(0, Math.min(Math.floor(Number(gold) || 0), maxGold));
    session[offerKey] = vgrSetGoldInOffer(session[offerKey], amount);
    vgrResetAccept(session);
  };

  const vgrTryFinalize = (session) => {
    if (!session.acceptedA || !session.acceptedB) return false;
    if (session.partnerOffline || !actors.exists(session.playerB)) {
      console.error(
        LOG_TRADING,
        "cannot finalize: partner offline (formDesc " +
        DEBUG_PARTNER_FORM_DESC +
        "). Use tools/debug-force-trade.js instead."
      );
      vgrResetAccept(session);
      vgrPushBoth(session, "update");
      return false;
    }

    const invA = actors.inventory(session.playerA);
    const invB = actors.inventory(session.playerB);

    try {
      const result = finalizeTrade(invA, invB, session.offerA, session.offerB);
      if (!actors.setInventory(session.playerA, result.invA)) {
        throw new Error("Could not write inventory for actor " + session.playerA);
      }
      if (!actors.setInventory(session.playerB, result.invB)) {
        throw new Error("Could not write inventory for actor " + session.playerB);
      }
      console.log(LOG_TRADING, "trade finalized:", session.id);
      vgrClearSession(session.id, "completed");
      return true;
    } catch (e) {
      console.error(LOG_TRADING, "finalize failed:", e.message || e);
      vgrResetAccept(session);
      vgrPushBoth(session, "update");
      return false;
    }
  };

  mp.makeProperty("vgrTradingUI", {
    isVisibleByOwner: true,
    isVisibleByNeighbors: false,
    updateOwner: `
      const value = ctx.value;
      if (!value || !value.event) return;

      if (!ctx.state.vgrTradingUI) {
        ctx.state.vgrTradingUI = { lastSeq: 0 };
      }
      if (ctx.state.vgrTradingUI.lastSeq === value.seq) return;
      ctx.state.vgrTradingUI.lastSeq = value.seq;

      const eventName = String(value.event || "");
      const payload = value.payload == null ? null : value.payload;
      ctx.sp.browser.executeJavaScript(
        "window.vgr_TradingUI && window.vgr_TradingUI(" +
        JSON.stringify(eventName) + "," +
        JSON.stringify(payload) +
        ");"
      );
    `,
    updateNeighbor: "",
  });

  mp.makeEventSource("_vgrTrading", `
    ctx.sp.printConsole("[VGR trading] event source loaded");

    if (!ctx.state.vgrTrading) {
      ctx.state.vgrTrading = { isOpen: false };
    }

    const closeTradingUi = (reason) => {
      if (!ctx.state.vgrTrading.isOpen) return;
      ctx.state.vgrTrading.isOpen = false;
      ctx.sp.printConsole("[VGR trading] close requested: " + reason);
      ctx.sendEvent({ kind: "cancel", payload: { reason: reason } });
    };

    ctx.sp.on("buttonEvent", (e) => {
      if (!e.isPressed) return;
      if (ctx.state.vgrTrading.isOpen && e.code === 1) {
        closeTradingUi("escape");
        return;
      }
    });

    ctx.sp.on("browserMessage", (e) => {
      const msg = e.arguments && e.arguments[0];
      const payload = e.arguments && e.arguments[1];

      if (msg === "vgr:trading:addOffer") {
        ctx.sendEvent({ kind: "addOffer", payload: payload });
      } else if (msg === "vgr:trading:removeOffer") {
        ctx.sendEvent({ kind: "removeOffer", payload: payload });
      } else if (msg === "vgr:trading:clearOffer") {
        ctx.sendEvent({ kind: "clearOffer" });
      } else if (msg === "vgr:trading:offerGold") {
        ctx.sendEvent({ kind: "offerGold", payload: payload });
      } else if (msg === "vgr:trading:accept") {
        ctx.sendEvent({ kind: "accept", payload: payload });
      } else if (msg === "vgr:trading:cancel") {
        ctx.sendEvent({ kind: "cancel", payload: payload });
      } else if (msg === "vgr:trading:tradeRequestResponse") {
        ctx.sendEvent({ kind: "tradeRequestResponse", payload: payload });
      } else if (msg === "vgr:trading:debugOpen") {
        ctx.sendEvent({ kind: "debugOpen" });
      }
      if (msg === "vgr:ui:on_open") {
        const name_ui = e.arguments && e.arguments[1];
        if (name_ui === "trading") ctx.state.vgrTrading.isOpen = true;
      }
      //When ui gets closed by any source, close active sessions
      if (msg === "vgr:ui:on_close") {
        const name_ui = e.arguments && e.arguments[1]; // Get the name of UI thats being closed
        if (name_ui === "trading") {
          ctx.state.vgrTrading.isOpen = false;
          ctx.sendEvent({ kind: "cancel", payload: payload });
        }
      }
    });
  `);

  mp._vgrTrading = (pcFormId, payload) => {
    if (!payload) return;

    if (payload.kind === "debugOpen") {
      if (!VGR_TRADING_DEV) return;
      vgrOpenOfflineDebugTrade(pcFormId);
      return;
    }

    if (payload.kind === "tradeRequestResponse") {
      vgrRespondTradeRequest(pcFormId, payload.payload || {});
      return;
    }

    const tradeId = vgrPlayerTrade.get(pcFormId);
    if (!tradeId) return;
    const session = vgrTradeSessions.get(tradeId);
    if (!session) return;

    if (payload.kind === "cancel") {
      vgrClearSession(tradeId, (payload.payload && payload.payload.reason) || "cancel");
      return;
    }

    if (payload.kind === "addOffer") {
      const p = payload.payload || {};
      const baseId = Number(p.baseId != null ? p.baseId : p.itemId);
      const count = Number(p.count || p.qty || 1);
      if (!Number.isFinite(baseId)) return;
      if (vgrAddToOffer(session, pcFormId, baseId, count)) {
        vgrPushBoth(session, "update");
      }
      return;
    }

    if (payload.kind === "removeOffer") {
      const p = payload.payload || {};
      const baseId = Number(p.baseId != null ? p.baseId : p.itemId);
      const count = Number(p.count || p.qty || 1);
      if (!Number.isFinite(baseId)) return;
      if (vgrRemoveFromOffer(session, pcFormId, baseId, count)) {
        vgrPushBoth(session, "update");
      }
      return;
    }

    if (payload.kind === "clearOffer") {
      vgrClearOffer(session, pcFormId);
      vgrPushBoth(session, "update");
      return;
    }

    if (payload.kind === "offerGold") {
      const gold = payload.payload && payload.payload.gold;
      vgrSetOfferGold(session, pcFormId, gold);
      vgrPushBoth(session, "update");
      return;
    }

    if (payload.kind === "accept") {
      const accepted = !!(payload.payload && payload.payload.accepted);
      if (pcFormId === session.playerA) session.acceptedA = accepted;
      else if (session.playerB && pcFormId === session.playerB) session.acceptedB = accepted;
      session.updatedAt = Date.now();

      if (VGR_TRADING_DEV && accepted && session.partnerOffline) {
        session.acceptedA = true;
        session.acceptedB = true;
      } else if (VGR_TRADING_DEV && accepted && session.playerB) {
        let partnerOnline = false;
        try {
          const partnerId = pcFormId === session.playerA ? session.playerB : session.playerA;
          partnerOnline = actors.isOnlinePlayer(partnerId);
        } catch (e) { }
        if (!partnerOnline) {
          session.acceptedA = true;
          session.acceptedB = true;
        }
      }

      vgrPushBoth(session, "update");
      vgrTryFinalize(session);
      return;
    }
  };

  mp._vgrTradingApi = {
    canRequestTrade: vgrCanRequestTrade,
    requestTrade: vgrRequestTrade,
    requestExactTargetTrade(requesterPcFormId, targetPcFormId, context) {
      const requester = Number(requesterPcFormId);
      const target = Number(targetPcFormId);
      if (!Number.isInteger(requester) || !Number.isInteger(target) || requester <= 0 || target <= 0) return null;
      if (requester === target) return null;
      return vgrCreateSession(requester, target, {
        partnerDisplayName: context && context.partnerDisplayName,
        visibleNames: context && context.visibleNames,
      });
    },
    isTrading(pcFormId) {
      return vgrPlayerTrade.has(Number(pcFormId));
    },
    cancelForActor(pcFormId, reason) {
      const tradeId = vgrPlayerTrade.get(Number(pcFormId));
      if (tradeId) vgrClearSession(tradeId, reason || "cancel");
      vgrCancelRequestsForActor(pcFormId);
    },
    state() {
      return {
        activeTrades: vgrTradeSessions.size,
        playerTrades: vgrPlayerTrade.size,
        pendingTradeRequests: pendingTradeRequests.size,
        tradeRequestsEnabled: TRADE_REQUESTS_ENABLED,
      };
    },
  };

  mp._vgrTradingDebugFinalize = (pcFormIdA, partnerFormId, offerA, offerB) => {
    if (!VGR_TRADING_DEV) return false;
    if (!actors.exists(partnerFormId)) {
      console.error(
        LOG_TRADING,
        "partner actor not loaded (formDesc " +
        DEBUG_PARTNER_FORM_DESC +
        "); use tools/debug-force-trade.js"
      );
      return false;
    }
    const invA = actors.inventory(pcFormIdA);
    const invB = actors.inventory(partnerFormId);
    if (!invB.entries || invB.entries.length === 0) {
      console.error(LOG_TRADING, "partner inventory empty; use Mongo debug script");
      return false;
    }
    try {
      const result = finalizeTrade(invA, invB, offerA, offerB);
      if (!actors.setInventory(pcFormIdA, result.invA)) {
        throw new Error("Could not write inventory for actor " + pcFormIdA);
      }
      if (!actors.setInventory(partnerFormId, result.invB)) {
        throw new Error("Could not write inventory for actor " + partnerFormId);
      }
      console.log(LOG_TRADING, "debug finalize OK");
      return true;
    } catch (e) {
      console.error(LOG_TRADING, "debug finalize failed:", e.message || e);
      return false;
    }
  };

  mp.on("disconnect", (userId) => {
    try {
      const pcFormId = actors.actorFromUser(userId);
      if (!pcFormId) return;
      const tradeId = vgrPlayerTrade.get(pcFormId);
      if (tradeId) {
        vgrClearSession(tradeId, "disconnect");
      }
      vgrCancelRequestsForActor(pcFormId);
    } catch (e) {
    } finally {
      actors.forgetUser(userId);
    }
  });

  console.log(LOG_TRADING, "module loaded", VGR_TRADING_DEV ? "(dev mode)" : "");
};
