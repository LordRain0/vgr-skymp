"use strict";

module.exports = (mp) => {
  const LOG = "[VGR nameplates]";
  const UI_VERSION = 1;
  const crypto = require("crypto");
  const vgrHelpers = require("./vgr_helpers");
  const helpers = vgrHelpers.playerInteractions;

  let settings = {};
  try {
    settings = mp.getServerSettings ? mp.getServerSettings() : {};
  } catch (e) {
    console.error(LOG, "failed to read server settings:", e && e.message ? e.message : e);
  }

  const legacyConfig = settings.vgrPlayerInteractions || {};
  const ownConfig = settings.vgrNameplates || {};
  const config = Object.assign({}, legacyConfig, ownConfig);
  const extensionEnabled = ownConfig.enabled !== undefined
    ? ownConfig.enabled !== false
    : legacyConfig.enabled !== false;
  if (!extensionEnabled) {
    console.info(LOG, "extension disabled by vgrNameplates.enabled=false or vgrPlayerInteractions.enabled=false");
    return;
  }

  const DB_NAME = config.backendDatabaseName || "skymp-backend";
  const CHARACTERS_COLLECTION = config.charactersCollection || "characters";
  const INTRODUCTIONS_FIELD = String(config.introductionsField || "introductions").trim() || "introductions";
  const UNKNOWN_NAME = config.unknownName || helpers.DEFAULT_UNKNOWN_NAME;
  const BASE_DISTANCE = Math.max(64, Number(config.maxDistance) || 300);
  const NAMEPLATES_ENABLED = config.nameplatesEnabled !== false;
  const NAMEPLATE_MAX_DISTANCE = Math.max(BASE_DISTANCE, Number(config.nameplateMaxDistance) || 1200);
  const NAMEPLATE_REFRESH_MS = Math.max(1000, Number(config.nameplateRefreshMs) || 5000);
  const NAMEPLATE_POLL_MS = Math.max(100, Number(config.nameplatePollMs || config.pollMs) || 250);
  const NAMEPLATE_STYLE = Object.freeze({
    font: String(config.nameplateFont || "Tavern"),
    color: normalizeColorArray(config.nameplateColor, [0.86, 0.72, 0.38, 1]),
    size: Math.max(0.1, Number(config.nameplateTextSize) || 0.82),
    depth: Math.max(0, Math.floor(Number(config.nameplateDepth) || 120)),
    node: String(config.nameplateNode || "NPC Head [Head]"),
    worldOffset: normalizeNumberArray(config.nameplateWorldOffset, [0, 0, 18], 3),
    screenOffset: normalizeNumberArray(config.nameplateScreenOffset, [0, -36], 2),
  });
  const actors = helpers.createActorHelpers(mp, { maxDistance: NAMEPLATE_MAX_DISTANCE });

  const signatureByActor = new Map();
  const introCache = helpers.createIntroductionCache();

  let MongoClient = null;
  try {
    MongoClient = require("mongodb").MongoClient;
  } catch (e) {
    console.error(LOG, "MongoDB driver missing. Known-name service will fail closed.");
  }

  let mongoClientPromise = null;
  let indexPromise = null;
  let databaseReady = false;
  let mutationDisabled = true;

  function deriveMongoUri(dbName) {
    if (config.backendDatabaseUri) return config.backendDatabaseUri;
    if (!settings.databaseUri) return "";
    try {
      const uri = new URL(settings.databaseUri);
      uri.pathname = "/" + dbName;
      return uri.toString();
    } catch (e) {
      console.error(LOG, "invalid databaseUri:", e && e.message ? e.message : e);
      return "";
    }
  }

  const MONGO_URI = deriveMongoUri(DB_NAME);

  function getDb() {
    if (!MongoClient) return Promise.reject(new Error("MongoDB driver is not installed"));
    if (!MONGO_URI) return Promise.reject(new Error("No MongoDB URI configured for known-name service"));
    if (!mongoClientPromise) mongoClientPromise = MongoClient.connect(MONGO_URI, { maxPoolSize: 4 });
    return mongoClientPromise.then((client) => client.db(DB_NAME));
  }

  function getPathValue(source, path) {
    const parts = String(path || "").split(".").filter(Boolean);
    let value = source;
    for (const part of parts) {
      if (!value || typeof value !== "object") return undefined;
      value = value[part];
    }
    return value;
  }

  function characterProjection() {
    const projection = { profileId: 1 };
    projection[INTRODUCTIONS_FIELD] = 1;
    return projection;
  }

  async function getCharacters() {
    const characters = (await getDb()).collection(CHARACTERS_COLLECTION);
    if (!indexPromise) {
      indexPromise = Promise.all([
        characters.createIndex({ profileId: 1, deletedAt: 1 }),
      ]);
    }
    await indexPromise;
    return characters;
  }

  async function loadIntroductions() {
    try {
      const characters = await getCharacters();
      introCache.clear();
      const characterDocs = await characters
        .find({ profileId: { $gte: 0 }, deletedAt: null }, { projection: characterProjection() })
        .toArray();
      for (const doc of characterDocs) {
        const viewerId = helpers.characterIdFromProfileId(doc.profileId);
        if (viewerId === null) continue;
        const introductions = helpers.normalizeIntroductions(getPathValue(doc, INTRODUCTIONS_FIELD));
        for (const knownId of introductions) helpers.addIntroduction(introCache, viewerId, knownId);
      }
      databaseReady = true;
      mutationDisabled = false;
      console.info(LOG, "loaded", helpers.countIntroductions(introCache), "known-name introductions");
    } catch (e) {
      databaseReady = false;
      mutationDisabled = true;
      console.error(LOG, "known-name startup load failed; names fail closed:", e && e.message ? e.message : e);
    }
  }

  function normalizeNumberArray(value, fallback, length) {
    const source = Array.isArray(value) ? value : fallback;
    const out = [];
    for (let i = 0; i < length; i++) {
      const number = Number(source && source[i]);
      out.push(Number.isFinite(number) ? number : Number(fallback[i]) || 0);
    }
    return out;
  }

  function normalizeColorArray(value, fallback) {
    return normalizeNumberArray(value, fallback, 4).map((entry, index) => {
      const fallbackValue = Number(fallback[index]) || 0;
      if (!Number.isFinite(entry)) return fallbackValue;
      return Math.min(1, Math.max(0, entry));
    });
  }

  function nonce() {
    return Date.now() + ":" + crypto.randomBytes(8).toString("hex");
  }

  function sanitizeNameplateText(value) {
    return String(value || "")
      .trim()
      .replace(/[^\x20-\x7e]/g, "?")
      .slice(0, 48);
  }

  function isKnownTo(viewer, target) {
    const viewerIdentity = helpers.publicIdentity(viewer);
    const targetIdentity = helpers.publicIdentity(target);
    if (!viewerIdentity || !targetIdentity) return false;
    if (viewerIdentity.characterId === targetIdentity.characterId) return false;
    return helpers.hasIntroduction(introCache, viewerIdentity.characterId, targetIdentity.characterId);
  }

  function getVisibleName(viewer, target) {
    return helpers.visibleName(introCache, viewer, target, UNKNOWN_NAME);
  }

  function knownNameFor(viewer, target) {
    if (!isKnownTo(viewer, target)) return "";
    return sanitizeNameplateText(getVisibleName(viewer, target));
  }

  function canUseIntroductions() {
    return databaseReady && !mutationDisabled;
  }

  async function recordIntroduction(viewer, known, options) {
    const viewerIdentity = helpers.publicIdentity(viewer);
    const knownIdentity = helpers.publicIdentity(known);
    if (!viewerIdentity || !knownIdentity) return { ok: false, reason: "Character identity is unavailable." };
    if (viewerIdentity.characterId === knownIdentity.characterId) {
      return { ok: false, reason: "You cannot introduce yourself to yourself." };
    }

    if (helpers.hasIntroduction(introCache, viewerIdentity.characterId, knownIdentity.characterId)) {
      return { ok: true, created: false, alreadyKnown: true };
    }
    if (!canUseIntroductions()) return { ok: false, reason: "Name service is temporarily unavailable." };

    const characters = await getCharacters();
    const result = await characters.updateOne(
      { profileId: viewerIdentity.profileId, deletedAt: null },
      { $addToSet: { [INTRODUCTIONS_FIELD]: knownIdentity.profileId } }
    );
    if (!result || result.matchedCount < 1) return { ok: false, reason: "Character identity is unavailable." };

    helpers.addIntroduction(introCache, viewerIdentity.characterId, knownIdentity.characterId);

    const opts = options || {};
    if (opts.viewerPcFormId) pushNameplates(opts.viewerPcFormId, true);
    if (opts.knownPcFormId) pushNameplates(opts.knownPcFormId, true);
    return { ok: true, created: result.modifiedCount > 0, alreadyKnown: result.modifiedCount <= 0 };
  }

  function buildLabels(pcFormId) {
    if (!NAMEPLATES_ENABLED || !actors.exists(pcFormId)) return [];
    const viewerIdentity = actors.identity(pcFormId);
    if (!viewerIdentity) return [];
    const viewerCell = actors.cell(pcFormId);
    const viewerPos = actors.position(pcFormId);
    if (!viewerCell || !Array.isArray(viewerPos)) return [];

    const labels = [];
    for (const otherPcFormId of actors.onlinePlayers()) {
      const targetPcFormId = Number(otherPcFormId);
      if (!Number.isInteger(targetPcFormId) || targetPcFormId <= 0 || targetPcFormId === Number(pcFormId)) continue;
      if (!actors.exists(targetPcFormId) || actors.isDead(targetPcFormId)) continue;
      if (actors.cell(targetPcFormId) !== viewerCell) continue;

      const distance = helpers.distance3(viewerPos, actors.position(targetPcFormId));
      if (!Number.isFinite(distance) || distance > NAMEPLATE_MAX_DISTANCE) continue;

      const targetIdentity = actors.identity(targetPcFormId);
      const name = knownNameFor(viewerIdentity, targetIdentity);
      if (!name) continue;

      labels.push({
        targetFormId: targetPcFormId,
        name,
        distance: Math.round(distance),
      });
    }

    labels.sort((a, b) => a.distance - b.distance || a.targetFormId - b.targetFormId);
    return labels;
  }

  function labelSignature(labels) {
    return labels.map((entry) => entry.targetFormId + ":" + entry.name).join("|");
  }

  function pushNameplates(pcFormId, force) {
    if (!actors.exists(pcFormId)) return;
    const labels = buildLabels(pcFormId);
    const signature = NAMEPLATES_ENABLED ? labelSignature(labels) : "disabled";
    if (!force && signatureByActor.get(pcFormId) === signature) return;
    signatureByActor.set(pcFormId, signature);
    try {
      mp.set(pcFormId, "vgrNameplates", {
        version: UI_VERSION,
        nonce: nonce(),
        enabled: NAMEPLATES_ENABLED,
        labels,
        style: NAMEPLATE_STYLE,
      });
    } catch (e) {
      console.warn(LOG, "push failed for", pcFormId, e && e.message ? e.message : e);
    }
  }

  function refreshForOnline() {
    if (!NAMEPLATES_ENABLED) return;
    for (const pcFormId of actors.onlinePlayers()) pushNameplates(pcFormId, true);
  }

  mp.makeProperty("vgrNameplates", {
    isVisibleByOwner: true,
    isVisibleByNeighbors: false,
    updateOwner: `
      ctx.state.vgrNameplatePayload = ctx.value || null;
    `,
    updateNeighbor: "",
  });

  mp.makeEventSource("_vgrNameplates", `
    ctx.sp.printConsole("[VGR nameplates] event source loaded");

    if (!ctx.state.vgrNameplates) {
      ctx.state.vgrNameplates = {
        pollAt: 0,
        sentAt: 0,
        lastNonce: null,
        texts: {}
      };
    }
    if (!ctx.state.vgrNameplates.texts) ctx.state.vgrNameplates.texts = {};

${vgrHelpers.client.blockingUiHelpers()}

    const destroyKey = (key) => {
      const entry = ctx.state.vgrNameplates.texts[key];
      if (!entry) return;
      try {
        if (ctx.sp && typeof ctx.sp.setTextRefr === "function") ctx.sp.setTextRefr(entry.textId, 0);
      } catch (_) {}
      try {
        if (ctx.sp && typeof ctx.sp.destroyText === "function") ctx.sp.destroyText(entry.textId);
      } catch (_) {}
      delete ctx.state.vgrNameplates.texts[key];
    };

    const destroyAll = () => {
      for (const key of Object.keys(ctx.state.vgrNameplates.texts)) destroyKey(key);
      ctx.state.vgrNameplates.lastNonce = null;
    };

    const syncNameplates = () => {
      const value = ctx.state.vgrNameplatePayload || null;
      if (!value || value.version !== ${UI_VERSION} || value.enabled === false) {
        destroyAll();
        ctx.state.vgrNameplates.lastNonce = value ? value.nonce : null;
        return;
      }
      if (ctx.state.vgrNameplates.lastNonce === value.nonce) return;
      ctx.state.vgrNameplates.lastNonce = value.nonce;

      const sp = ctx.sp;
      const apiReady =
        sp &&
        typeof sp.createText === "function" &&
        typeof sp.destroyText === "function" &&
        typeof sp.setTextString === "function" &&
        typeof sp.setTextColor === "function" &&
        typeof sp.setTextSize === "function" &&
        typeof sp.setTextDepth === "function" &&
        typeof sp.setTextRefr === "function" &&
        typeof sp.setTextRefrNode === "function";

      if (!apiReady) {
        destroyAll();
        return;
      }

      const style = value.style || {};
      const color = Array.isArray(style.color) ? style.color : [0.86, 0.72, 0.38, 1];
      const font = style.font || "Tavern";
      const size = Number(style.size) || 0.82;
      const depth = Math.max(0, Math.floor(Number(style.depth) || 120));
      const node = style.node || "NPC Head [Head]";
      const worldOffset = Array.isArray(style.worldOffset) ? style.worldOffset : [0, 0, 18];
      const screenOffset = Array.isArray(style.screenOffset) ? style.screenOffset : [0, -36];
      const labels = Array.isArray(value.labels) ? value.labels : [];
      const keep = {};

      for (const label of labels) {
        const serverFormId = Number(label && label.targetFormId);
        const name = String(label && label.name ? label.name : "").trim();
        if (!serverFormId || !name) continue;
        const key = String(serverFormId);

        let clientFormId = 0;
        try { clientFormId = ctx.getFormIdInClientFormat(serverFormId) || 0; } catch (_) {}
        if (!clientFormId) {
          destroyKey(key);
          continue;
        }

        keep[key] = true;
        let entry = ctx.state.vgrNameplates.texts[key];
        if (!entry) {
          let textId = 0;
          try { textId = sp.createText(0, 0, name, color, font); } catch (_) {}
          if (!textId) continue;
          entry = { textId, text: "", target: 0 };
          ctx.state.vgrNameplates.texts[key] = entry;
        }

        if (entry.text !== name) {
          try { sp.setTextString(entry.textId, name); } catch (_) {}
          entry.text = name;
        }

        try { sp.setTextColor(entry.textId, color); } catch (_) {}
        try { sp.setTextSize(entry.textId, size); } catch (_) {}
        try { sp.setTextDepth(entry.textId, depth); } catch (_) {}
        try {
          if (typeof sp.setTextOrigin === "function") {
            sp.setTextOrigin(entry.textId, [Math.max(0, name.length * 4), 0]);
          }
        } catch (_) {}

        try {
          if (entry.target !== clientFormId) {
            sp.setTextRefr(entry.textId, clientFormId);
            entry.target = clientFormId;
          }
          sp.setTextRefrNode(entry.textId, node);
          if (typeof sp.setTextRefrOffset === "function") sp.setTextRefrOffset(entry.textId, worldOffset);
          if (typeof sp.setTextRefrScreenOffset === "function") sp.setTextRefrScreenOffset(entry.textId, screenOffset);
        } catch (_) {}
      }

      for (const key of Object.keys(ctx.state.vgrNameplates.texts)) {
        if (!keep[key]) destroyKey(key);
      }
    };

    ctx.sp.on("update", () => {
      const now = Date.now();
      if (now - (ctx.state.vgrNameplates.pollAt || 0) < ${NAMEPLATE_POLL_MS}) return;
      ctx.state.vgrNameplates.pollAt = now;

      if (isBlockingUiOpen()) {
        ctx.state.vgrNameplates.sentAt = 0;
        destroyAll();
        return;
      }

      if (now - (ctx.state.vgrNameplates.sentAt || 0) >= ${NAMEPLATE_REFRESH_MS}) {
        ctx.state.vgrNameplates.sentAt = now;
        ctx.sendEvent({ kind: "refresh" });
      }
      syncNameplates();
    });
  `);

  mp._vgrNameplates = (pcFormId, payload) => {
    if (!payload || payload.kind !== "refresh") return;
    pushNameplates(pcFormId);
  };

  mp._vgrNameplatesApi = {
    getVisibleName,
    isKnownTo,
    canUseIntroductions,
    recordIntroduction,
    refreshForActor(pcFormId, force) {
      pushNameplates(pcFormId, force !== false);
    },
    refreshForOnline,
    state() {
      return {
        enabled: true,
        nameplatesEnabled: NAMEPLATES_ENABLED,
        databaseReady,
        mutationDisabled,
        introductions: helpers.countIntroductions(introCache),
        views: signatureByActor.size,
        refreshMs: NAMEPLATE_REFRESH_MS,
        pollMs: NAMEPLATE_POLL_MS,
      };
    },
  };

  mp.on("connect", (userId) => {
    try {
      const pcFormId = actors.actorFromUser(userId);
      if (!pcFormId) return;
      pushNameplates(pcFormId, true);
      refreshForOnline();
    } catch (e) {}
  });

  mp.on("disconnect", (userId) => {
    try {
      const pcFormId = actors.actorFromUser(userId);
      if (!pcFormId) return;
      signatureByActor.delete(pcFormId);
      refreshForOnline();
    } catch (e) {
    } finally {
      actors.forgetUser(userId);
    }
  });

  loadIntroductions();
  console.log(LOG, "extension loaded");
};
