"use strict";

module.exports = (mp) => {
  const LOG = "[VGR access]";
  const UI_VERSION = 1;
  const MANAGE_PERMISSION = "vgr.access.manage";
  const identity = require("./vgr_access_identity");

  let settings = {};
  try {
    settings = mp.getServerSettings ? mp.getServerSettings() : {};
  } catch (e) {
    console.error(LOG, "failed to read server settings:", e);
  }

  const config = settings.vgrAccessControl || {};
  if (config.enabled === false) {
    console.info(LOG, "extension disabled by vgrAccessControl.enabled=false");
    return;
  }

  const DB_NAME = config.databaseName || "vengeful_realms";
  const COLLECTION_NAME = config.collection || "vgr_access_objects";
  const BACKEND_DB_NAME = config.backendDatabaseName || "skymp-backend";
  const CHARACTERS_COLLECTION = config.charactersCollection || "characters";
  const MAX_USERS = Math.max(1, Math.min(200, Math.floor(Number(config.maxUsersPerObject) || 50)));
  const MAX_DISTANCE = Math.max(64, Number(config.maxInteractionDistance) || 350);
  const SESSION_TARGET_TTL_MS = Math.max(1000, Number(config.sessionTargetTtlMs) || 15000);
  const SESSION_IDLE_MS = Math.max(10000, Number(config.sessionIdleMs) || 60000);
  const SESSION_ABSOLUTE_MS = Math.max(60000, Number(config.sessionAbsoluteMs) || 300000);
  const SEARCH_RATE_MS = Math.max(250, Number(config.searchRateMs) || 700);

  let MongoClient = null;
  try {
    MongoClient = require("mongodb").MongoClient;
  } catch (e) {
    console.error(LOG, "MongoDB driver missing. Access control will fail closed.");
  }

  const permissions = require("./vgr_access_permissions")(mp, settings);
  const doorPair = require("./vgr_access_door_pair")(mp);
  const crypto = require("crypto");

  const byHex = new Map();
  const byFormDesc = new Map();
  const byObjectId = new Map();
  const sessions = new Map();
  const watchersByObject = new Map();
  const watchByActor = new Map();
  const openUiActors = new Set();
  const defaultActivatePass = new Set();
  const searchRate = new Map();

  let accessClientPromise = null;
  let backendClientPromise = null;
  let indexPromise = null;
  let startupLoaded = false;
  let databaseReady = false;
  let mutationDisabled = true;

  function deriveMongoUri(dbName) {
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

  const ACCESS_URI = config.databaseUri || deriveMongoUri(DB_NAME);
  const BACKEND_URI = config.backendDatabaseUri || deriveMongoUri(BACKEND_DB_NAME);

  function hex(value) {
    return doorPair.hex(value);
  }

  function randomToken() {
    if (crypto && crypto.randomBytes) return crypto.randomBytes(18).toString("base64url");
    throw new Error("crypto.randomBytes is unavailable");
  }

  function getAccessDb() {
    if (!MongoClient) return Promise.reject(new Error("MongoDB driver is not installed"));
    if (!ACCESS_URI) return Promise.reject(new Error("No MongoDB URI configured for access DB"));
    if (!accessClientPromise) accessClientPromise = MongoClient.connect(ACCESS_URI, { maxPoolSize: 8 });
    return accessClientPromise.then((client) => client.db(DB_NAME));
  }

  function getBackendDb() {
    if (!MongoClient) return Promise.reject(new Error("MongoDB driver is not installed"));
    if (!BACKEND_URI) return Promise.reject(new Error("No MongoDB URI configured for backend DB"));
    if (!backendClientPromise) backendClientPromise = MongoClient.connect(BACKEND_URI, { maxPoolSize: 4 });
    return backendClientPromise.then((client) => client.db(BACKEND_DB_NAME));
  }

  async function getCollection() {
    const collection = (await getAccessDb()).collection(COLLECTION_NAME);
    if (!indexPromise) {
      indexPromise = Promise.all([
        collection.createIndex({ "refs.formIdHex": 1 }),
        collection.createIndex({ "refs.formDesc": 1 }),
        collection.createIndex({ "owner.profileId": 1 }),
        collection.createIndex({ "users.profileId": 1 }),
        collection.createIndex({ updatedAt: -1 }),
      ]);
    }
    await indexPromise;
    return collection;
  }

  function normalizeRef(ref) {
    if (!ref || !ref.formDesc) return null;
    return {
      formDesc: String(ref.formDesc),
      formIdHex: ref.formIdHex ? String(ref.formIdHex).toUpperCase() : "",
      worldOrCellDesc: ref.worldOrCellDesc ? String(ref.worldOrCellDesc) : "",
      position: Array.isArray(ref.position) ? ref.position.slice(0, 3).map((n) => Number(n) || 0) : [0, 0, 0],
    };
  }

  function normalizeRefs(refs) {
    const seen = new Set();
    const out = [];
    for (const ref of Array.isArray(refs) ? refs : []) {
      const normalized = normalizeRef(ref);
      if (!normalized) continue;
      const key = normalized.formDesc.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(normalized);
    }
    return out;
  }

  function normalizeDoc(doc) {
    if (!doc || !doc._id) return null;
    const refs = normalizeRefs(doc.refs);
    if (!refs.length) return null;
    return Object.assign({}, doc, {
      _id: String(doc._id),
      schemaVersion: 2,
      objectType: doc.objectType === "door" ? "door" : "container",
      displayName: identity.normalizeName(doc.displayName, doc.objectType === "door" ? "Door" : "Container"),
      refs,
      owner: identity.publicCharacter(doc.owner),
      users: Array.isArray(doc.users) ? doc.users.map(identity.publicCharacter).filter(Boolean) : [],
      locked: doc.locked !== false,
      revision: Math.max(1, Math.floor(Number(doc.revision) || 1)),
    });
  }

  function docCacheKeys(doc) {
    const normalized = normalizeDoc(doc);
    if (!normalized) return { hexKeys: [], descKeys: [] };
    const hexKeys = [];
    const descKeys = [];
    for (const ref of normalized.refs) {
      if (ref.formIdHex) hexKeys.push(ref.formIdHex.toUpperCase());
      if (ref.formDesc) descKeys.push(ref.formDesc.toLowerCase());
    }
    return { hexKeys, descKeys };
  }

  function uncacheDoc(doc) {
    const keys = docCacheKeys(doc);
    for (const key of keys.hexKeys) byHex.delete(key);
    for (const key of keys.descKeys) byFormDesc.delete(key);
    if (doc && doc._id) byObjectId.delete(String(doc._id));
  }

  function cacheDoc(doc) {
    const normalized = normalizeDoc(doc);
    if (!normalized) return null;
    byObjectId.set(normalized._id, normalized);
    for (const ref of normalized.refs) {
      if (ref.formIdHex) byHex.set(ref.formIdHex.toUpperCase(), normalized);
      if (ref.formDesc) byFormDesc.set(ref.formDesc.toLowerCase(), normalized);
    }
    return normalized;
  }

  async function loadCache() {
    try {
      const collection = await getCollection();
      const docs = await collection.find({ schemaVersion: { $gte: 2 } }).toArray();
      byHex.clear();
      byFormDesc.clear();
      byObjectId.clear();
      for (const doc of docs) cacheDoc(doc);
      startupLoaded = true;
      databaseReady = true;
      mutationDisabled = false;
      console.log(LOG, "cache loaded:", docs.length, "objects");
      return true;
    } catch (e) {
      databaseReady = false;
      mutationDisabled = true;
      console.error(LOG, "startup cache load failed; access control is fail-closed:", e && e.message ? e.message : e);
      return false;
    }
  }

  function markRuntimeDbOutage(err) {
    mutationDisabled = true;
    databaseReady = startupLoaded;
    console.error(LOG, "database mutation disabled; enforcing last known cache:", err && err.message ? err.message : err);
  }

  function getFormDesc(formId) {
    try {
      return String(mp.getDescFromId(formId) || "");
    } catch (e) {
      return "";
    }
  }

  function getObjectMeta(targetFormId) {
    let worldOrCellDesc = "";
    let position = [0, 0, 0];
    try {
      worldOrCellDesc = String(mp.get(targetFormId, "worldOrCellDesc") || "");
    } catch (e) {
      worldOrCellDesc = "";
    }
    try {
      const raw = mp.get(targetFormId, "pos") || mp.get(targetFormId, "position");
      if (Array.isArray(raw)) position = raw.slice(0, 3).map((n) => Number(n) || 0);
    } catch (e) {
      position = [0, 0, 0];
    }
    return { worldOrCellDesc, position };
  }

  function classifyFromRecord(record, fallbackName) {
    if (!record) return null;
    const recordType = String(record.type || record.recordType || "").toUpperCase();
    const editorId = String(record.editorId || "");
    const displayName = identity.normalizeName(record.fullName || record.name || editorId, fallbackName);
    if (recordType.indexOf("DOOR") !== -1) return { objectType: "door", displayName: displayName || "Door" };
    if (recordType.indexOf("CONT") !== -1) return { objectType: "container", displayName: displayName || "Container" };
    return null;
  }

  function classifyObject(targetFormId) {
    let baseDesc = "";
    try {
      baseDesc = String(mp.get(targetFormId, "baseDesc") || "");
    } catch (e) {
      baseDesc = "";
    }
    if (baseDesc) {
      try {
        const lookup = mp.lookupEspmRecordById(mp.getIdFromDesc(baseDesc));
        const classified = classifyFromRecord(lookup && lookup.record, baseDesc);
        if (classified) return classified;
      } catch (e) {
        // Continue to container runtime fallback.
      }
    }
    try {
      if (mp.get(targetFormId, "baseContainerAdded")) return { objectType: "container", displayName: "Container" };
    } catch (e) {
      // Not a supported runtime container.
    }
    return null;
  }

  function describeTarget(targetFormId, classification) {
    const formDesc = getFormDesc(targetFormId);
    if (!formDesc) return { error: "Could not resolve target identity" };

    if (classification.objectType === "door") {
      const passage = doorPair.resolveDoorPassage(targetFormId, getObjectMeta);
      if (passage && Array.isArray(passage.refs) && passage.refs.length) {
        return {
          objectId: passage.objectId,
          objectType: "door",
          displayName: classification.displayName || "Door",
          refs: normalizeRefs(passage.refs),
          teleport: passage.teleport === true,
          linksBack: passage.linksBack === true,
          pairWarning: passage.teleport === true && passage.linksBack !== true ? "Paired door does not link back cleanly" : null,
        };
      }
      return { error: passage && passage.error ? passage.error : "Could not resolve door passage" };
    }

    const ref = doorPair.buildRefEntry(formDesc, getObjectMeta, targetFormId);
    return {
      objectId: "container:" + formDesc,
      objectType: "container",
      displayName: classification.displayName || "Container",
      refs: normalizeRefs([ref]),
      teleport: false,
      linksBack: false,
      pairWarning: null,
    };
  }

  function distanceSquared(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b)) return Infinity;
    return [0, 1, 2].reduce((sum, index) => {
      const delta = (Number(a[index]) || 0) - (Number(b[index]) || 0);
      return sum + delta * delta;
    }, 0);
  }

  function validateTargetReach(pcFormId, targetFormId) {
    let actorCell = "";
    let targetCell = "";
    let actorPos = null;
    let targetPos = null;
    try {
      actorCell = String(mp.get(pcFormId, "worldOrCellDesc") || "");
      actorPos = mp.get(pcFormId, "pos") || mp.get(pcFormId, "position");
    } catch (e) {
      return { ok: false, reason: "Could not validate your position" };
    }
    try {
      targetCell = String(mp.get(targetFormId, "worldOrCellDesc") || "");
      targetPos = mp.get(targetFormId, "pos") || mp.get(targetFormId, "position");
    } catch (e) {
      return { ok: false, reason: "Could not validate target position" };
    }
    if (actorCell && targetCell && actorCell !== targetCell) return { ok: false, reason: "Target is not in your current cell" };
    if (distanceSquared(actorPos, targetPos) > MAX_DISTANCE * MAX_DISTANCE) return { ok: false, reason: "Target is too far away" };
    return { ok: true };
  }

  function getDocByTarget(targetFormId) {
    const hexKey = hex(targetFormId);
    if (byHex.has(hexKey)) return byHex.get(hexKey);
    const desc = getFormDesc(targetFormId);
    if (desc && byFormDesc.has(desc.toLowerCase())) return byFormDesc.get(desc.toLowerCase());
    return null;
  }

  function asForm(formId) {
    return { type: "form", desc: mp.getDescFromId(formId) };
  }

  function activateKey(targetFormId, actorFormId) {
    return String(targetFormId) + ":" + String(actorFormId);
  }

  function runDefaultActivate(targetFormId, actorFormId) {
    const key = activateKey(targetFormId, actorFormId);
    defaultActivatePass.add(key);
    try {
      mp.callPapyrusFunction("method", "ObjectReference", "Activate", asForm(targetFormId), [asForm(actorFormId), true]);
    } catch (e) {
      defaultActivatePass.delete(key);
      console.error(LOG, "default activation failed:", e && e.message ? e.message : e);
    }
  }

  function pushUi(pcFormId, payload) {
    const now = Date.now();
    const uiTtlMs = payload && payload.focus === "grab" ? SESSION_ABSOLUTE_MS : 30000;
    const value = Object.assign({ version: UI_VERSION, nonce: randomToken(), issuedAt: now, expiresAt: now + uiTtlMs }, payload || {});
    if (value.focus === "grab" || value.action === "context" || value.action === "manage") openUiActors.add(pcFormId);
    if (value.focus === "release" || value.action === "close") openUiActors.delete(pcFormId);
    try {
      mp.set(pcFormId, "vgrAccessControlUi", value);
    } catch (e) {
      console.error(LOG, "push UI failed:", e && e.message ? e.message : e);
    }
  }

  function pushToast(pcFormId, message) {
    pushUi(pcFormId, { action: "toast", toastOnly: true, message: String(message || "") });
  }

  function pushHintClear(pcFormId) {
    pushUi(pcFormId, { action: "hintClear" });
  }

  function pushAccessHint(pcFormId, doc) {
    if (!doc) {
      pushHintClear(pcFormId);
      return;
    }
    const normalized = normalizeDoc(doc);
    if (!normalized) {
      pushHintClear(pcFormId);
      return;
    }
    pushUi(pcFormId, {
      action: "hint",
      objectType: normalized.objectType,
      locked: normalized.locked === true,
      ownerName: normalized.owner && normalized.owner.displayName ? normalized.owner.displayName : "Unassigned",
    });
  }

  function clearWatch(pcFormId) {
    const objectId = watchByActor.get(pcFormId);
    if (objectId) {
      const watchers = watchersByObject.get(objectId);
      if (watchers) {
        watchers.delete(pcFormId);
        if (!watchers.size) watchersByObject.delete(objectId);
      }
    }
    watchByActor.delete(pcFormId);
  }

  function watchObject(pcFormId, objectId) {
    clearWatch(pcFormId);
    if (!objectId) return;
    if (!watchersByObject.has(objectId)) watchersByObject.set(objectId, new Set());
    watchersByObject.get(objectId).add(pcFormId);
    watchByActor.set(pcFormId, objectId);
  }

  function closeSession(pcFormId, reason) {
    sessions.delete(pcFormId);
    clearWatch(pcFormId);
    if (openUiActors.has(pcFormId)) pushUi(pcFormId, { action: "close", focus: "release", reason: reason || "close" });
  }

  function createSession(pcFormId, targetFormId, doc, descriptor) {
    const now = Date.now();
    const session = {
      id: randomToken(),
      pcFormId,
      targetFormId,
      objectId: doc ? doc._id : descriptor.objectId,
      revision: doc ? doc.revision : 0,
      createdAt: now,
      lastTouchedAt: now,
      targetCapturedAt: now,
      descriptor,
    };
    sessions.set(pcFormId, session);
    return session;
  }

  function validateSession(pcFormId, payload) {
    const session = sessions.get(pcFormId);
    const sessionId = payload && payload.sessionId;
    const now = Date.now();
    if (!session || !sessionId || session.id !== sessionId) return { error: "Session expired. Inspect the object again." };
    if (now - session.createdAt > SESSION_ABSOLUTE_MS) return { error: "Session expired. Inspect the object again." };
    if (now - session.lastTouchedAt > SESSION_IDLE_MS) return { error: "Session idle timeout. Inspect the object again." };
    if (now - session.targetCapturedAt > SESSION_TARGET_TTL_MS) return { error: "Target expired. Inspect the object again." };
    const reach = validateTargetReach(pcFormId, session.targetFormId);
    if (!reach.ok) return { error: reach.reason };
    session.lastTouchedAt = now;
    return { session };
  }

  function roleFor(doc, who, admin) {
    if (admin) return "admin";
    if (!doc || !who) return "visitor";
    if (identity.isOwner(doc, who.profileId)) return "owner";
    if (identity.isUser(doc, who.profileId)) return "user";
    return "visitor";
  }

  async function resolveCharacter(profileId) {
    const id = identity.asPositiveInt(profileId);
    if (id === null) return null;
    try {
      const doc = await (await getBackendDb()).collection(CHARACTERS_COLLECTION).findOne(
        { profileId: id, deletedAt: null },
        { projection: { profileId: 1, name: 1, displayName: 1 } }
      );
      return identity.publicCharacter(doc) || { profileId: id, displayName: "Profile " + id };
    } catch (e) {
      return { profileId: id, displayName: "Profile " + id };
    }
  }

  async function buildManagePayload(pcFormId, session, doc, descriptor, toastMessage) {
    const permission = permissions.hasPermission(pcFormId, MANAGE_PERMISSION);
    const who = permission.identity;
    const admin = permission.allowed === true;
    const currentDoc = doc ? normalizeDoc(doc) : null;
    const canManage = identity.canManage(currentDoc, who, admin);
    const canOpen = currentDoc ? identity.canAccess(currentDoc, who, admin) : false;
    const canManageOwner = identity.canManageOwner(currentDoc, who, admin);
    const canToggleLock = identity.canToggleLock(currentDoc, who, admin);
    const canAddUser = identity.canAddUser(currentDoc, who, admin);
    const canRemoveUsers = identity.canRemoveUser(currentDoc, who, admin);
    return {
      action: "manage",
      focus: "grab",
      sessionId: session.id,
      object: {
        id: currentDoc ? currentDoc._id : descriptor.objectId,
        type: currentDoc ? currentDoc.objectType : descriptor.objectType,
        displayName: currentDoc ? currentDoc.displayName : descriptor.displayName,
        locked: currentDoc ? currentDoc.locked === true : true,
        revision: currentDoc ? currentDoc.revision : 0,
        refs: currentDoc ? currentDoc.refs : descriptor.refs,
        teleport: descriptor.teleport === true,
        linksBack: descriptor.linksBack === true,
        pairWarning: descriptor.pairWarning || null,
      },
      owner: currentDoc ? currentDoc.owner : null,
      users: currentDoc ? currentDoc.users : [],
      role: roleFor(currentDoc, who, admin),
      canOpen,
      canManage,
      canManageOwner,
      canToggleLock,
      canAddUser,
      canRemoveUsers,
      maxUsers: MAX_USERS,
      toastMessage: toastMessage || null,
    };
  }

  async function pushManage(pcFormId, session, doc, descriptor, toastMessage) {
    watchObject(pcFormId, doc ? doc._id : descriptor.objectId);
    pushUi(pcFormId, await buildManagePayload(pcFormId, session, doc, descriptor, toastMessage));
  }

  async function pushContext(pcFormId, targetFormId, doc, descriptor) {
    const session = createSession(pcFormId, targetFormId, doc, descriptor);
    const permission = permissions.hasPermission(pcFormId, MANAGE_PERMISSION);
    const who = permission.identity;
    const admin = permission.allowed === true;
    const canManage = identity.canManage(doc, who, admin);
    const canOpen = doc ? identity.canAccess(doc, who, admin) : false;
    const canRegister = !doc && admin;

    if (!canOpen && !canManage && !canRegister) {
      pushToast(pcFormId, doc && doc.locked === true ? "This is locked." : "No access controls are available for this object.");
      sessions.delete(pcFormId);
      return;
    }

    pushUi(pcFormId, {
      action: "context",
      focus: "grab",
      sessionId: session.id,
      object: {
        id: doc ? doc._id : descriptor.objectId,
        type: doc ? doc.objectType : descriptor.objectType,
        displayName: doc ? doc.displayName : descriptor.displayName,
        locked: doc ? doc.locked === true : true,
        revision: doc ? doc.revision : 0,
      },
      role: roleFor(doc, who, admin),
      options: {
        open: canOpen,
        manage: canManage && !!doc,
        register: canRegister,
      },
    });
  }

  function auditEvent(actor, action, details) {
    return {
      at: identity.nowIso(),
      action: String(action || "update"),
      actor: actor ? { profileId: actor.profileId, displayName: actor.displayName } : null,
      details: details || {},
    };
  }

  async function updateDocAtomic(doc, mongoUpdate, actor, action, details, extraFilter) {
    if (mutationDisabled) throw new Error("Database mutations are disabled");
    const collection = await getCollection();
    const filter = Object.assign({ _id: doc._id, revision: doc.revision }, extraFilter || {});
    const update = Object.assign({}, mongoUpdate);
    update.$set = Object.assign({}, update.$set || {}, { updatedAt: identity.nowIso() });
    update.$inc = Object.assign({}, update.$inc || {}, { revision: 1 });
    update.$push = Object.assign({}, update.$push || {}, {
      audit: { $each: [auditEvent(actor, action, details)], $slice: -100 },
    });
    const result = await collection.findOneAndUpdate(filter, update, { returnDocument: "after" });
    const updated = result && result.value ? result.value : result;
    if (!updated) throw new Error("Object was modified by another session");
    uncacheDoc(doc);
    const normalized = cacheDoc(updated);
    await refreshWatchers(normalized);
    return normalized;
  }

  async function registerObject(pcFormId, session) {
    if (mutationDisabled) throw new Error("Database mutations are disabled");
    const permission = permissions.hasPermission(pcFormId, MANAGE_PERMISSION);
    if (!permission.allowed) throw new Error("You are not authorized to register objects.");
    const descriptor = session.descriptor;
    const now = identity.nowIso();
    const doc = {
      _id: descriptor.objectId,
      schemaVersion: 2,
      objectType: descriptor.objectType,
      displayName: descriptor.displayName,
      refs: descriptor.refs,
      locked: true,
      owner: null,
      users: [],
      revision: 1,
      createdAt: now,
      updatedAt: now,
      createdBy: { profileId: permission.identity.profileId, displayName: permission.identity.displayName },
      audit: [auditEvent(permission.identity, "register", { refs: descriptor.refs.length })],
    };

    try {
      await (await getCollection()).insertOne(doc);
      const normalized = cacheDoc(doc);
      await refreshWatchers(normalized);
      return normalized;
    } catch (e) {
      if (e && e.code === 11000) {
        const existing = await (await getCollection()).findOne({ _id: descriptor.objectId });
        if (existing) return cacheDoc(existing);
      }
      markRuntimeDbOutage(e);
      throw e;
    }
  }

  async function refreshWatchers(doc) {
    if (!doc || !doc._id) return;
    const watchers = Array.from(watchersByObject.get(doc._id) || []);
    for (const pcFormId of watchers) {
      const session = sessions.get(pcFormId);
      if (!session) {
        clearWatch(pcFormId);
        continue;
      }
      session.revision = doc.revision;
      const permission = permissions.hasPermission(pcFormId, MANAGE_PERMISSION);
      if (!identity.canManage(doc, permission.identity, permission.allowed)) {
        closeSession(pcFormId, "permission_revoked");
        pushToast(pcFormId, "Your access view was closed.");
        continue;
      }
      try {
        pushUi(pcFormId, await buildManagePayload(pcFormId, session, doc, session.descriptor, null));
      } catch (e) {
        console.error(LOG, "watcher refresh failed:", e && e.message ? e.message : e);
      }
    }
  }

  async function searchCharacters(pcFormId, query) {
    const now = Date.now();
    const last = searchRate.get(pcFormId) || 0;
    if (now - last < SEARCH_RATE_MS) return { action: "searchResults", error: "Search rate limited.", results: [] };
    searchRate.set(pcFormId, now);

    const trimmed = String(query || "").trim().slice(0, 50);
    if (trimmed.length < 2) return { action: "searchResults", query: trimmed, results: [] };
    const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp("^" + escaped, "i");
    const numeric = /^\d+$/.test(trimmed) ? Number(trimmed) : null;
    const or = [{ name: regex }, { displayName: regex }];
    if (Number.isInteger(numeric)) or.push({ profileId: numeric });

    const docs = await (await getBackendDb()).collection(CHARACTERS_COLLECTION)
      .find({ deletedAt: null, profileId: { $gte: 0 }, $or: or })
      .project({ profileId: 1, name: 1, displayName: 1 })
      .sort({ name: 1, profileId: 1 })
      .limit(20)
      .toArray();

    return {
      action: "searchResults",
      query: trimmed,
      results: docs.map(identity.publicCharacter).filter(Boolean),
    };
  }

  async function openForActor(pcFormId, session, doc) {
    const permission = permissions.hasPermission(pcFormId, MANAGE_PERMISSION);
    if (!doc || !identity.canAccess(doc, permission.identity, permission.allowed)) {
      if (!doc || doc.locked !== true) pushToast(pcFormId, "You cannot open this.");
      return;
    }
    closeSession(pcFormId, "open");
    runDefaultActivate(session.targetFormId, pcFormId);
  }

  async function handleInspect(pcFormId, payload) {
    const targetFormId = Number(payload && payload.targetFormId);
    if (!Number.isInteger(targetFormId) || targetFormId <= 0) return;
    const classification = classifyObject(targetFormId);
    if (!classification) return;
    if (!databaseReady) {
      pushToast(pcFormId, "Access control database is unavailable.");
      return;
    }
    const reach = validateTargetReach(pcFormId, targetFormId);
    if (!reach.ok) {
      pushToast(pcFormId, reach.reason);
      return;
    }
    const descriptor = describeTarget(targetFormId, classification);
    if (descriptor.error) {
      pushToast(pcFormId, descriptor.error);
      return;
    }
    const doc = getDocByTarget(targetFormId);
    await pushContext(pcFormId, targetFormId, doc, descriptor);
  }

  async function handleHint(pcFormId, payload) {
    const targetFormId = Number(payload && payload.targetFormId);
    if (!Number.isInteger(targetFormId) || targetFormId <= 0) {
      pushHintClear(pcFormId);
      return;
    }
    const classification = classifyObject(targetFormId);
    if (!classification || !databaseReady) {
      pushHintClear(pcFormId);
      return;
    }
    const reach = validateTargetReach(pcFormId, targetFormId);
    if (!reach.ok) {
      pushHintClear(pcFormId);
      return;
    }
    pushAccessHint(pcFormId, getDocByTarget(targetFormId));
  }

  async function handleAccessEvent(pcFormId, payload) {
    if (!payload || typeof payload !== "object") return;
    if (payload.kind === "hint") {
      await handleHint(pcFormId, payload);
      return;
    }
    if (payload.kind === "hintClear") {
      pushHintClear(pcFormId);
      return;
    }
    if (payload.kind === "inspect") {
      await handleInspect(pcFormId, payload);
      return;
    }
    if (payload.kind === "close" || payload.kind === "cancel") {
      closeSession(pcFormId, "close");
      return;
    }
    if (payload.kind === "search") {
      pushUi(pcFormId, await searchCharacters(pcFormId, payload.query));
      return;
    }

    const validated = validateSession(pcFormId, payload);
    if (validated.error) {
      pushToast(pcFormId, validated.error);
      closeSession(pcFormId, "invalid_session");
      return;
    }

    const session = validated.session;
    let doc = getDocByTarget(session.targetFormId) || byObjectId.get(session.objectId) || null;
    const permission = permissions.hasPermission(pcFormId, MANAGE_PERMISSION);
    const actor = permission.identity;

    try {
      if (payload.kind === "choice") {
        const choice = payload.choice;
        if (choice === "open") {
          await openForActor(pcFormId, session, doc);
          return;
        }
        if (choice === "register") {
          doc = await registerObject(pcFormId, session);
          session.objectId = doc._id;
          session.revision = doc.revision;
          await pushManage(pcFormId, session, doc, session.descriptor, "Object registered.");
          return;
        }
        if (choice === "manage") {
          if (!doc) {
            pushToast(pcFormId, "Object is not registered.");
            return;
          }
          if (!identity.canManage(doc, actor, permission.allowed)) {
            pushToast(pcFormId, "You cannot manage this object.");
            return;
          }
          await pushManage(pcFormId, session, doc, session.descriptor);
          return;
        }
      }

      if (!doc) {
        pushToast(pcFormId, "Object is not registered.");
        return;
      }
      if (!identity.canManage(doc, actor, permission.allowed)) {
        pushToast(pcFormId, "You cannot manage this object.");
        return;
      }

      if (payload.kind === "setLocked") {
        if (!identity.canToggleLock(doc, actor, permission.allowed)) {
          pushToast(pcFormId, "You cannot lock or unlock this object.");
          return;
        }
        doc = await updateDocAtomic(
          doc,
          { $set: { locked: payload.locked === true } },
          actor,
          payload.locked === true ? "lock" : "unlock",
          {}
        );
        sessions.set(pcFormId, Object.assign(session, { revision: doc.revision }));
        await pushManage(pcFormId, session, doc, session.descriptor);
        return;
      }

      if (payload.kind === "assignOwner") {
        if (!identity.canManageOwner(doc, actor, permission.allowed)) {
          pushToast(pcFormId, "Only access admins can assign owners.");
          return;
        }
        const owner = await resolveCharacter(payload.profileId);
        if (!owner) {
          pushToast(pcFormId, "Character not found.");
          return;
        }
        if (doc.owner && identity.sameProfile(doc.owner.profileId, owner.profileId)) {
          pushToast(pcFormId, "That character is already the owner.");
          return;
        }
        doc = await updateDocAtomic(
          doc,
          { $set: { owner }, $pull: { users: { profileId: owner.profileId } } },
          actor,
          "assign_owner",
          { ownerProfileId: owner.profileId }
        );
        sessions.set(pcFormId, Object.assign(session, { revision: doc.revision }));
        await pushManage(pcFormId, session, doc, session.descriptor, owner.displayName + " assigned as owner.");
        return;
      }

      if (payload.kind === "removeOwner") {
        if (!identity.canManageOwner(doc, actor, permission.allowed)) {
          pushToast(pcFormId, "Only access admins can remove owners.");
          return;
        }
        doc = await updateDocAtomic(doc, { $set: { owner: null } }, actor, "remove_owner", {});
        sessions.set(pcFormId, Object.assign(session, { revision: doc.revision }));
        await pushManage(pcFormId, session, doc, session.descriptor, "Owner removed.");
        return;
      }

      if (payload.kind === "addUser") {
        if (!identity.canAddUser(doc, actor, permission.allowed)) {
          pushToast(pcFormId, "Only access admins can add users.");
          return;
        }
        const user = await resolveCharacter(payload.profileId);
        if (!user) {
          pushToast(pcFormId, "Character not found.");
          return;
        }
        if (doc.owner && identity.sameProfile(doc.owner.profileId, user.profileId)) {
          pushToast(pcFormId, "That character is already the owner.");
          return;
        }
        if (doc.users.length >= MAX_USERS) {
          pushToast(pcFormId, "User limit reached.");
          return;
        }
        doc = await updateDocAtomic(
          doc,
          { $push: { users: user } },
          actor,
          "add_user",
          { userProfileId: user.profileId },
          { "users.profileId": { $ne: user.profileId } }
        );
        sessions.set(pcFormId, Object.assign(session, { revision: doc.revision }));
        await pushManage(pcFormId, session, doc, session.descriptor, user.displayName + " added.");
        return;
      }

      if (payload.kind === "removeUser") {
        if (!identity.canRemoveUser(doc, actor, permission.allowed)) {
          pushToast(pcFormId, "You cannot remove users from this object.");
          return;
        }
        const profileId = identity.asPositiveInt(payload.profileId);
        if (profileId === null) return;
        doc = await updateDocAtomic(
          doc,
          { $pull: { users: { profileId } } },
          actor,
          "remove_user",
          { userProfileId: profileId }
        );
        sessions.set(pcFormId, Object.assign(session, { revision: doc.revision }));
        await pushManage(pcFormId, session, doc, session.descriptor, "User removed.");
      }
    } catch (e) {
      if (/Database mutations are disabled/.test(String(e && e.message))) {
        pushToast(pcFormId, "Database writes are disabled. Access checks still use the last known cache.");
        return;
      }
      if (/modified by another session/.test(String(e && e.message))) {
        const fresh = getDocByTarget(session.targetFormId) || byObjectId.get(session.objectId);
        if (fresh) await pushManage(pcFormId, session, fresh, session.descriptor, "Object changed. Review the latest state.");
        else pushToast(pcFormId, "Object changed. Inspect it again.");
        return;
      }
      if (e && (/Mongo|ECONN|topology|network|server selection/i.test(String(e.message)))) markRuntimeDbOutage(e);
      console.error(LOG, "event handler failed:", e && e.stack ? e.stack : e);
      pushToast(pcFormId, e && e.message ? e.message : "Access action failed.");
    }
  }

  const previousOnActivate = typeof mp.onActivate === "function" ? mp.onActivate : null;
  mp.onActivate = (targetFormId, actorFormId) => {
    const key = activateKey(targetFormId, actorFormId);
    if (defaultActivatePass.has(key)) {
      defaultActivatePass.delete(key);
      return previousOnActivate ? previousOnActivate(targetFormId, actorFormId) : true;
    }

    const classification = classifyObject(targetFormId);
    if (!classification) return previousOnActivate ? previousOnActivate(targetFormId, actorFormId) : true;

    if (!databaseReady) {
      pushToast(actorFormId, "Access control database is unavailable.");
      return false;
    }

    const doc = getDocByTarget(targetFormId);
    if (!doc) return previousOnActivate ? previousOnActivate(targetFormId, actorFormId) : true;
    if (doc.locked !== true) return previousOnActivate ? previousOnActivate(targetFormId, actorFormId) : true;

    const reach = validateTargetReach(actorFormId, targetFormId);
    if (!reach.ok) {
      pushToast(actorFormId, reach.reason);
      return false;
    }

    const permission = permissions.hasPermission(actorFormId, MANAGE_PERMISSION);
    if (!identity.canAccess(doc, permission.identity, permission.allowed)) {
      return false;
    }

    runDefaultActivate(targetFormId, actorFormId);
    return false;
  };

  mp.makeProperty("vgrAccessControlUi", {
    isVisibleByOwner: true,
    isVisibleByNeighbors: false,
    updateOwner: `
      const value = ctx.value;
      if (!ctx.state.vgrAccessUi) ctx.state.vgrAccessUi = { lastNonce: null };
      if (!value || value.version !== ${UI_VERSION}) return;
      if (value.action !== "close" && (!value.expiresAt || Date.now() > value.expiresAt)) {
        ctx.sp.browser.executeJavaScript('window.skyrimPlatform?.sendMessage?.("vgr:ui:close", "access_control")');
        return;
      }
      if (ctx.state.vgrAccessUi.lastNonce === value.nonce) return;
      ctx.state.vgrAccessUi.lastNonce = value.nonce;
      ctx.sp.browser.executeJavaScript("window.vgrAccessUpdate && window.vgrAccessUpdate(" + JSON.stringify(value) + ");");
      if (value.focus === "grab") {
        ctx.sp.browser.executeJavaScript('window.skyrimPlatform?.sendMessage?.("vgr:ui:open", "access_control")');
      }
      if (value.focus === "release") {
        ctx.sp.browser.executeJavaScript('window.skyrimPlatform?.sendMessage?.("vgr:ui:close", "access_control")');
      }
    `,
    updateNeighbor: "",
  });

  mp.makeEventSource("_vgrAccessControl", `
    ctx.sp.printConsole("[VGR access] event source loaded");
    if (!ctx.state.vgrAccessControl) {
      ctx.state.vgrAccessControl = { xDown: false, hintTargetFormId: 0, hintPollAt: 0, hintSentAt: 0, hintVisible: false };
    }

    const isBlockedByUi = () => {
      if (ctx.state.vgrUi && typeof ctx.state.vgrUi.isNativeMenuOpen === "function" && ctx.state.vgrUi.isNativeMenuOpen()) return true;
      if (ctx.state.vgrUi && ctx.state.vgrUi.activeUI) return true;
      try { if (ctx.sp.Ui.isTextInputEnabled()) return true; } catch (_) {}
      return false;
    };

    const isBlockedByOtherUi = () => {
      if (ctx.state.vgrUi && typeof ctx.state.vgrUi.isNativeMenuOpen === "function" && ctx.state.vgrUi.isNativeMenuOpen()) return true;
      if (ctx.state.vgrUi && ctx.state.vgrUi.activeUI && ctx.state.vgrUi.activeUI !== "access_control") return true;
      try { if (ctx.sp.Ui.isTextInputEnabled()) return true; } catch (_) {}
      return false;
    };

    const supportedTarget = (target) => {
      if (!target || typeof target.getBaseObject !== "function") return null;
      let base = null;
      try { base = target.getBaseObject(); } catch (_) { return null; }
      if (!base || typeof base.getType !== "function") return null;
      const type = base.getType();
      if (type !== ctx.sp.FormType.Door && type !== ctx.sp.FormType.Container) return null;
      return target;
    };

    const clearHint = () => {
      if (!ctx.state.vgrAccessControl.hintVisible && !ctx.state.vgrAccessControl.hintTargetFormId) return;
      ctx.state.vgrAccessControl.hintVisible = false;
      ctx.state.vgrAccessControl.hintTargetFormId = 0;
      ctx.state.vgrAccessControl.hintSentAt = 0;
      ctx.sendEvent({ kind: "hintClear" });
    };

    ctx.sp.on("update", () => {
      const now = Date.now();
      if (now - (ctx.state.vgrAccessControl.hintPollAt || 0) < 250) return;
      ctx.state.vgrAccessControl.hintPollAt = now;

      if (isBlockedByUi()) {
        clearHint();
        return;
      }

      const target = supportedTarget(ctx.sp.Game.getCurrentCrosshairRef());
      if (!target) {
        clearHint();
        return;
      }

      const targetFormId = ctx.getFormIdInServerFormat(target.getFormID());
      if (!targetFormId) {
        clearHint();
        return;
      }

      if (
        targetFormId !== ctx.state.vgrAccessControl.hintTargetFormId ||
        now - (ctx.state.vgrAccessControl.hintSentAt || 0) > 1000
      ) {
        ctx.state.vgrAccessControl.hintTargetFormId = targetFormId;
        ctx.state.vgrAccessControl.hintSentAt = now;
        ctx.state.vgrAccessControl.hintVisible = true;
        ctx.sendEvent({ kind: "hint", targetFormId });
      }
    });

    ctx.sp.on("browserMessage", (e) => {
      const msg = e.arguments && e.arguments[0];
      const payload = e.arguments && e.arguments[1];
      if (msg === "vgr:access:close" || (msg === "vgr:ui:close" && payload === "access_control")) {
        ctx.sendEvent({ kind: "close" });
      } else if (msg === "vgr:access:choice") {
        ctx.sendEvent(Object.assign({ kind: "choice" }, payload || {}));
      } else if (msg === "vgr:access:search") {
        ctx.sendEvent({ kind: "search", query: payload && payload.query });
      } else if (msg === "vgr:access:addUser") {
        ctx.sendEvent(Object.assign({ kind: "addUser" }, payload || {}));
      } else if (msg === "vgr:access:removeUser") {
        ctx.sendEvent(Object.assign({ kind: "removeUser" }, payload || {}));
      } else if (msg === "vgr:access:assignOwner") {
        ctx.sendEvent(Object.assign({ kind: "assignOwner" }, payload || {}));
      } else if (msg === "vgr:access:removeOwner") {
        ctx.sendEvent(Object.assign({ kind: "removeOwner" }, payload || {}));
      } else if (msg === "vgr:access:setLocked") {
        ctx.sendEvent(Object.assign({ kind: "setLocked" }, payload || {}));
      }
    });
  `);

  mp._vgrAccessControl = (pcFormId, payload) => {
    handleAccessEvent(pcFormId, payload).catch((e) => {
      console.error(LOG, "unhandled access event:", e && e.stack ? e.stack : e);
      pushToast(pcFormId, "Access control failed.");
    });
  };

  mp.on("disconnect", (userId) => {
    try {
      const actorFormId = mp.getUserActor(userId);
      if (actorFormId) {
        sessions.delete(actorFormId);
        clearWatch(actorFormId);
        openUiActors.delete(actorFormId);
        searchRate.delete(actorFormId);
        permissions.invalidate(actorFormId);
      }
    } catch (e) {
      // Actor may already be gone.
    }
  });

  loadCache();

  try {
    require("./vgr_access_door_probe")(mp, config, {
      classifyObject,
      describeTarget,
      getObjectMeta,
      hasManagePermission: (pcFormId) => permissions.hasPermission(pcFormId, MANAGE_PERMISSION).allowed === true,
    });
  } catch (e) {
    console.error(LOG, "door probe module failed:", e && e.message ? e.message : e);
  }

  mp._vgrAccessControlApi = {
    classifyObject,
    describeTarget,
    getDocByTarget,
    loadCache,
    permissions,
    state: () => ({
      startupLoaded,
      databaseReady,
      mutationDisabled,
      objects: byObjectId.size,
      sessions: sessions.size,
    }),
  };

  console.log(LOG, "extension loaded; onActivate handler installed");
};
