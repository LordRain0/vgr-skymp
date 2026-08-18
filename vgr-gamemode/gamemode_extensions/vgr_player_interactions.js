"use strict";

module.exports = (mp) => {
  const LOG = "[VGR player_interactions]";
  const UI_VERSION = 1;
  const ACCESS_MANAGE_PERMISSION = "vgr.access.manage";

  const crypto = require("crypto");
  const identity = require("./vgr_access_identity");
  const helpers = require("./vgr_player_interaction_helpers");
  const vgrHelpers = require("./vgr_helpers");

  let settings = {};
  try {
    settings = mp.getServerSettings ? mp.getServerSettings() : {};
  } catch (e) {
    console.error(LOG, "failed to read server settings:", e && e.message ? e.message : e);
  }

  const config = settings.vgrPlayerInteractions || {};
  if (config.enabled === false) {
    console.info(LOG, "extension disabled by vgrPlayerInteractions.enabled=false");
    return;
  }

  const DB_NAME = config.databaseName || "vengeful_realms";
  const INTRO_COLLECTION = config.introductionsCollection || "vgr_player_introductions";
  const RESTRAINT_COLLECTION = config.restraintsCollection || "vgr_player_restraints";
  const AUDIT_COLLECTION = config.auditCollection || "vgr_player_interaction_audit";
  const UNKNOWN_NAME = config.unknownName || helpers.DEFAULT_UNKNOWN_NAME;
  const INTERACTION_KEY_DIK = Math.max(1, Math.floor(Number(config.interactionKeyDik) || 45));
  const MAX_DISTANCE = Math.max(64, Number(config.maxDistance) || 300);
  const TARGET_TTL_MS = Math.max(1000, Number(config.targetTokenTtlMs) || 15000);
  const MENU_IDLE_TTL_MS = Math.max(5000, Number(config.menuIdleTtlMs) || 30000);
  const TRADE_REQUEST_TTL_MS = Math.max(3000, Number(config.tradeRequestTtlMs) || 15000);
  const TRADE_REQUEST_COOLDOWN_MS = Math.max(0, Number(config.tradeRequestCooldownMs) || 5000);
  const PROMPT_REFRESH_MS = Math.max(50, Number(config.promptRefreshMs) || 100);
  const PROMPT_SHOWS_TARGET_NAME = config.promptShowsTargetName === true;
  const NAMEPLATES_ENABLED = config.nameplatesEnabled !== false;
  const NAMEPLATE_MAX_DISTANCE = Math.max(MAX_DISTANCE, Number(config.nameplateMaxDistance) || 1200);
  const NAMEPLATE_REFRESH_MS = Math.max(250, Number(config.nameplateRefreshMs) || 1000);
  const NAMEPLATE_STYLE = Object.freeze({
    font: String(config.nameplateFont || "Tavern"),
    color: normalizeColorArray(config.nameplateColor, [0.86, 0.72, 0.38, 1]),
    size: Math.max(0.1, Number(config.nameplateTextSize) || 0.82),
    depth: Math.max(0, Math.floor(Number(config.nameplateDepth) || 120)),
    node: String(config.nameplateNode || "NPC Head [Head]"),
    worldOffset: normalizeNumberArray(config.nameplateWorldOffset, [0, 0, 18], 3),
    screenOffset: normalizeNumberArray(config.nameplateScreenOffset, [0, -36], 2),
  });
  const TRADE_REQUESTS_ENABLED = config.tradeRequestsEnabled !== false;
  const BINDINGS_ENABLED = config.bindingsEnabled !== false;
  const CUFF_BASE_IDS = helpers.normalizeCuffIds(config.cuffBaseIds);
  const NORMAL_RELEASE_ITEM_POLICY = config.normalReleaseItemPolicy || "return_to_releaser";
  const ADMIN_RELEASE_ITEM_POLICY = config.adminReleaseItemPolicy || "leave_with_target";
  const RELEASE_ON_DEATH = config.releaseOnDeath !== false;

  let MongoClient = null;
  try {
    MongoClient = require("mongodb").MongoClient;
  } catch (e) {
    console.error(LOG, "MongoDB driver missing. Player interactions will fail closed for persistence.");
  }

  const permissions = require("./vgr_access_permissions")(mp, settings);

  const sessionsById = new Map();
  const sessionByActor = new Map();
  const promptTargetByActor = new Map();
  const pendingTradeRequests = new Map();
  const incomingTradeByActor = new Map();
  const outgoingTradeByActor = new Map();
  const lastTradeRequestAt = new Map();
  const nameplateSigByActor = new Map();
  const introCache = new Set();
  const activeRestraints = new Map(); // targetCharacterId -> restraint document
  const restraintWriteLocks = new Set(); // targetCharacterId with a bind mutation in flight

  let mongoClientPromise = null;
  let indexPromise = null;
  let databaseReady = false;
  let mutationDisabled = true;

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

  function deriveMongoUri(dbName) {
    if (config.databaseUri) return config.databaseUri;
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

  function randomToken(prefix) {
    return String(prefix || "vgr") + "_" + crypto.randomBytes(18).toString("base64url");
  }

  function nonce() {
    return Date.now() + ":" + crypto.randomBytes(8).toString("hex");
  }

  function getDb() {
    if (!MongoClient) return Promise.reject(new Error("MongoDB driver is not installed"));
    if (!MONGO_URI) return Promise.reject(new Error("No MongoDB URI configured for player interactions"));
    if (!mongoClientPromise) mongoClientPromise = MongoClient.connect(MONGO_URI, { maxPoolSize: 8 });
    return mongoClientPromise.then((client) => client.db(DB_NAME));
  }

  async function getCollections() {
    const db = await getDb();
    const introductions = db.collection(INTRO_COLLECTION);
    const restraints = db.collection(RESTRAINT_COLLECTION);
    const audit = db.collection(AUDIT_COLLECTION);

    if (!indexPromise) {
      indexPromise = Promise.all([
        introductions.createIndex({ viewerCharacterId: 1, knownCharacterId: 1 }, { unique: true }),
        introductions.createIndex({ knownCharacterId: 1 }),
        restraints.createIndex({ targetCharacterId: 1, active: 1 }),
        restraints.createIndex(
          { targetCharacterId: 1 },
          { unique: true, partialFilterExpression: { active: true } }
        ),
        restraints.createIndex({ binderCharacterId: 1, active: 1 }),
        audit.createIndex({ at: -1 }),
        audit.createIndex({ actorCharacterId: 1, at: -1 }),
      ]);
    }

    await indexPromise;
    return { introductions, restraints, audit };
  }

  async function loadPersistentState() {
    try {
      const { introductions, restraints } = await getCollections();
      introCache.clear();
      const introDocs = await introductions
        .find({}, { projection: { viewerCharacterId: 1, knownCharacterId: 1 } })
        .toArray();
      for (const doc of introDocs) {
        const key = helpers.introKey(doc.viewerCharacterId, doc.knownCharacterId);
        if (key) introCache.add(key);
      }

      activeRestraints.clear();
      const restraintDocs = await restraints.find({ active: true }).toArray();
      for (const doc of restraintDocs) {
        if (doc && doc.targetCharacterId) activeRestraints.set(String(doc.targetCharacterId), doc);
      }

      databaseReady = true;
      mutationDisabled = false;
      console.info(LOG, "loaded", introCache.size, "introductions and", activeRestraints.size, "active restraints");
    } catch (e) {
      databaseReady = false;
      mutationDisabled = true;
      console.error(LOG, "startup persistence load failed; names fail closed and mutations are disabled:", e && e.message ? e.message : e);
    }
  }

  async function writeAudit(action, actor, details) {
    if (!databaseReady || mutationDisabled) return;
    try {
      const { audit } = await getCollections();
      await audit.insertOne({
        at: helpers.nowIso(),
        action,
        actorCharacterId: actor && actor.characterId ? actor.characterId : null,
        actorProfileId: actor && actor.profileId != null ? actor.profileId : null,
        details: details || {},
      });
    } catch (e) {
      console.warn(LOG, "audit write failed:", e && e.message ? e.message : e);
    }
  }

  function actorExists(pcFormId) {
    if (pcFormId == null || pcFormId === 0) return false;
    try {
      mp.get(pcFormId, "profileId");
      return true;
    } catch (e) {
      try {
        mp.get(pcFormId, "inventory");
        return true;
      } catch (_) {
        return false;
      }
    }
  }

  function getOnlinePlayers() {
    try {
      const online = mp.get(0xff000000, "onlinePlayers");
      return Array.isArray(online) ? online.map(Number).filter(Number.isFinite) : [];
    } catch (e) {
      return [];
    }
  }

  function isOnlinePlayer(pcFormId) {
    return getOnlinePlayers().indexOf(Number(pcFormId)) !== -1;
  }

  function getActorIdentity(pcFormId) {
    const who = identity.getIdentity(mp, pcFormId);
    return helpers.publicIdentity(who);
  }

  function isDeadActor(pcFormId) {
    const boolFields = ["isDead", "dead"];
    for (const field of boolFields) {
      try {
        const value = mp.get(pcFormId, field);
        if (value === true) return true;
      } catch (e) {}
    }

    const healthFields = ["healthPercentage", "healthPercent"];
    for (const field of healthFields) {
      try {
        const value = Number(mp.get(pcFormId, field));
        if (Number.isFinite(value) && value <= 0) return true;
      } catch (e) {}
    }

    try {
      const values = mp.get(pcFormId, "actorValues");
      const health = values && (values.health || values.Health);
      if (Number.isFinite(Number(health)) && Number(health) <= 0) return true;
    } catch (e) {}

    return false;
  }

  function getPosition(pcFormId) {
    try {
      return mp.get(pcFormId, "pos") || mp.get(pcFormId, "position");
    } catch (e) {
      return null;
    }
  }

  function getCell(pcFormId) {
    try {
      return String(mp.get(pcFormId, "worldOrCellDesc") || "");
    } catch (e) {
      return "";
    }
  }

  function rangeStatus(a, b) {
    const cellA = getCell(a);
    const cellB = getCell(b);
    if (!cellA || !cellB || cellA !== cellB) return { ok: false, reason: "That player is no longer nearby." };
    const dist = helpers.distance3(getPosition(a), getPosition(b));
    if (!Number.isFinite(dist)) return { ok: false, reason: "Could not validate distance." };
    if (dist > MAX_DISTANCE) return { ok: false, reason: "Move closer to interact." };
    return { ok: true, distance: dist, cell: cellA };
  }

  function getVisibleName(viewer, target) {
    return helpers.visibleName(introCache, viewer, target, UNKNOWN_NAME);
  }

  function getKnownNameForNameplate(viewer, target) {
    const viewerIdentity = helpers.publicIdentity(viewer);
    const targetIdentity = helpers.publicIdentity(target);
    if (!viewerIdentity || !targetIdentity) return "";
    if (viewerIdentity.characterId === targetIdentity.characterId) return "";
    if (!helpers.hasIntroduction(introCache, viewerIdentity.characterId, targetIdentity.characterId)) return "";
    return sanitizeNameplateText(targetIdentity.displayName);
  }

  function sanitizeNameplateText(value) {
    return String(value || "")
      .trim()
      .replace(/[^\x20-\x7e]/g, "?")
      .slice(0, 48);
  }

  function buildNameplateLabels(pcFormId) {
    if (!NAMEPLATES_ENABLED || !actorExists(pcFormId)) return [];
    const viewerIdentity = getActorIdentity(pcFormId);
    if (!viewerIdentity) return [];
    const viewerCell = getCell(pcFormId);
    const viewerPos = getPosition(pcFormId);
    if (!viewerCell || !Array.isArray(viewerPos)) return [];

    const labels = [];
    for (const otherPcFormId of getOnlinePlayers()) {
      const targetPcFormId = Number(otherPcFormId);
      if (!Number.isInteger(targetPcFormId) || targetPcFormId <= 0 || targetPcFormId === Number(pcFormId)) continue;
      if (!actorExists(targetPcFormId) || isDeadActor(targetPcFormId)) continue;
      if (getCell(targetPcFormId) !== viewerCell) continue;

      const distance = helpers.distance3(viewerPos, getPosition(targetPcFormId));
      if (!Number.isFinite(distance) || distance > NAMEPLATE_MAX_DISTANCE) continue;

      const targetIdentity = getActorIdentity(targetPcFormId);
      const name = getKnownNameForNameplate(viewerIdentity, targetIdentity);
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

  function nameplateSignature(labels) {
    return labels.map((entry) => entry.targetFormId + ":" + entry.name).join("|");
  }

  function pushNameplates(pcFormId, force) {
    if (!actorExists(pcFormId)) return;
    const labels = NAMEPLATES_ENABLED ? buildNameplateLabels(pcFormId) : [];
    const signature = NAMEPLATES_ENABLED ? nameplateSignature(labels) : "disabled";
    if (!force && nameplateSigByActor.get(pcFormId) === signature) return;
    nameplateSigByActor.set(pcFormId, signature);
    try {
      mp.set(pcFormId, "vgrPlayerNameplates", {
        version: UI_VERSION,
        nonce: nonce(),
        enabled: NAMEPLATES_ENABLED,
        labels,
        style: NAMEPLATE_STYLE,
      });
    } catch (e) {
      console.warn(LOG, "push nameplates failed for", pcFormId, e && e.message ? e.message : e);
    }
  }

  function clearNameplates(pcFormId) {
    nameplateSigByActor.delete(pcFormId);
    if (!actorExists(pcFormId)) return;
    try {
      mp.set(pcFormId, "vgrPlayerNameplates", {
        version: UI_VERSION,
        nonce: nonce(),
        enabled: false,
        labels: [],
        style: NAMEPLATE_STYLE,
      });
    } catch (e) {
      console.warn(LOG, "clear nameplates failed for", pcFormId, e && e.message ? e.message : e);
    }
  }

  function refreshNameplatesForOnline() {
    if (!NAMEPLATES_ENABLED) return;
    for (const pcFormId of getOnlinePlayers()) pushNameplates(pcFormId, true);
  }

  function pushUi(pcFormId, payload) {
    if (!actorExists(pcFormId)) return;
    const value = Object.assign({
      version: UI_VERSION,
      nonce: nonce(),
      maxDistance: MAX_DISTANCE,
    }, payload || {});
    try {
      mp.set(pcFormId, "vgrPlayerInteractionUi", value);
    } catch (e) {
      console.warn(LOG, "push UI failed for", pcFormId, e && e.message ? e.message : e);
    }
  }

  function pushToast(pcFormId, message) {
    pushUi(pcFormId, { action: "toast", message: String(message || "Interaction failed.") });
  }

  function clearPrompt(pcFormId) {
    promptTargetByActor.delete(pcFormId);
    pushUi(pcFormId, { action: "promptClear", ui: "player_prompt" });
  }

  function validateLivingTarget(requesterPcFormId, targetPcFormId) {
    const requester = Number(requesterPcFormId);
    const target = Number(targetPcFormId);
    if (!Number.isInteger(requester) || requester <= 0 || !actorExists(requester)) {
      return { ok: false, reason: "Requester is unavailable." };
    }
    if (isDeadActor(requester)) {
      return { ok: false, reason: "You cannot do that right now." };
    }
    if (!Number.isInteger(target) || target <= 0 || !actorExists(target)) {
      return { ok: false, reason: "That player is no longer available." };
    }
    if (requester === target) return { ok: false, reason: "You cannot interact with yourself." };
    if (!isOnlinePlayer(target)) return { ok: false, reason: "Look directly at a player." };
    if (isDeadActor(target)) return { ok: false, reason: "That player is no longer available.", dead: true };

    const requesterIdentity = getActorIdentity(requester);
    const targetIdentity = getActorIdentity(target);
    if (!requesterIdentity || !targetIdentity) return { ok: false, reason: "Character identity is unavailable." };

    const range = rangeStatus(requester, target);
    if (!range.ok) return range;

    return {
      ok: true,
      requesterPcFormId: requester,
      targetPcFormId: target,
      requesterIdentity,
      targetIdentity,
      cell: range.cell,
      distance: range.distance,
    };
  }

  function isTrading(pcFormId) {
    try {
      return !!(mp._vgrTradingApi && mp._vgrTradingApi.isTrading && mp._vgrTradingApi.isTrading(pcFormId));
    } catch (e) {
      return false;
    }
  }

  function isActorRestrained(pcFormIdOrIdentity) {
    const who = typeof pcFormIdOrIdentity === "object" ? helpers.publicIdentity(pcFormIdOrIdentity) : getActorIdentity(pcFormIdOrIdentity);
    return !!(who && activeRestraints.has(String(who.characterId)));
  }

  function getRestraintForIdentity(who) {
    const publicWho = helpers.publicIdentity(who);
    return publicWho ? activeRestraints.get(String(publicWho.characterId)) || null : null;
  }

  function hasAdmin(pcFormId) {
    try {
      return permissions.hasPermission(pcFormId, ACCESS_MANAGE_PERMISSION).allowed === true;
    } catch (e) {
      return false;
    }
  }

  function isBusy(pcFormId) {
    return (
      sessionByActor.has(pcFormId) ||
      incomingTradeByActor.has(pcFormId) ||
      outgoingTradeByActor.has(pcFormId) ||
      isTrading(pcFormId)
    );
  }

  function getInventory(pcFormId) {
    try {
      return mp.get(pcFormId, "inventory") || { entries: [] };
    } catch (e) {
      return { entries: [] };
    }
  }

  function setInventory(pcFormId, inv) {
    mp.set(pcFormId, "inventory", inv || { entries: [] });
  }

  function cuffLabel(baseId) {
    if (Number(baseId) === 0x00103941) return "Prisoner's Cuffs";
    if (Number(baseId) === 0x0010E039) return "Prisoner's Cuffs (Player)";
    if (Number(baseId) === 0x0010E2D8) return "Prisoner's Cuffs (Solitude)";
    return "Cuffs " + Number(baseId).toString(16).toUpperCase();
  }

  function buildActions(validation) {
    const requester = validation.requesterIdentity;
    const target = validation.targetIdentity;
    const targetHasRequesterIntro = helpers.hasIntroduction(introCache, target.characterId, requester.characterId);
    const requesterRestrained = isActorRestrained(requester);
    const targetRestraint = getRestraintForIdentity(target);
    const cuffOptions = helpers.findCuffOptions(getInventory(validation.requesterPcFormId), CUFF_BASE_IDS);
    const admin = hasAdmin(validation.requesterPcFormId);
    const canTrade =
      TRADE_REQUESTS_ENABLED &&
      !requesterRestrained &&
      !targetRestraint &&
      !isTrading(validation.requesterPcFormId) &&
      !isTrading(validation.targetPcFormId) &&
      !incomingTradeByActor.has(validation.targetPcFormId) &&
      !outgoingTradeByActor.has(validation.requesterPcFormId);

    const actions = [];
    actions.push({
      id: "introduce_self",
      label: targetHasRequesterIntro ? "ALREADY INTRODUCED" : "INTRODUCE YOURSELF",
      enabled: !targetHasRequesterIntro && databaseReady && !mutationDisabled,
      reason: targetHasRequesterIntro ? "ALREADY INTRODUCED" : (!databaseReady || mutationDisabled ? "SERVICE UNAVAILABLE" : ""),
    });
    actions.push({
      id: "request_trade",
      label: "TRADE",
      enabled: canTrade,
      reason: canTrade ? "" : "PLAYER BUSY",
    });

    if (targetRestraint) {
      const isBinder = targetRestraint.binderCharacterId && String(targetRestraint.binderCharacterId) === String(requester.characterId);
      actions.push({
        id: "remove_binds",
        label: "REMOVE BINDS",
        enabled: BINDINGS_ENABLED && (isBinder || admin) && databaseReady && !mutationDisabled,
        reason: isBinder || admin ? "" : "ALREADY RESTRAINED",
      });
    } else {
      const canBind =
        BINDINGS_ENABLED &&
        databaseReady &&
        !mutationDisabled &&
        !requesterRestrained &&
        cuffOptions.length > 0;
      actions.push({
        id: "use_binds",
        label: "USE BINDS",
        enabled: canBind,
        reason: canBind ? "" : (requesterRestrained ? "YOU ARE RESTRAINED" : "NEED PRISONER'S CUFFS"),
      });
    }

    return { actions, cuffOptions };
  }

  function closeSession(pcFormId, reason) {
    const id = sessionByActor.get(pcFormId);
    if (!id) return;
    const session = sessionsById.get(id);
    sessionsById.delete(id);
    sessionByActor.delete(pcFormId);
    if (session && session.timeout) clearTimeout(session.timeout);
    pushUi(pcFormId, { action: "close", ui: "player_interaction", focus: "release", reason: reason || "close" });
  }

  function createSession(validation) {
    closeSession(validation.requesterPcFormId, "replace");
    const id = randomToken("pi");
    const now = Date.now();
    const built = buildActions(validation);
    const session = {
      id,
      requesterPcFormId: validation.requesterPcFormId,
      targetPcFormId: validation.targetPcFormId,
      requesterIdentity: validation.requesterIdentity,
      targetIdentity: validation.targetIdentity,
      cell: validation.cell,
      createdAt: now,
      lastActivityAt: now,
      expiresAt: now + TARGET_TTL_MS,
      timeout: setTimeout(() => closeSession(validation.requesterPcFormId, "expired"), TARGET_TTL_MS + 250),
      actionIds: new Set(built.actions.map((a) => a.id)),
      cuffOptions: built.cuffOptions,
    };
    sessionsById.set(id, session);
    sessionByActor.set(validation.requesterPcFormId, id);
    return session;
  }

  function refreshSessionActions(session) {
    const validation = validateLivingTarget(session.requesterPcFormId, session.targetPcFormId);
    if (!validation.ok) return null;
    session.requesterIdentity = validation.requesterIdentity;
    session.targetIdentity = validation.targetIdentity;
    const built = buildActions(validation);
    session.actionIds = new Set(built.actions.map((a) => a.id));
    session.cuffOptions = built.cuffOptions;
    session.lastActivityAt = Date.now();
    session.expiresAt = Date.now() + MENU_IDLE_TTL_MS;
    if (session.timeout) clearTimeout(session.timeout);
    session.timeout = setTimeout(() => closeSession(session.requesterPcFormId, "expired"), MENU_IDLE_TTL_MS + 250);
    return built;
  }

  function pushMenu(session, toastMessage) {
    const built = refreshSessionActions(session);
    if (!built) {
      closeSession(session.requesterPcFormId, "invalid");
      return;
    }
    pushUi(session.requesterPcFormId, {
      action: "open",
      ui: "player_interaction",
      focus: "grab",
      sessionId: session.id,
      targetName: getVisibleName(session.requesterIdentity, session.targetIdentity),
      targetProfileId: null,
      actions: built.actions,
      toastMessage: toastMessage || null,
      expiresAt: session.expiresAt,
    });
  }

  function validateSession(pcFormId, payload) {
    const id = payload && payload.sessionId;
    if (!id || sessionByActor.get(pcFormId) !== id || !sessionsById.has(id)) {
      return { ok: false, reason: "Your interaction session expired." };
    }
    const session = sessionsById.get(id);
    if (session.requesterPcFormId !== pcFormId) return { ok: false, reason: "Invalid interaction session." };
    if (Date.now() > session.expiresAt) {
      closeSession(pcFormId, "expired");
      return { ok: false, reason: "Your interaction session expired." };
    }
    const validation = validateLivingTarget(session.requesterPcFormId, session.targetPcFormId);
    if (!validation.ok) {
      closeSession(pcFormId, "invalid_target");
      return validation;
    }
    session.requesterIdentity = validation.requesterIdentity;
    session.targetIdentity = validation.targetIdentity;
    return { ok: true, session, validation };
  }

  async function handlePrompt(pcFormId, payload) {
    const targetFormId = Number(payload && payload.targetFormId);
    const validation = validateLivingTarget(pcFormId, targetFormId);
    if (!validation.ok) {
      if (promptTargetByActor.get(pcFormId)) clearPrompt(pcFormId);
      return;
    }
    promptTargetByActor.set(pcFormId, targetFormId);
    pushUi(pcFormId, {
      action: "prompt",
      ui: "player_prompt",
      targetFormId,
      prompt: "(X) MENU",
      showTargetName: PROMPT_SHOWS_TARGET_NAME,
      targetName: PROMPT_SHOWS_TARGET_NAME
        ? getVisibleName(validation.requesterIdentity, validation.targetIdentity)
        : " ",
    });
  }

  async function routeAccessControl(pcFormId, targetFormId) {
    try {
      if (
        mp._vgrAccessControlApi &&
        typeof mp._vgrAccessControlApi.classifyObject === "function" &&
        mp._vgrAccessControlApi.classifyObject(targetFormId) &&
        typeof mp._vgrAccessControl === "function"
      ) {
        mp._vgrAccessControl(pcFormId, { kind: "inspect", targetFormId });
        return true;
      }
    } catch (e) {
      console.warn(LOG, "access-control route failed:", e && e.message ? e.message : e);
    }
    return false;
  }

  async function handleInspect(pcFormId, payload) {
    const targetFormId = Number(payload && payload.targetFormId);
    clearPrompt(pcFormId);
    const validation = validateLivingTarget(pcFormId, targetFormId);
    if (!validation.ok) {
      if (await routeAccessControl(pcFormId, targetFormId)) return;
      if (validation.dead) return;
      return;
    }
    const session = createSession(validation);
    pushMenu(session);
  }

  async function introduceSelf(pcFormId, payload) {
    const checked = validateSession(pcFormId, payload);
    if (!checked.ok) {
      pushToast(pcFormId, checked.reason);
      return;
    }

    if (!databaseReady || mutationDisabled) {
      pushToast(pcFormId, "Interaction services are temporarily unavailable.");
      return;
    }

    const session = checked.session;
    const requester = session.requesterIdentity;
    const target = session.targetIdentity;
    const key = helpers.introKey(target.characterId, requester.characterId);
    if (introCache.has(key)) {
      pushNameplates(session.targetPcFormId, true);
      pushMenu(session, "You have already introduced yourself to this player.");
      return;
    }

    const now = helpers.nowIso();
    const doc = {
      schemaVersion: 1,
      viewerCharacterId: target.characterId,
      knownCharacterId: requester.characterId,
      introducedByCharacterId: requester.characterId,
      knownNameSnapshot: requester.displayName,
      createdAt: now,
      updatedAt: now,
    };

    try {
      const { introductions } = await getCollections();
      const result = await introductions.updateOne(
        { viewerCharacterId: doc.viewerCharacterId, knownCharacterId: doc.knownCharacterId },
        { $setOnInsert: doc, $set: { updatedAt: now } },
        { upsert: true }
      );
      introCache.add(key);
      if (result && result.upsertedCount > 0) {
        pushToast(session.targetPcFormId, requester.displayName + " introduced themselves to you.");
        await writeAudit("introduce_self", requester, { viewerCharacterId: target.characterId, knownCharacterId: requester.characterId });
      }
      pushNameplates(session.targetPcFormId, true);
      pushNameplates(session.requesterPcFormId, true);
      pushMenu(session, "You introduced yourself.");
    } catch (e) {
      console.error(LOG, "introduction failed:", e && e.message ? e.message : e);
      pushToast(pcFormId, "Interaction services are temporarily unavailable.");
    }
  }

  function removeTradeRequest(request, reason) {
    if (!request || request.consumed) return;
    request.consumed = true;
    if (request.timeout) clearTimeout(request.timeout);
    pendingTradeRequests.delete(request.id);
    incomingTradeByActor.delete(request.targetPcFormId);
    outgoingTradeByActor.delete(request.requesterPcFormId);
    pushUi(request.requesterPcFormId, { action: "close", ui: "trade_request", focus: "release", reason: reason || "close" });
    pushUi(request.targetPcFormId, { action: "close", ui: "trade_request", focus: "release", reason: reason || "close" });
  }

  function expireTradeRequest(id) {
    const request = pendingTradeRequests.get(id);
    if (!request || request.consumed) return;
    removeTradeRequest(request, "expired");
    pushToast(request.requesterPcFormId, "Trade request expired.");
    pushToast(request.targetPcFormId, "Trade request expired.");
  }

  async function requestTrade(pcFormId, payload) {
    const checked = validateSession(pcFormId, payload);
    if (!checked.ok) {
      pushToast(pcFormId, checked.reason);
      return;
    }
    if (!TRADE_REQUESTS_ENABLED) {
      pushToast(pcFormId, "Trade requests are disabled.");
      return;
    }

    const session = checked.session;
    if (isActorRestrained(session.requesterIdentity)) {
      pushToast(pcFormId, "You cannot trade while restrained.");
      return;
    }
    if (isActorRestrained(session.targetIdentity)) {
      pushToast(pcFormId, "That player is busy.");
      return;
    }
    if (isTrading(session.requesterPcFormId) || isTrading(session.targetPcFormId)) {
      pushToast(pcFormId, "That player is busy.");
      return;
    }
    if (incomingTradeByActor.has(session.targetPcFormId) || outgoingTradeByActor.has(session.requesterPcFormId)) {
      pushToast(pcFormId, "That player is busy.");
      return;
    }
    const last = lastTradeRequestAt.get(pcFormId) || 0;
    if (Date.now() - last < TRADE_REQUEST_COOLDOWN_MS) {
      pushToast(pcFormId, "Trade request cooldown.");
      return;
    }

    closeSession(pcFormId, "trade_request");
    lastTradeRequestAt.set(pcFormId, Date.now());

    const id = randomToken("tr");
    const request = {
      id,
      requesterPcFormId: session.requesterPcFormId,
      targetPcFormId: session.targetPcFormId,
      requesterIdentity: session.requesterIdentity,
      targetIdentity: session.targetIdentity,
      createdAt: Date.now(),
      expiresAt: Date.now() + TRADE_REQUEST_TTL_MS,
      consumed: false,
      timeout: setTimeout(() => expireTradeRequest(id), TRADE_REQUEST_TTL_MS + 250),
    };

    pendingTradeRequests.set(id, request);
    incomingTradeByActor.set(request.targetPcFormId, id);
    outgoingTradeByActor.set(request.requesterPcFormId, id);

    const requesterSeesTarget = getVisibleName(request.requesterIdentity, request.targetIdentity);
    const targetSeesRequester = getVisibleName(request.targetIdentity, request.requesterIdentity);

    pushUi(request.requesterPcFormId, {
      action: "tradeRequest",
      ui: "trade_request",
      focus: "grab",
      mode: "outgoing",
      requestId: id,
      title: "TRADE REQUEST SENT",
      partnerName: requesterSeesTarget,
      message: "Waiting for response.",
      expiresAt: request.expiresAt,
    });
    pushUi(request.targetPcFormId, {
      action: "tradeRequest",
      ui: "trade_request",
      focus: "grab",
      mode: "incoming",
      requestId: id,
      title: "TRADE REQUEST",
      requesterName: targetSeesRequester,
      message: targetSeesRequester + " WANTS TO TRADE",
      expiresAt: request.expiresAt,
    });
    await writeAudit("trade_request_sent", request.requesterIdentity, { targetCharacterId: request.targetIdentity.characterId });
  }

  async function respondTradeRequest(pcFormId, payload) {
    const id = payload && payload.requestId;
    const response = String((payload && payload.response) || "").toLowerCase();
    const request = pendingTradeRequests.get(id);
    if (!request || request.consumed) {
      pushToast(pcFormId, "Trade request expired.");
      return;
    }
    if (Date.now() > request.expiresAt) {
      expireTradeRequest(id);
      return;
    }

    if (response === "cancel") {
      if (pcFormId !== request.requesterPcFormId) return;
      removeTradeRequest(request, "cancel");
      pushToast(request.targetPcFormId, "Trade request denied.");
      return;
    }

    if (pcFormId !== request.targetPcFormId) return;

    if (response !== "accept") {
      removeTradeRequest(request, "denied");
      pushToast(request.requesterPcFormId, "Trade request denied.");
      return;
    }

    const validation = validateLivingTarget(request.requesterPcFormId, request.targetPcFormId);
    if (!validation.ok || isActorRestrained(validation.requesterIdentity) || isActorRestrained(validation.targetIdentity)) {
      removeTradeRequest(request, "invalid");
      pushToast(request.requesterPcFormId, "That player is no longer available.");
      pushToast(request.targetPcFormId, "That player is no longer available.");
      return;
    }
    if (!mp._vgrTradingApi || typeof mp._vgrTradingApi.requestExactTargetTrade !== "function") {
      removeTradeRequest(request, "trade_service_missing");
      pushToast(request.requesterPcFormId, "Interaction services are temporarily unavailable.");
      pushToast(request.targetPcFormId, "Interaction services are temporarily unavailable.");
      return;
    }

    request.consumed = true;
    if (request.timeout) clearTimeout(request.timeout);
    pendingTradeRequests.delete(request.id);
    incomingTradeByActor.delete(request.targetPcFormId);
    outgoingTradeByActor.delete(request.requesterPcFormId);
    pushUi(request.requesterPcFormId, { action: "close", ui: "trade_request", focus: "release", reason: "accepted" });
    pushUi(request.targetPcFormId, { action: "close", ui: "trade_request", focus: "release", reason: "accepted" });

    const opened = mp._vgrTradingApi.requestExactTargetTrade(request.requesterPcFormId, request.targetPcFormId, {
      source: "player_interaction",
      visibleNames: {
        [request.requesterPcFormId]: getVisibleName(validation.requesterIdentity, validation.targetIdentity),
        [request.targetPcFormId]: getVisibleName(validation.targetIdentity, validation.requesterIdentity),
      },
    });
    if (!opened) {
      pushToast(request.requesterPcFormId, "That player is busy.");
      pushToast(request.targetPcFormId, "That player is busy.");
      return;
    }

    pushToast(request.requesterPcFormId, "Trade request accepted.");
    pushToast(request.targetPcFormId, "Trade request accepted.");
    await writeAudit("trade_request_accepted", request.targetIdentity, { requesterCharacterId: request.requesterIdentity.characterId });
  }

  async function applyBinds(pcFormId, session, cuffBaseId) {
    const validation = validateLivingTarget(session.requesterPcFormId, session.targetPcFormId);
    if (!validation.ok) {
      closeSession(pcFormId, "invalid_target");
      pushToast(pcFormId, validation.reason);
      return;
    }
    if (!databaseReady || mutationDisabled) {
      pushToast(pcFormId, "Interaction services are temporarily unavailable.");
      return;
    }
    if (isActorRestrained(validation.requesterIdentity)) {
      pushToast(pcFormId, "You cannot use bindings while restrained.");
      return;
    }
    if (isActorRestrained(validation.targetIdentity)) {
      pushToast(pcFormId, "That player is already restrained.");
      return;
    }

    // One bind mutation per target at a time so a concurrent apply cannot destroy a cuff.
    const lockKey = String(validation.targetIdentity.characterId);
    if (restraintWriteLocks.has(lockKey)) {
      pushToast(pcFormId, "That player is already restrained.");
      return;
    }
    restraintWriteLocks.add(lockKey);
    try {
      const requesterInvBefore = getInventory(validation.requesterPcFormId);
      const targetInvBefore = getInventory(validation.targetPcFormId);
      const taken = helpers.takeOneCuff(requesterInvBefore, cuffBaseId, CUFF_BASE_IDS);
      if (!taken) {
        pushToast(pcFormId, "You need a set of Prisoner's Cuffs.");
        return;
      }
      const targetNext = helpers.addCuff(targetInvBefore, taken.cuffEntry);
      const now = helpers.nowIso();
      const restraint = {
        schemaVersion: 1,
        active: true,
        targetCharacterId: validation.targetIdentity.characterId,
        targetProfileId: validation.targetIdentity.profileId,
        targetNameSnapshot: validation.targetIdentity.displayName,
        targetPcFormId: validation.targetPcFormId,
        binderCharacterId: validation.requesterIdentity.characterId,
        binderProfileId: validation.requesterIdentity.profileId,
        binderNameSnapshot: validation.requesterIdentity.displayName,
        binderPcFormId: validation.requesterPcFormId,
        cuffBaseId: Number(cuffBaseId),
        cuffEntry: taken.cuffEntry,
        createdAt: now,
        updatedAt: now,
      };

      try {
        const { restraints } = await getCollections();
        setInventory(validation.requesterPcFormId, taken.inventory);
        setInventory(validation.targetPcFormId, targetNext);
        await restraints.insertOne(restraint);
        activeRestraints.set(restraint.targetCharacterId, restraint);
        mp.set(validation.targetPcFormId, "vgrRestraintState", {
          active: true,
          binderName: getVisibleName(validation.targetIdentity, validation.requesterIdentity),
          cuffBaseId: restraint.cuffBaseId,
          updatedAt: now,
        });
        closeSession(pcFormId, "binds_applied");
        pushToast(validation.requesterPcFormId, "Bindings applied.");
        pushToast(validation.targetPcFormId, "You have been restrained by " + getVisibleName(validation.targetIdentity, validation.requesterIdentity) + ".");
        await writeAudit("bindings_applied", validation.requesterIdentity, {
          targetCharacterId: validation.targetIdentity.characterId,
          cuffBaseId: restraint.cuffBaseId,
        });
      } catch (e) {
        try {
          setInventory(validation.requesterPcFormId, requesterInvBefore);
          setInventory(validation.targetPcFormId, targetInvBefore);
        } catch (_) {}
        console.error(LOG, "apply binds failed:", e && e.message ? e.message : e);
        pushToast(pcFormId, "Interaction services are temporarily unavailable.");
      }
    } finally {
      restraintWriteLocks.delete(lockKey);
    }
  }

  async function handleUseBinds(pcFormId, payload) {
    const checked = validateSession(pcFormId, payload);
    if (!checked.ok) {
      pushToast(pcFormId, checked.reason);
      return;
    }
    const session = checked.session;
    session.cuffOptions = helpers.findCuffOptions(getInventory(pcFormId), CUFF_BASE_IDS);
    if (!session.cuffOptions.length) {
      pushToast(pcFormId, "You need a set of Prisoner's Cuffs.");
      return;
    }
    if (session.cuffOptions.length === 1) {
      await applyBinds(pcFormId, session, session.cuffOptions[0].baseId);
      return;
    }
    pushUi(pcFormId, {
      action: "bindOptions",
      ui: "player_interaction",
      focus: "grab",
      sessionId: session.id,
      targetName: getVisibleName(session.requesterIdentity, session.targetIdentity),
      options: session.cuffOptions.map((entry) => ({
        baseId: entry.baseId,
        count: entry.count,
        label: cuffLabel(entry.baseId),
      })),
      expiresAt: session.expiresAt,
    });
  }

  async function removeBinds(pcFormId, payload) {
    const checked = validateSession(pcFormId, payload);
    if (!checked.ok) {
      pushToast(pcFormId, checked.reason);
      return;
    }
    if (!databaseReady || mutationDisabled) {
      pushToast(pcFormId, "Interaction services are temporarily unavailable.");
      return;
    }
    const session = checked.session;
    const restraint = getRestraintForIdentity(session.targetIdentity);
    if (!restraint) {
      pushMenu(session, "Bindings already removed.");
      return;
    }
    const admin = hasAdmin(pcFormId);
    const isBinder = String(restraint.binderCharacterId) === String(session.requesterIdentity.characterId);
    if (!isBinder && !admin) {
      pushToast(pcFormId, "You cannot remove those bindings.");
      return;
    }

    // One bind mutation per target at a time so a concurrent release cannot mint a cuff.
    const lockKey = String(restraint.targetCharacterId);
    if (restraintWriteLocks.has(lockKey)) {
      pushToast(pcFormId, "That player is busy.");
      return;
    }
    restraintWriteLocks.add(lockKey);
    try {
      const targetInvBefore = getInventory(session.targetPcFormId);
      const requesterInvBefore = getInventory(session.requesterPcFormId);
      let targetNext = targetInvBefore;
      let requesterNext = requesterInvBefore;
      const shouldReturn =
        isBinder
          ? NORMAL_RELEASE_ITEM_POLICY === "return_to_releaser"
          : ADMIN_RELEASE_ITEM_POLICY === "return_to_releaser";
      const removed = helpers.removeOneCuff(targetInvBefore, restraint.cuffBaseId, CUFF_BASE_IDS);
      if (removed) {
        targetNext = removed.inventory;
        if (shouldReturn) requesterNext = helpers.addCuff(requesterInvBefore, removed.cuffEntry);
      }

      try {
        const { restraints } = await getCollections();
        setInventory(session.targetPcFormId, targetNext);
        if (shouldReturn && removed) setInventory(session.requesterPcFormId, requesterNext);
        await restraints.updateOne(
          { targetCharacterId: String(restraint.targetCharacterId), active: true },
          { $set: { active: false, releasedAt: helpers.nowIso(), releasedByCharacterId: session.requesterIdentity.characterId, updatedAt: helpers.nowIso() } }
        );
        activeRestraints.delete(String(restraint.targetCharacterId));
        mp.set(session.targetPcFormId, "vgrRestraintState", { active: false, updatedAt: helpers.nowIso() });
        closeSession(pcFormId, "binds_removed");
        pushToast(session.requesterPcFormId, "Bindings removed.");
        pushToast(session.targetPcFormId, "Your bindings were removed.");
        await writeAudit(isBinder ? "bindings_removed" : "bindings_force_removed", session.requesterIdentity, {
          targetCharacterId: session.targetIdentity.characterId,
          cuffBaseId: restraint.cuffBaseId,
        });
      } catch (e) {
        try {
          setInventory(session.targetPcFormId, targetInvBefore);
          setInventory(session.requesterPcFormId, requesterInvBefore);
        } catch (_) {}
        console.error(LOG, "remove binds failed:", e && e.message ? e.message : e);
        pushToast(pcFormId, "Interaction services are temporarily unavailable.");
      }
    } finally {
      restraintWriteLocks.delete(lockKey);
    }
  }

  // Death releases the restraint so it cannot wedge across respawn; the cuff
  // item stays with the target because there is no releaser to return it to.
  async function releaseRestraintOnDeath(pcFormId) {
    const who = getActorIdentity(pcFormId);
    const restraint = who ? activeRestraints.get(String(who.characterId)) : null;
    if (!restraint) return;
    activeRestraints.delete(String(restraint.targetCharacterId));
    try {
      mp.set(pcFormId, "vgrRestraintState", { active: false, updatedAt: helpers.nowIso() });
    } catch (e) {}
    try {
      const { restraints } = await getCollections();
      await restraints.updateOne(
        { targetCharacterId: String(restraint.targetCharacterId), active: true },
        { $set: { active: false, releasedAt: helpers.nowIso(), releasedByCharacterId: null, releaseReason: "death", updatedAt: helpers.nowIso() } }
      );
      await writeAudit("bindings_released_on_death", who, {
        targetCharacterId: restraint.targetCharacterId,
        cuffBaseId: restraint.cuffBaseId,
      });
    } catch (e) {
      console.error(LOG, "release on death persistence failed:", e && e.message ? e.message : e);
    }
  }

  async function handleSelect(pcFormId, payload) {
    const checked = validateSession(pcFormId, payload);
    if (!checked.ok) {
      pushToast(pcFormId, checked.reason);
      return;
    }
    const actionId = String(payload && payload.actionId || "");
    if (!checked.session.actionIds.has(actionId)) {
      pushToast(pcFormId, "Invalid interaction action.");
      return;
    }
    if (actionId === "introduce_self") return introduceSelf(pcFormId, payload);
    if (actionId === "request_trade") return requestTrade(pcFormId, payload);
    if (actionId === "use_binds") return handleUseBinds(pcFormId, payload);
    if (actionId === "remove_binds") return removeBinds(pcFormId, payload);
  }

  async function handleBindVariant(pcFormId, payload) {
    const checked = validateSession(pcFormId, payload);
    if (!checked.ok) {
      pushToast(pcFormId, checked.reason);
      return;
    }
    const baseId = Number(payload && payload.baseId);
    if (!checked.session.cuffOptions.some((entry) => Number(entry.baseId) === baseId)) {
      pushToast(pcFormId, "Invalid cuffs selection.");
      return;
    }
    await applyBinds(pcFormId, checked.session, baseId);
  }

  async function handleEvent(pcFormId, payload) {
    if (!payload || typeof payload !== "object") return;
    if (payload.kind === "prompt") return handlePrompt(pcFormId, payload);
    if (payload.kind === "promptClear") return clearPrompt(pcFormId);
    if (payload.kind === "nameplatesRefresh") return pushNameplates(pcFormId);
    if (payload.kind === "nameplatesClear") return clearNameplates(pcFormId);
    if (payload.kind === "inspect") return handleInspect(pcFormId, payload);
    if (payload.kind === "close") return closeSession(pcFormId, "close");
    if (payload.kind === "select") return handleSelect(pcFormId, payload);
    if (payload.kind === "bindVariant") return handleBindVariant(pcFormId, payload);
    if (payload.kind === "tradeResponse") return respondTradeRequest(pcFormId, payload);
  }

  const previousOnActivate = typeof mp.onActivate === "function" ? mp.onActivate : null;
  mp.onActivate = (targetFormId, actorFormId) => {
    if (targetFormId && actorFormId && targetFormId !== actorFormId && isOnlinePlayer(targetFormId)) {
      return false;
    }
    return previousOnActivate ? previousOnActivate(targetFormId, actorFormId) : true;
  };

  mp.makeProperty("vgrRestraintState", {
    isVisibleByOwner: true,
    isVisibleByNeighbors: false,
    updateOwner: `
      const value = ctx.value || {};
      ctx.state.vgrRestraint = {
        active: value.active === true,
        binderName: value.binderName || "",
        cuffBaseId: value.cuffBaseId || 0,
        updatedAt: value.updatedAt || null
      };
    `,
    updateNeighbor: "",
  });

  mp.makeProperty("vgrPlayerNameplates", {
    isVisibleByOwner: true,
    isVisibleByNeighbors: false,
    updateOwner: `
      const value = ctx.value || {};
      if (!ctx.state.vgrPlayerNameplates) ctx.state.vgrPlayerNameplates = { lastNonce: null, texts: {} };
      const state = ctx.state.vgrPlayerNameplates;
      if (!state.texts) state.texts = {};

      const destroyKey = (key) => {
        const entry = state.texts[key];
        if (!entry) return;
        try {
          if (ctx.sp && typeof ctx.sp.setTextRefr === "function") ctx.sp.setTextRefr(entry.textId, 0);
        } catch (_) {}
        try {
          if (ctx.sp && typeof ctx.sp.destroyText === "function") ctx.sp.destroyText(entry.textId);
        } catch (_) {}
        delete state.texts[key];
      };

      const destroyAll = () => {
        for (const key of Object.keys(state.texts)) destroyKey(key);
      };

      if (!value || value.version !== ${UI_VERSION} || value.enabled === false) {
        destroyAll();
        state.lastNonce = value ? value.nonce : null;
        return;
      }

      if (state.lastNonce === value.nonce) return;
      state.lastNonce = value.nonce;

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
        let entry = state.texts[key];
        if (!entry) {
          let textId = 0;
          try { textId = sp.createText(0, 0, name, color, font); } catch (_) {}
          if (!textId) continue;
          entry = { textId, text: "", target: 0 };
          state.texts[key] = entry;
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

      for (const key of Object.keys(state.texts)) {
        if (!keep[key]) destroyKey(key);
      }
    `,
    updateNeighbor: "",
  });

  mp.makeProperty("vgrPlayerInteractionUi", {
    isVisibleByOwner: true,
    isVisibleByNeighbors: false,
    updateOwner: `
      const value = ctx.value;
      if (!ctx.state.vgrPlayerInteractionUi) ctx.state.vgrPlayerInteractionUi = { lastNonce: null };
      if (!value || value.version !== ${UI_VERSION}) return;
      if (ctx.state.vgrPlayerInteractionUi.lastNonce === value.nonce) return;
      ctx.state.vgrPlayerInteractionUi.lastNonce = value.nonce;

      ctx.sp.browser.executeJavaScript("window.vgrPlayerInteractionUpdate && window.vgrPlayerInteractionUpdate(" + JSON.stringify(value) + ");");

      if (value.focus === "grab" && value.ui) {
        ctx.sp.browser.executeJavaScript('window.skyrimPlatform?.sendMessage?.("vgr:ui:open", "' + value.ui + '")');
      }
      if (value.focus === "release" && value.ui) {
        ctx.sp.browser.executeJavaScript('window.skyrimPlatform?.sendMessage?.("vgr:ui:close", "' + value.ui + '")');
      }
    `,
    updateNeighbor: "",
  });

  mp.makeEventSource("_vgrContextualX", `
    ctx.sp.printConsole("[VGR contextual_x] event source loaded");

    if (!ctx.state.vgrContextualX) {
      ctx.state.vgrContextualX = {
        xDown: false,
        targetFormId: 0,
        promptSentAt: 0,
        promptPollAt: 0,
        promptVisible: false,
        nameplatesSentAt: 0,
        nameplatesVisible: false
      };
    }

    const nativeMenusToBlock = [
      "BarterMenu",
      "Book Menu",
      "Console",
      "ContainerMenu",
      "Crafting Menu",
      "Dialogue Menu",
      "FavoritesMenu",
      "GiftMenu",
      "InventoryMenu",
      "Journal Menu",
      "Loading Menu",
      "Lockpicking Menu",
      "MagicMenu",
      "MapMenu",
      "RaceSex Menu",
      "Sleep/Wait Menu",
      "StatsMenu",
      "Training Menu",
      "TweenMenu"
    ];

    const isNativeMenuOpen = () => {
      try { if (ctx.sp.Ui.isTextInputEnabled()) return true; } catch (_) {}
      if (ctx.state.vgrUi && typeof ctx.state.vgrUi.isNativeMenuOpen === "function" && ctx.state.vgrUi.isNativeMenuOpen()) return true;
      for (const menuName of nativeMenusToBlock) {
        try { if (ctx.sp.Ui.isMenuOpen(menuName)) return true; } catch (_) {}
      }
      return false;
    };

    const isBlockingUiOpen = () => {
      if (isNativeMenuOpen()) return true;
      if (ctx.state.vgrUi && ctx.state.vgrUi.activeUI) return true;
      return false;
    };

    const currentTargetFormId = () => {
      let target = null;
      try { target = ctx.sp.Game.getCurrentCrosshairRef(); } catch (_) { return 0; }
      if (!target || typeof target.getFormID !== "function") return 0;
      try { return ctx.getFormIdInServerFormat(target.getFormID()) || 0; } catch (_) { return 0; }
    };

    const clearPrompt = () => {
      if (!ctx.state.vgrContextualX.promptVisible && !ctx.state.vgrContextualX.targetFormId) return;
      ctx.state.vgrContextualX.promptVisible = false;
      ctx.state.vgrContextualX.targetFormId = 0;
      ctx.state.vgrContextualX.promptSentAt = 0;
      ctx.sendEvent({ kind: "promptClear" });
    };

    const clearNameplates = () => {
      if (!${NAMEPLATES_ENABLED}) return;
      if (!ctx.state.vgrContextualX.nameplatesVisible) return;
      ctx.state.vgrContextualX.nameplatesVisible = false;
      ctx.state.vgrContextualX.nameplatesSentAt = 0;
      ctx.sendEvent({ kind: "nameplatesClear" });
    };

    const refreshNameplates = (now) => {
      if (!${NAMEPLATES_ENABLED}) return;
      if (now - (ctx.state.vgrContextualX.nameplatesSentAt || 0) < ${NAMEPLATE_REFRESH_MS}) return;
      ctx.state.vgrContextualX.nameplatesSentAt = now;
      ctx.state.vgrContextualX.nameplatesVisible = true;
      ctx.sendEvent({ kind: "nameplatesRefresh" });
    };

    ctx.sp.on("update", () => {
      const now = Date.now();
      if (now - (ctx.state.vgrContextualX.promptPollAt || 0) < ${PROMPT_REFRESH_MS}) return;
      ctx.state.vgrContextualX.promptPollAt = now;

      if (isBlockingUiOpen()) {
        clearPrompt();
        clearNameplates();
        return;
      }

      refreshNameplates(now);

      const targetFormId = currentTargetFormId();
      if (!targetFormId) {
        clearPrompt();
        return;
      }

      if (
        targetFormId !== ctx.state.vgrContextualX.targetFormId ||
        now - (ctx.state.vgrContextualX.promptSentAt || 0) > 500
      ) {
        ctx.state.vgrContextualX.targetFormId = targetFormId;
        ctx.state.vgrContextualX.promptSentAt = now;
        ctx.state.vgrContextualX.promptVisible = true;
        ctx.sendEvent({ kind: "prompt", targetFormId });
      }
    });

    ctx.sp.on("buttonEvent", (e) => {
      // Launcher rebind in skymp5-client-settings.txt wins over the server key
      if (ctx.state.vgrContextualX.keyDik === undefined) {
        let localKey = 0;
        try {
          const s = ctx.sp.settings["skymp5-client"] || {};
          localKey = Number(s.interactMenuKeyCode) || 0;
        } catch (err) { }
        ctx.state.vgrContextualX.keyDik = localKey > 0 && localKey <= 255 ? localKey : ${INTERACTION_KEY_DIK};
      }
      if (!e || e.code !== ctx.state.vgrContextualX.keyDik) return;
      if (!e.isPressed) {
        ctx.state.vgrContextualX.xDown = false;
        return;
      }
      if (ctx.state.vgrContextualX.xDown) return;
      ctx.state.vgrContextualX.xDown = true;
      if (isBlockingUiOpen()) return;
      clearPrompt();

      ctx.sp.once("update", () => {
        if (isBlockingUiOpen()) return;
        const targetFormId = currentTargetFormId();
        if (!targetFormId) return;
        ctx.sendEvent({ kind: "inspect", targetFormId });
      });
    });

    ctx.sp.on("browserMessage", (e) => {
      const msg = e.arguments && e.arguments[0];
      const payload = e.arguments && e.arguments[1];
      if (msg === "vgr:playerInteraction:close" || (msg === "vgr:ui:close" && payload === "player_interaction")) {
        ctx.sendEvent({ kind: "close" });
      } else if (msg === "vgr:playerInteraction:select") {
        ctx.sendEvent(Object.assign({ kind: "select" }, payload || {}));
      } else if (msg === "vgr:playerInteraction:bindVariant") {
        ctx.sendEvent(Object.assign({ kind: "bindVariant" }, payload || {}));
      } else if (msg === "vgr:tradeRequest:respond") {
        ctx.sendEvent(Object.assign({ kind: "tradeResponse" }, payload || {}));
      } else if (msg === "vgr:ui:close" && payload === "trade_request") {
        ctx.sendEvent({ kind: "tradeResponse", response: "deny" });
      }
    });
  `);

  mp._vgrContextualX = (pcFormId, payload) => {
    handleEvent(pcFormId, payload).catch((e) => {
      console.error(LOG, "event handler failed:", e && e.stack ? e.stack : e);
      pushToast(pcFormId, "Interaction services are temporarily unavailable.");
    });
  };

  mp._vgrPlayerInteractionsApi = {
    isRestrained: isActorRestrained,
    getVisibleName,
    notify: pushToast,
    cancelForActor(pcFormId, reason) {
      closeSession(pcFormId, reason || "cancel");
      const outgoing = outgoingTradeByActor.get(pcFormId);
      if (outgoing) removeTradeRequest(pendingTradeRequests.get(outgoing), reason || "cancel");
      const incoming = incomingTradeByActor.get(pcFormId);
      if (incoming) removeTradeRequest(pendingTradeRequests.get(incoming), reason || "cancel");
    },
    state() {
      return {
        databaseReady,
        mutationDisabled,
        introductions: introCache.size,
        activeRestraints: activeRestraints.size,
        sessions: sessionsById.size,
        pendingTradeRequests: pendingTradeRequests.size,
        nameplatesEnabled: NAMEPLATES_ENABLED,
        nameplateViews: nameplateSigByActor.size,
      };
    },
  };

  // Connect and disconnect callbacks receive the user id, not the actor form id.
  const actorLink = vgrHelpers.playerInteractions.createActorHelpers(mp, {});

  mp.on("connect", (userId) => {
    try {
      const pcFormId = actorLink.actorFromUser(userId);
      if (pcFormId) pushNameplates(pcFormId, true);
      refreshNameplatesForOnline();
    } catch (e) {}
  });

  mp.on("disconnect", (userId) => {
    try {
      const pcFormId = actorLink.actorFromUser(userId);
      if (pcFormId) {
        closeSession(pcFormId, "disconnect");
        clearPrompt(pcFormId);
        clearNameplates(pcFormId);
        const outgoing = outgoingTradeByActor.get(pcFormId);
        if (outgoing) removeTradeRequest(pendingTradeRequests.get(outgoing), "disconnect");
        const incoming = incomingTradeByActor.get(pcFormId);
        if (incoming) removeTradeRequest(pendingTradeRequests.get(incoming), "disconnect");
        permissions.invalidate(pcFormId);
      }
      refreshNameplatesForOnline();
    } catch (e) {
    } finally {
      actorLink.forgetUser(userId);
    }
  });

  if (RELEASE_ON_DEATH && typeof mp.vgrOnDeath === "function") {
    mp.vgrOnDeath((actorId) => {
      releaseRestraintOnDeath(actorId).catch((e) => {
        console.error(LOG, "release on death failed:", e && e.message ? e.message : e);
      });
    });
  }

  loadPersistentState();
  console.log(LOG, "module loaded; contextual X key authority installed on DIK", INTERACTION_KEY_DIK);
};
