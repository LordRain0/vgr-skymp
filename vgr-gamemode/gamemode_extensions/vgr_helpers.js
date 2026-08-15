"use strict";

// Shared helper library for VGR gamemode extensions.
// Keep this file dependency-light so feature extensions can reuse logic safely.

// Safely returns item entries from any inventory-like object.
function inventoryEntries(inv) {
  return Array.isArray(inv && inv.entries) ? inv.entries : [];
}

// ---------------------------------------------------------------------------
// Access Control: identity and permission document helpers
// ---------------------------------------------------------------------------
const accessIdentity = (() => {
  // Returns the current wall-clock time in the storage timestamp format.
  function nowIso() {
    return new Date().toISOString();
  }

  // Normalizes a value into a non-negative integer id, or null if invalid.
  function asPositiveInt(value) {
    const number = Number(value);
    return Number.isInteger(number) && number >= 0 ? number : null;
  }

  // Trims display names and falls back to a stable non-empty label.
  function normalizeName(value, fallback) {
    const text = String(value || "").trim();
    return text || fallback || "Unknown";
  }

  // Checks whether an actor still exists by probing a required actor property.
  function actorExists(mp, pcFormId) {
    if (pcFormId == null || pcFormId === 0) return false;
    try {
      mp.get(pcFormId, "profileId");
      return true;
    } catch (e) {
      return false;
    }
  }

  // Reads the best available player-facing character name from actor state.
  function getDisplayName(mp, pcFormId, fallback) {
    try {
      const value = mp.get(pcFormId, "appearance");
      if (value && value.name) return normalizeName(value.name, fallback);
    } catch (e) {
      // Appearance may not be available on incomplete actor state.
    }
    return normalizeName(fallback, "Adventurer");
  }

  // Builds the full server-side identity used by access checks.
  function getIdentity(mp, pcFormId) {
    if (!actorExists(mp, pcFormId)) return null;

    let profileId = null;
    try {
      profileId = asPositiveInt(mp.get(pcFormId, "profileId"));
    } catch (e) {
      profileId = null;
    }

    if (profileId === null) return null;

    let discordId = null;
    try {
      const value = mp.get(pcFormId, "private.indexed.discordId");
      discordId = value == null ? null : String(value);
    } catch (e) {
      discordId = null;
    }

    let discordRoles = [];
    try {
      const value = mp.get(pcFormId, "private.discordRoles");
      discordRoles = Array.isArray(value) ? value.map(String) : [];
    } catch (e) {
      discordRoles = [];
    }

    return {
      profileId,
      discordId,
      discordRoles,
      displayName: getDisplayName(mp, pcFormId, "Profile " + profileId),
    };
  }

  // Reduces a character-like object to fields safe for persistence/UI payloads.
  function publicCharacter(character) {
    if (!character) return null;
    const profileId = asPositiveInt(character.profileId);
    if (profileId === null) return null;
    return {
      profileId,
      displayName: normalizeName(character.displayName || character.name, "Profile " + profileId),
    };
  }

  // Compares two profile id values after normalization.
  function sameProfile(a, b) {
    const left = asPositiveInt(a);
    const right = asPositiveInt(b);
    return left !== null && right !== null && left === right;
  }

  // Checks whether a profile owns an access-controlled document.
  function isOwner(doc, profileId) {
    return !!doc && !!doc.owner && sameProfile(doc.owner.profileId, profileId);
  }

  // Checks whether a profile appears in a document's user list.
  function isUser(doc, profileId) {
    return !!doc && Array.isArray(doc.users) && doc.users.some((entry) => sameProfile(entry && entry.profileId, profileId));
  }

  // Returns true when an object can be activated without a lock override.
  function canAccess(doc, identity, hasAdminPermission) {
    if (!doc) return false;
    if (doc.locked !== true) return true;
    return false;
  }

  // Checks whether an identity can manage document permissions/settings.
  function canManage(doc, identity, hasAdminPermission) {
    if (hasAdminPermission) return true;
    if (!doc || !identity) return false;
    return isOwner(doc, identity.profileId);
  }

  // Checks whether an identity can change ownership.
  function canManageOwner(doc, identity, hasAdminPermission) {
    return hasAdminPermission === true;
  }

  // Checks whether an identity can add users to a document.
  function canAddUser(doc, identity, hasAdminPermission) {
    return hasAdminPermission === true && !!doc;
  }

  // Checks whether an identity can remove users from a document.
  function canRemoveUser(doc, identity, hasAdminPermission) {
    return canManage(doc, identity, hasAdminPermission);
  }

  // Checks whether an identity can toggle the locked state.
  function canToggleLock(doc, identity, hasAdminPermission) {
    return !!doc && canManage(doc, identity, hasAdminPermission);
  }

  return {
    asPositiveInt,
    canAccess,
    canAddUser,
    canManage,
    canManageOwner,
    canRemoveUser,
    canToggleLock,
    getDisplayName,
    getIdentity,
    isOwner,
    isUser,
    normalizeName,
    nowIso,
    publicCharacter,
    sameProfile,
  };
})();

// ---------------------------------------------------------------------------
// Access Control: backend admin permission cache
// ---------------------------------------------------------------------------
// Creates the permission-checking API used by access-control extensions.
function createAccessPermissions(mp, settings) {
  const LOG = "[VGR access permissions]";
  if (mp.vgrAccessPermissions && mp.vgrAccessPermissions.__vgrBackendAdminPermissions === true) {
    return mp.vgrAccessPermissions;
  }
  const accessSettings = settings.vgrAccessControl || {};
  const configured = accessSettings.permissions || {};
  const permissionCache = new Map();
  const CACHE_MS = Math.max(1000, Number(accessSettings.permissionCacheMs) || 10000);
  const BACKEND_DB_NAME = accessSettings.backendDatabaseName || "skymp-backend";
  const PLAYERS_COLLECTION = accessSettings.playersCollection || "players";
  const CHARACTERS_COLLECTION = accessSettings.charactersCollection || "characters";
  const ADMIN_REFRESH_MS = Math.max(5000, Number(accessSettings.adminRefreshMs) || 60000);
  const ADMIN_LOG_INTERVAL_MS = Math.max(300000, Number(accessSettings.adminLogIntervalMs) || 300000);
  const ALLOW_CONFIG_FALLBACK = accessSettings.allowConfiguredManagePermissionFallback === true;
  const identity = accessIdentity;
  let MongoClient = null;
  try {
    MongoClient = require("mongodb").MongoClient;
  } catch (e) {
    console.error(LOG, "MongoDB driver missing; backend admin permissions will fail closed.");
  }
  let backendClientPromise = null;
  let adminCacheReady = false;
  let adminProfileIds = new Set();
  let lastAdminCacheLogAt = 0;

  function deriveMongoUri(dbName) {
    if (accessSettings.backendDatabaseUri) return accessSettings.backendDatabaseUri;
    if (!settings.databaseUri) return "";
    try {
      const uri = new URL(settings.databaseUri);
      uri.pathname = "/" + dbName;
      return uri.toString();
    } catch (e) {
      console.error(LOG, "invalid databaseUri for backend admin permissions:", e && e.message ? e.message : e);
      return "";
    }
  }

  const BACKEND_URI = deriveMongoUri(BACKEND_DB_NAME);

  async function refreshBackendAdmins() {
    try {
      if (!MongoClient || !BACKEND_URI) throw new Error("No MongoDB connection is configured");
      if (!backendClientPromise) backendClientPromise = MongoClient.connect(BACKEND_URI, { maxPoolSize: 2 });
      const db = (await backendClientPromise).db(BACKEND_DB_NAME);
      const adminPlayers = await db.collection(PLAYERS_COLLECTION)
        .find({ admin: true }, { projection: { discordId: 1 } })
        .toArray();
      const adminDiscordIds = adminPlayers.map((player) => String(player && player.discordId || "")).filter(Boolean);
      if (!adminDiscordIds.length) {
        adminProfileIds = new Set();
        adminCacheReady = true;
        permissionCache.clear();
        return;
      }
      const characters = await db.collection(CHARACTERS_COLLECTION)
        .find({ discordId: { $in: adminDiscordIds }, deletedAt: null }, { projection: { profileId: 1 } })
        .toArray();
      adminProfileIds = toNumberSet(characters.map((character) => character && character.profileId));
      adminCacheReady = true;
      permissionCache.clear();
      /*const now = Date.now();
      if (now - lastAdminCacheLogAt >= ADMIN_LOG_INTERVAL_MS) {
        lastAdminCacheLogAt = now;
        console.log(LOG, "backend admin cache refreshed:", adminProfileIds.size, "profile(s)");
      }*/
    } catch (e) {
      adminProfileIds = new Set();
      adminCacheReady = false;
      backendClientPromise = null;
      permissionCache.clear();
      console.error(LOG, "backend admin cache unavailable; access management is locked:", e && e.message ? e.message : e);
    }
  }

  // Converts string-like config entries into a lookup set.
  function toStringSet(values) {
    if (!Array.isArray(values)) return new Set();
    return new Set(values.map((value) => String(value)).filter(Boolean));
  }

  // Converts numeric id config entries into a lookup set.
  function toNumberSet(values) {
    if (!Array.isArray(values)) return new Set();
    const out = new Set();
    for (const value of values) {
      const number = identity.asPositiveInt(value);
      if (number !== null) out.add(number);
    }
    return out;
  }

  // Reads a permission by name, including legacy access-control admin keys.
  function readPermissionConfig(name) {
    const direct = configured[name] || {};
    const legacy = name === "vgr.access.manage"
      ? {
          profileIds: accessSettings.adminProfileIds || accessSettings.keyHandlerProfileIds,
          discordIds: accessSettings.adminDiscordIds || accessSettings.keyHandlerDiscordIds,
          discordRoleIds: accessSettings.adminDiscordRoleIds || accessSettings.keyHandlerDiscordRoleIds,
        }
      : {};

    return {
      profileIds: toNumberSet(direct.profileIds || legacy.profileIds),
      discordIds: toStringSet(direct.discordIds || legacy.discordIds),
      discordRoleIds: toStringSet(direct.discordRoleIds || direct.roles || legacy.discordRoleIds),
    };
  }

  // Evaluates a permission against the current actor identity.
  function evaluate(pcFormId, name) {
    const who = identity.getIdentity(mp, pcFormId);
    if (!who) return { allowed: false, identity: null };

    if (name === "vgr.access.manage" && adminProfileIds.has(who.profileId)) {
      return { allowed: true, identity: who };
    }
    if (name === "vgr.access.manage" && !ALLOW_CONFIG_FALLBACK) {
      return { allowed: false, identity: who };
    }

    const config = readPermissionConfig(name);
    const allowed =
      config.profileIds.has(who.profileId) ||
      (who.discordId && config.discordIds.has(who.discordId)) ||
      who.discordRoles.some((role) => config.discordRoleIds.has(String(role)));

    return { allowed, identity: who };
  }

  // Returns cached permission state for an actor and permission name.
  function hasPermission(pcFormId, name) {
    const key = String(pcFormId) + ":" + String(name);
    const cached = permissionCache.get(key);
    const now = Date.now();
    if (cached && now - cached.time < CACHE_MS) return cached.value;

    const value = evaluate(pcFormId, name);
    permissionCache.set(key, { time: now, value });
    return value;
  }

  // Clears one actor's cached permissions, or all cached permissions.
  function invalidate(pcFormId) {
    if (pcFormId == null) {
      permissionCache.clear();
      return;
    }
    const prefix = String(pcFormId) + ":";
    for (const key of Array.from(permissionCache.keys())) {
      if (key.startsWith(prefix)) permissionCache.delete(key);
    }
  }

  if (!MongoClient || !BACKEND_URI) {
    console.warn(LOG, "backend admin permission source is not configured; access management will fail closed");
  } else {
    refreshBackendAdmins();
    setInterval(refreshBackendAdmins, ADMIN_REFRESH_MS);
  }

  const api = {
    __vgrBackendAdminPermissions: true,
    hasPermission,
    invalidate,
    state() {
      return {
        adminCacheReady,
        adminProfiles: adminProfileIds.size,
        backendDatabaseName: BACKEND_DB_NAME,
        playersCollection: PLAYERS_COLLECTION,
        charactersCollection: CHARACTERS_COLLECTION,
      };
    },
  };
  mp.vgrAccessPermissions = api;
  return api;
}

// ---------------------------------------------------------------------------
// Access Control: door teleport pair resolution
// ---------------------------------------------------------------------------
// Creates helpers for identifying whether doors belong to the same passage.
function createAccessDoorPair(mp) {
  // Formats numeric form ids as 8-character uppercase hex.
  const hex = (value) => (Number(value) >>> 0).toString(16).toUpperCase().padStart(8, "0");

  // Converts a numeric form id into a formDesc, using fileHint as fallback.
  function formDescFromNumericId(id, fileHint) {
    try {
      const desc = mp.getDescFromId(id);
      if (desc) return String(desc);
    } catch (e) {
      // Fall back below.
    }
    if (fileHint) return hex(id).replace(/^0+/, "").toLowerCase() + ":" + fileHint;
    return null;
  }

  // Normalizes Buffer, array, or numeric-key object data into byte arrays.
  function toByteArray(data) {
    if (data == null) return null;
    if (Array.isArray(data)) return data.map((b) => Number(b) & 0xff);
    if (typeof Buffer !== "undefined" && Buffer.isBuffer(data)) return Array.from(data);
    if (typeof data === "object") {
      const keys = Object.keys(data).filter((key) => /^\d+$/.test(key)).sort((a, b) => Number(a) - Number(b));
      if (keys.length) return keys.map((key) => Number(data[key]) & 0xff);
    }
    return null;
  }

  // Reads an unsigned 32-bit little-endian integer from bytes.
  function readUint32LE(bytes, offset) {
    return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
  }

  // Reads a little-endian float from bytes in Node or browser-like runtimes.
  function readFloatLE(bytes, offset) {
    if (typeof Buffer !== "undefined") return Buffer.from(bytes.slice(offset, offset + 4)).readFloatLE(0);
    const view = new DataView(Uint8Array.from(bytes.slice(offset, offset + 4)).buffer);
    return view.getFloat32(0, true);
  }

  // Parses raw XTEL teleport destination bytes from a door record field.
  function parseXtelBytes(bytes, fileHint) {
    if (!bytes || bytes.length < 32) return { error: "XTEL data too short", byteLength: bytes ? bytes.length : 0 };
    const destFormId = readUint32LE(bytes, 0);
    return {
      destFormId,
      destFormIdHex: hex(destFormId),
      destFormDesc: formDescFromNumericId(destFormId, fileHint),
      position: [readFloatLE(bytes, 4), readFloatLE(bytes, 8), readFloatLE(bytes, 12)],
      rotation: [readFloatLE(bytes, 16), readFloatLE(bytes, 20), readFloatLE(bytes, 24)],
      flags: readUint32LE(bytes, 28),
    };
  }

  // Gets a stable field type label from ESPM field metadata.
  function fieldTypeName(field, index) {
    if (!field || typeof field !== "object") return "field" + index;
    return String(field.type || field.magic || field.name || field.recordType || "field" + index);
  }

  // Finds and parses the XTEL teleport field from an ESPM record.
  function extractXtelFromRecord(record, fileHint) {
    if (!record || !Array.isArray(record.fields)) return null;

    for (let i = 0; i < record.fields.length; i++) {
      const field = record.fields[i];
      const type = fieldTypeName(field, i).toUpperCase();
      const bytes = toByteArray(field.data);
      if (type === "XTEL" && bytes) {
        const parsed = parseXtelBytes(bytes, fileHint);
        if (!parsed.error) return parsed;
      }
    }

    for (let i = 0; i < record.fields.length; i++) {
      const bytes = toByteArray(record.fields[i] && record.fields[i].data);
      if (!bytes || bytes.length < 32) continue;
      const candidate = parseXtelBytes(bytes, fileHint);
      if (candidate.error) continue;
      const dest = candidate.destFormId || 0;
      const valid =
        dest > 0x100 &&
        dest < 0xf00000 &&
        candidate.position.every((n) => Number.isFinite(n) && Math.abs(n) < 100000) &&
        candidate.rotation.every((n) => Number.isFinite(n) && Math.abs(n) <= Math.PI * 2 + 0.01);
      if (valid) return candidate;
    }

    return null;
  }

  // Looks up a door by formDesc and returns its parsed teleport target.
  function lookupXtelForFormDesc(formDesc) {
    const desc = String(formDesc || "");
    const fileHint = desc.split(":")[1] || "Skyrim.esm";
    try {
      const lookup = mp.lookupEspmRecordById(mp.getIdFromDesc(desc));
      if (!lookup || !lookup.record) return { error: "ESPM record not found" };
      const xtel = extractXtelFromRecord(lookup.record, fileHint);
      if (!xtel || xtel.error) return { error: "No XTEL teleport link on this door" };
      if (!xtel.destFormDesc) return { error: "Could not resolve paired door formDesc" };
      return { xtel, fileHint };
    } catch (e) {
      return { error: String(e && e.message ? e.message : e) };
    }
  }

  // Builds a canonical object id for a two-sided door pair.
  function canonicalPairId(formDescA, formDescB) {
    const a = String(formDescA || "");
    const b = String(formDescB || "");
    return a < b ? "door:" + a + "|" + b : "door:" + b + "|" + a;
  }

  // Resolves a formDesc into a numeric id, falling back to hex parsing.
  function numericIdFromFormDesc(formDesc) {
    const desc = String(formDesc || "");
    try {
      return mp.getIdFromDesc(desc);
    } catch (e) {
      return parseInt(desc.split(":")[0], 16) || 0;
    }
  }

  // Builds one stored reference entry for a door/container object.
  function buildRefEntry(formDesc, getObjectMeta, runtimeFormId) {
    const desc = String(formDesc || "");
    let numericId = numericIdFromFormDesc(desc);
    if (runtimeFormId != null && runtimeFormId !== 0) {
      try {
        if (String(mp.getDescFromId(runtimeFormId) || "").toLowerCase() === desc.toLowerCase()) numericId = runtimeFormId;
      } catch (e) {
        // Keep numericId from descriptor.
      }
    }

    let worldOrCellDesc = "";
    let position = [0, 0, 0];
    try {
      const meta = getObjectMeta(numericId) || {};
      worldOrCellDesc = meta.worldOrCellDesc || "";
      position = Array.isArray(meta.position) ? meta.position : [0, 0, 0];
    } catch (e) {
      // Runtime metadata is best effort for the inactive side of teleport pairs.
    }

    return { formDesc: desc, formIdHex: hex(numericId), worldOrCellDesc, position };
  }

  // Resolves a runtime door into its canonical passage and reverse-link status.
  function resolveDoorPassage(targetFormId, getObjectMeta) {
    let sourceFormDesc = "";
    try {
      sourceFormDesc = String(mp.getDescFromId(targetFormId) || "");
    } catch (e) {
      return { error: "Could not resolve door formDesc" };
    }
    if (!sourceFormDesc) return { error: "Could not resolve door formDesc" };

    const link = lookupXtelForFormDesc(sourceFormDesc);
    if (link.error) {
      return {
        objectId: "door:" + sourceFormDesc,
        refs: [buildRefEntry(sourceFormDesc, getObjectMeta, targetFormId)],
        teleport: false,
        linksBack: false,
        activatedFormDesc: sourceFormDesc,
        error: link.error,
      };
    }

    const destFormDesc = link.xtel.destFormDesc;
    const reverse = lookupXtelForFormDesc(destFormDesc);
    const linksBack = !reverse.error &&
      reverse.xtel &&
      String(reverse.xtel.destFormDesc || "").toLowerCase() === sourceFormDesc.toLowerCase();

    return {
      objectId: canonicalPairId(sourceFormDesc, destFormDesc),
      refs: [
        buildRefEntry(sourceFormDesc, getObjectMeta, targetFormId),
        buildRefEntry(destFormDesc, getObjectMeta),
      ],
      teleport: true,
      linksBack,
      activatedFormDesc: sourceFormDesc,
      pairedFormDesc: destFormDesc,
    };
  }

  return {
    buildRefEntry,
    canonicalPairId,
    extractXtelFromRecord,
    hex,
    lookupXtelForFormDesc,
    resolveDoorPassage,
  };
}

// ---------------------------------------------------------------------------
// Access Control: diagnostic door pair probes
// ---------------------------------------------------------------------------
// Creates optional diagnostics for inspecting door-pair resolution.
function createAccessDoorProbe(mp, config, runtime) {
  const LOG = "[VGR access probe]";
  const enabled = config && config.doorPairProbe && config.doorPairProbe.enabled === true;
  const allowStartup = enabled && Array.isArray(config.doorPairProbe.formDescs);
  const doorPair = createAccessDoorPair(mp);

  // Produces a probe report for a configured formDesc.
  function probeByFormDesc(formDesc) {
    const desc = String(formDesc || "");
    const report = {
      mode: "formDesc",
      formDesc: desc,
      timestamp: new Date().toISOString(),
      result: null,
    };
    if (!enabled) {
      report.result = { error: "Probe disabled" };
      return report;
    }
    let targetFormId = 0;
    try {
      targetFormId = mp.getIdFromDesc(desc);
    } catch (e) {
      report.result = { error: "Could not resolve formDesc" };
      return report;
    }
    const passage = doorPair.resolveDoorPassage(targetFormId, runtime.getObjectMeta);
    report.result = passage.error ? { error: passage.error } : passage;
    return report;
  }

  // Produces a probe report for a runtime form id.
  function probeByRuntimeFormId(targetFormId) {
    let formDesc = "";
    try {
      formDesc = mp.getDescFromId(targetFormId);
    } catch (e) {
      formDesc = "";
    }
    const report = probeByFormDesc(formDesc);
    report.mode = "runtime";
    report.targetFormId = targetFormId;
    return report;
  }

  // Logs a probe report as formatted JSON for server diagnostics.
  function logReport(report) {
    console.log(LOG, JSON.stringify(report, null, 2));
  }

  const api = { probeByFormDesc, probeByRuntimeFormId, logReport };
  mp._vgrAccessDoorProbe = api;

  if (allowStartup) {
    setTimeout(() => {
      for (const formDesc of config.doorPairProbe.formDescs) logReport(probeByFormDesc(formDesc));
    }, Math.max(1000, Number(config.doorPairProbe.startupDelayMs) || 2500));
  }

  return api;
}

// ---------------------------------------------------------------------------
// Activation: shared Papyrus activation argument helpers
// ---------------------------------------------------------------------------
const activation = (() => {
  // Builds the per-target/per-actor key used to suppress re-entrant activation.
  function activateKey(targetFormId, actorFormId) {
    return String(targetFormId) + ":" + String(actorFormId);
  }

  // Converts a numeric form id into the Papyrus form argument shape.
  function asForm(mp, formId) {
    return { type: "form", desc: mp.getDescFromId(formId) };
  }

  return {
    activateKey,
    asForm,
  };
})();

// ---------------------------------------------------------------------------
// Client snippets: small script fragments shared by owner-side event sources
// ---------------------------------------------------------------------------
const client = (() => {
  const NATIVE_MENUS_TO_BLOCK = [
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
    "TweenMenu",
  ];

  // Returns shared client-side helpers for avoiding prompts/overlays during menus.
  function blockingUiHelpers() {
    return `
    const nativeMenusToBlock = ${JSON.stringify(NATIVE_MENUS_TO_BLOCK, null, 6)};

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
`;
  }

  return {
    NATIVE_MENUS_TO_BLOCK,
    blockingUiHelpers,
  };
})();

// ---------------------------------------------------------------------------
// Player Interactions: identity, name knowledge, restraints, and inventory
// ---------------------------------------------------------------------------
const playerInteractions = (() => {
  const DEFAULT_UNKNOWN_NAME = "Stranger";
  const DEFAULT_CUFF_BASE_IDS = [0x00103941, 0x0010E039, 0x0010E2D8];
  const asPositiveInt = accessIdentity.asPositiveInt;

  // Returns the current wall-clock time in the storage timestamp format.
  function nowIso() {
    return new Date().toISOString();
  }

  // Converts a profile id into the default character id string.
  function characterIdFromProfileId(profileId) {
    const id = asPositiveInt(profileId);
    return id === null ? null : String(id);
  }

  // Converts any stored character id into the canonical profile-id string.
  function normalizeCharacterId(value) {
    return characterIdFromProfileId(value);
  }

  // Trims display names and falls back to a stable non-empty label.
  function normalizeName(value, fallback) {
    const text = String(value || "").trim();
    return text || fallback || "Adventurer";
  }

  // Reduces identity-like input to the fields interactions need.
  function publicIdentity(input) {
    if (!input) return null;
    const profileId = asPositiveInt(input.profileId);
    if (profileId === null) return null;
    const characterId = characterIdFromProfileId(profileId);
    return {
      profileId,
      characterId,
      displayName: normalizeName(input.displayName || input.name, "Profile " + profileId),
    };
  }

  // Creates the directional known-name cache: viewer id -> known character ids.
  function createIntroductionCache() {
    return new Map();
  }

  // Normalizes a persisted introduction array into canonical character ids.
  function normalizeIntroductions(value) {
    if (!Array.isArray(value)) return [];
    const out = [];
    const seen = new Set();
    for (const entry of value) {
      const id = normalizeCharacterId(entry);
      if (id === null || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out;
  }

  // Adds one directional known-name relationship to the cache.
  function addIntroduction(cache, viewerCharacterId, knownCharacterId) {
    if (!cache || typeof cache.get !== "function" || typeof cache.set !== "function") return false;
    const viewerId = normalizeCharacterId(viewerCharacterId);
    const knownId = normalizeCharacterId(knownCharacterId);
    if (viewerId === null || knownId === null || viewerId === knownId) return false;
    let known = cache.get(viewerId);
    if (!known) {
      known = new Set();
      cache.set(viewerId, known);
    }
    known.add(knownId);
    return true;
  }

  // Checks whether one character has been introduced to another.
  function hasIntroduction(cache, viewerCharacterId, knownCharacterId) {
    const viewerId = normalizeCharacterId(viewerCharacterId);
    const knownId = normalizeCharacterId(knownCharacterId);
    if (viewerId === null || knownId === null) return false;
    const known = cache && typeof cache.get === "function" ? cache.get(viewerId) : null;
    return !!known && typeof known.has === "function" && known.has(knownId);
  }

  // Counts all cached directional introductions.
  function countIntroductions(cache) {
    if (!cache || typeof cache.values !== "function") return 0;
    let count = 0;
    for (const known of cache.values()) {
      if (known && typeof known.size === "number") count += known.size;
    }
    return count;
  }

  // Returns the target's visible name from the viewer's knowledge state.
  function visibleName(cache, viewer, target, unknownName) {
    const viewerIdentity = publicIdentity(viewer);
    const targetIdentity = publicIdentity(target);
    if (!targetIdentity) return unknownName || DEFAULT_UNKNOWN_NAME;
    if (!viewerIdentity) return unknownName || DEFAULT_UNKNOWN_NAME;
    if (viewerIdentity.characterId === targetIdentity.characterId) return targetIdentity.displayName;
    return hasIntroduction(cache, viewerIdentity.characterId, targetIdentity.characterId)
      ? targetIdentity.displayName
      : (unknownName || DEFAULT_UNKNOWN_NAME);
  }

  // Clones an inventory entry without preserving object identity.
  function cloneEntry(entry) {
    return Object.assign({}, entry || {});
  }

  // Clones an inventory using cloned entry objects.
  function cloneInventory(inv) {
    return { entries: inventoryEntries(inv).map(cloneEntry) };
  }

  // Normalizes configured cuff base ids with defaults and de-duplication.
  function normalizeCuffIds(ids) {
    const source = Array.isArray(ids) && ids.length ? ids : DEFAULT_CUFF_BASE_IDS;
    const out = [];
    for (const id of source) {
      const number = Number(id);
      if (Number.isInteger(number) && number > 0 && !out.includes(number)) out.push(number);
    }
    return out.length ? out : DEFAULT_CUFF_BASE_IDS.slice();
  }

  // Compares item stack metadata while ignoring stack count.
  function sameEntryExceptCount(a, b) {
    const left = Object.assign({}, a || {});
    const right = Object.assign({}, b || {});
    delete left.count;
    delete right.count;
    const keys = Array.from(new Set(Object.keys(left).concat(Object.keys(right)))).sort();
    return JSON.stringify(left, keys) === JSON.stringify(right, keys);
  }

  // Aggregates usable cuff stacks by allowed base id.
  function findCuffOptions(inv, cuffBaseIds) {
    const allowed = normalizeCuffIds(cuffBaseIds);
    const totals = new Map();
    for (const entry of inventoryEntries(inv)) {
      if (!entry || !allowed.includes(Number(entry.baseId))) continue;
      const count = Math.max(0, Math.floor(Number(entry.count) || 0));
      if (count <= 0) continue;
      const baseId = Number(entry.baseId);
      totals.set(baseId, (totals.get(baseId) || 0) + count);
    }
    return Array.from(totals.entries())
      .map(([baseId, count]) => ({ baseId, count }))
      .sort((a, b) => a.baseId - b.baseId);
  }

  // Removes one cuff from inventory and returns both next inventory and item.
  function takeOneCuff(inv, cuffBaseId, cuffBaseIds) {
    const allowed = normalizeCuffIds(cuffBaseIds);
    const baseId = Number(cuffBaseId);
    if (!allowed.includes(baseId)) return null;

    const next = cloneInventory(inv);
    for (let i = 0; i < next.entries.length; i++) {
      const entry = next.entries[i];
      if (!entry || Number(entry.baseId) !== baseId) continue;
      const count = Math.max(0, Math.floor(Number(entry.count) || 0));
      if (count <= 0) continue;

      const cuffEntry = cloneEntry(entry);
      cuffEntry.baseId = baseId;
      cuffEntry.count = 1;

      if (count <= 1) {
        next.entries.splice(i, 1);
      } else {
        entry.count = count - 1;
      }

      return { inventory: next, cuffEntry };
    }
    return null;
  }

  // Adds a cuff entry to inventory, stacking with matching metadata when able.
  function addCuff(inv, cuffEntry) {
    if (!cuffEntry || !Number.isInteger(Number(cuffEntry.baseId))) return cloneInventory(inv);
    const next = cloneInventory(inv);
    const entryToAdd = cloneEntry(cuffEntry);
    entryToAdd.baseId = Number(entryToAdd.baseId);
    entryToAdd.count = Math.max(1, Math.floor(Number(entryToAdd.count) || 1));

    const stack = next.entries.find((entry) => entry && sameEntryExceptCount(entry, entryToAdd));
    if (stack) {
      stack.count = Math.max(0, Math.floor(Number(stack.count) || 0)) + entryToAdd.count;
    } else {
      next.entries.push(entryToAdd);
    }

    return next;
  }

  // Alias for removing one cuff, kept for call-site readability.
  function removeOneCuff(inv, cuffBaseId, cuffBaseIds) {
    return takeOneCuff(inv, cuffBaseId, cuffBaseIds);
  }

  // Calculates 3D distance between two position arrays.
  function distance3(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b)) return Infinity;
    const dx = (Number(a[0]) || 0) - (Number(b[0]) || 0);
    const dy = (Number(a[1]) || 0) - (Number(b[1]) || 0);
    const dz = (Number(a[2]) || 0) - (Number(b[2]) || 0);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  // Creates actor-state readers backed only by standard SkyMP bindings.
  function createActorHelpers(mp, options) {
    const maxDistance = Math.max(0, Number(options && options.maxDistance) || 0);
    const actorByUser = new Map();
    const userByActor = new Map();

    function normalizeActorFormId(value) {
      const number = Number(value);
      return Number.isInteger(number) && number !== 0 ? number : null;
    }

    // Remembers the latest standard user slot <-> player actor mapping seen by this extension.
    function rememberActorUser(userId, pcFormId) {
      const normalizedUserId = asPositiveInt(userId);
      const actorId = normalizeActorFormId(pcFormId);
      if (normalizedUserId === null || actorId === null) return 0;

      actorByUser.set(normalizedUserId, actorId);
      userByActor.set(actorId, normalizedUserId);
      return actorId;
    }

    // Clears cached mapping for a user slot, usually after disconnect cleanup has run.
    function forgetUser(userId) {
      const normalizedUserId = asPositiveInt(userId);
      if (normalizedUserId === null) return;

      const actorId = actorByUser.get(normalizedUserId);
      actorByUser.delete(normalizedUserId);
      if (actorId !== undefined) userByActor.delete(actorId);
    }

    // Clears cached mapping for an actor, useful when an extension retires per-actor state directly.
    function forgetActor(pcFormId) {
      const actorId = normalizeActorFormId(pcFormId);
      if (actorId === null) return;

      const userId = userByActor.get(actorId);
      userByActor.delete(actorId);
      if (userId !== undefined) actorByUser.delete(userId);
    }

    // Checks whether a player actor is addressable by probing standard bindings.
    function exists(pcFormId) {
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

    // Returns the currently online player actor ids in numeric server format.
    function onlinePlayers() {
      try {
        const online = mp.get(0xff000000, "onlinePlayers");
        return Array.isArray(online) ? online.map(Number).filter(Number.isFinite) : [];
      } catch (e) {
        return [];
      }
    }

    // Checks whether a player actor id is present in the online-player list.
    function isOnlinePlayer(pcFormId) {
      return onlinePlayers().indexOf(Number(pcFormId)) !== -1;
    }

    // Resolves a connected user slot to its current actor form id.
    function actorFromUser(userId) {
      const normalizedUserId = asPositiveInt(userId);
      if (normalizedUserId === null) return 0;

      try {
        const actorId = mp.getUserActor(normalizedUserId);
        if (actorId && actorId !== 0) return rememberActorUser(normalizedUserId, actorId);
      } catch (e) {
        // Disconnect hooks can run while native user/actor lookup is already winding down.
      }
      return actorByUser.get(normalizedUserId) || 0;
    }

    // Resolves a player actor form id to the owning user slot.
    function userFromActor(pcFormId) {
      const actorId = normalizeActorFormId(pcFormId);
      if (actorId === null) return null;

      try {
        const userId = mp.getUserByActor(actorId);
        const normalizedUserId = asPositiveInt(userId);
        if (normalizedUserId !== null) {
          rememberActorUser(normalizedUserId, actorId);
          return normalizedUserId;
        }
      } catch (e) {
        // Fall through to the local mapping remembered from earlier standard lookups.
      }
      return userByActor.has(actorId) ? userByActor.get(actorId) : null;
    }

    // Reads public interaction identity from the actor's standard profile data.
    function identity(pcFormId) {
      const who = accessIdentity.getIdentity(mp, pcFormId);
      return publicIdentity(who);
    }

    // Reads the best available display name for UI payloads.
    function displayName(pcFormId, fallback) {
      return accessIdentity.getDisplayName(mp, pcFormId, fallback || "Adventurer");
    }

    // Reads an actor inventory using the standard SkyMP inventory binding.
    function inventory(pcFormId) {
      try {
        return mp.get(pcFormId, "inventory") || { entries: [] };
      } catch (e) {
        return { entries: [] };
      }
    }

    // Writes an actor inventory and reports whether the binding accepted it.
    function setInventory(pcFormId, inv) {
      try {
        mp.set(pcFormId, "inventory", inv || { entries: [] });
        return true;
      } catch (e) {
        return false;
      }
    }

    // Determines dead state from standard isDead and percentages.health bindings.
    function isDead(pcFormId) {
      try {
        if (mp.get(pcFormId, "isDead") === true) return true;
      } catch (e) {}

      try {
        const percentages = mp.get(pcFormId, "percentages");
        const health = percentages && percentages.health;
        if (Number.isFinite(Number(health)) && Number(health) <= 0) return true;
      } catch (e) {}

      return false;
    }

    // Reads the actor world position from the standard pos binding.
    function position(pcFormId) {
      try {
        return mp.get(pcFormId, "pos");
      } catch (e) {
        return null;
      }
    }

    // Reads the actor's current cell/world descriptor.
    function cell(pcFormId) {
      try {
        return String(mp.get(pcFormId, "worldOrCellDesc") || "");
      } catch (e) {
        return "";
      }
    }

    // Validates that two actors are in the same cell and within range.
    function rangeStatus(a, b, overrideMaxDistance) {
      const limit = Math.max(0, Number(overrideMaxDistance) || maxDistance);
      const cellA = cell(a);
      const cellB = cell(b);
      if (!cellA || !cellB || cellA !== cellB) return { ok: false, reason: "That player is no longer nearby." };
      const dist = distance3(position(a), position(b));
      if (!Number.isFinite(dist)) return { ok: false, reason: "Could not validate distance." };
      if (limit > 0 && dist > limit) return { ok: false, reason: "Move closer to interact." };
      return { ok: true, distance: dist, cell: cellA };
    }

    return {
      actorFromUser,
      cell,
      displayName,
      exists,
      forgetActor,
      forgetUser,
      identity,
      inventory,
      isDead,
      isOnlinePlayer,
      onlinePlayers,
      position,
      rangeStatus,
      setInventory,
      userFromActor,
    };
  }

  return {
    DEFAULT_CUFF_BASE_IDS,
    DEFAULT_UNKNOWN_NAME,
    addCuff,
    addIntroduction,
    asPositiveInt,
    characterIdFromProfileId,
    cloneInventory,
    countIntroductions,
    createIntroductionCache,
    createActorHelpers,
    distance3,
    findCuffOptions,
    hasIntroduction,
    normalizeCharacterId,
    normalizeCuffIds,
    normalizeIntroductions,
    normalizeName,
    nowIso,
    publicIdentity,
    removeOneCuff,
    takeOneCuff,
    visibleName,
  };
})();

// ---------------------------------------------------------------------------
// Trading: tradable item validation and inventory transfer helpers
// ---------------------------------------------------------------------------
const trade = (() => {
  const VGR_GOLD_BASE_ID = 0x0000000f;

  // Checks whether an item stack has only baseId/count trade metadata.
  function isPlainStack(entry) {
    if (!entry || typeof entry.baseId !== "number") return false;
    return Object.keys(entry).every((k) => k === "baseId" || k === "count");
  }

  // Checks whether an inventory entry can be offered in a trade.
  function isTradableEntry(entry) {
    if (!entry || typeof entry.baseId !== "number") return false;
    if (entry.worn === true) return false;
    return isPlainStack(entry);
  }

  // Adds count to an existing plain stack or creates one when absent.
  function addPlainStack(inv, baseId, count) {
    const entries = inventoryEntries(inv).slice();
    const itemId = Number(baseId);
    const amount = Number(count);
    if (!Number.isFinite(itemId) || !Number.isFinite(amount) || amount <= 0) return { entries };

    const stack = entries.find((entry) => entry && entry.baseId === itemId && isPlainStack(entry));
    if (stack) {
      stack.count = (Number(stack.count) || 0) + amount;
    } else {
      entries.push({ baseId: itemId, count: amount });
    }
    return { entries };
  }

  // Removes count from a plain stack and reports why removal failed.
  function removePlainStack(inv, baseId, count) {
    const entries = inventoryEntries(inv).slice();
    const itemId = Number(baseId);
    const amount = Number(count);
    if (!Number.isFinite(itemId) || !Number.isFinite(amount) || amount <= 0) {
      return { ok: false, reason: "invalid", inventory: { entries } };
    }

    const index = entries.findIndex((entry) => entry && entry.baseId === itemId && isPlainStack(entry));
    if (index === -1) return { ok: false, reason: "not_found", inventory: { entries }, available: 0 };

    const stack = entries[index];
    const available = Number(stack.count) || 0;
    if (available < amount) {
      return { ok: false, reason: "insufficient", inventory: { entries }, available };
    }

    if (available === amount) entries.splice(index, 1);
    else stack.count = available - amount;

    return { ok: true, inventory: { entries }, available };
  }

  // Counts tradable items matching a base id.
  function getItemCount(inv, baseId) {
    return inventoryEntries(inv)
      .filter((e) => e && e.baseId === baseId && isTradableEntry(e))
      .reduce((sum, e) => sum + (Number(e.count) || 0), 0);
  }

  // Converts a raw offer into positive integer stack counts.
  function normalizeOffer(offer) {
    if (!Array.isArray(offer)) return [];
    return offer
      .filter((item) => item && typeof item.baseId === "number")
      .map((item) => ({
        baseId: item.baseId,
        count: Math.floor(Number(item.count) || 0),
      }))
      .filter((item) => item.count > 0);
  }

  // Verifies the inventory still contains every item in an offer.
  function hasOfferItems(inv, offer) {
    for (const item of normalizeOffer(offer)) {
      if (!Number.isFinite(item.count) || item.count <= 0) return false;
      if (getItemCount(inv, item.baseId) < item.count) return false;
    }
    return true;
  }

  // Clones inventory into the trade-safe entry shape.
  function cloneInventory(inv) {
    const entries = inventoryEntries(inv)
      .filter((e) => e && typeof e.baseId === "number")
      .map((e) => {
        const copy = { baseId: e.baseId, count: Number(e.count) || 0 };
        if (e.worn === true) copy.worn = true;
        return copy;
      });
    return { entries };
  }

  // Removes offered items from an inventory in place.
  function removeItems(inv, offer) {
    const entries = inventoryEntries(inv).map((e) => ({ ...e }));

    for (const item of normalizeOffer(offer)) {
      let remaining = item.count;

      for (let i = entries.length - 1; i >= 0 && remaining > 0; i--) {
        const entry = entries[i];
        if (!entry || entry.baseId !== item.baseId) continue;
        if (!isTradableEntry(entry)) continue;

        const take = Math.min(Number(entry.count) || 0, remaining);
        entry.count -= take;
        remaining -= take;

        if (entry.count <= 0) {
          entries.splice(i, 1);
        }
      }

      if (remaining > 0) {
        throw new Error("Inventory changed during removeItems for baseId " + item.baseId);
      }
    }

    inv.entries = entries;
  }

  // Adds offered items to an inventory in place.
  function addItems(inv, offer) {
    const entries = inventoryEntries(inv).map((e) => ({ ...e }));

    for (const item of normalizeOffer(offer)) {
      const stack = entries.find((e) => e && e.baseId === item.baseId && isPlainStack(e));

      if (stack) {
        stack.count += item.count;
      } else {
        entries.push({ baseId: item.baseId, count: item.count });
      }
    }

    inv.entries = entries;
  }

  // Validates and applies both sides of a completed trade.
  function finalizeTrade(invA, invB, offerA, offerB) {
    const normalizedA = normalizeOffer(offerA);
    const normalizedB = normalizeOffer(offerB);

    if (!hasOfferItems(invA, normalizedA)) {
      throw new Error("Player A no longer has all offered items");
    }
    if (!hasOfferItems(invB, normalizedB)) {
      throw new Error("Player B no longer has all offered items");
    }

    const nextA = cloneInventory(invA);
    const nextB = cloneInventory(invB);

    removeItems(nextA, normalizedA);
    removeItems(nextB, normalizedB);
    addItems(nextA, normalizedB);
    addItems(nextB, normalizedA);

    return { invA: nextA, invB: nextB };
  }

  return {
    VGR_GOLD_BASE_ID,
    addPlainStack,
    getItemCount,
    hasOfferItems,
    removePlainStack,
    removeItems,
    addItems,
    finalizeTrade,
    normalizeOffer,
    cloneInventory,
    isTradableEntry,
    isPlainStack,
  };
})();

// Public helper namespaces consumed by gamemode extensions.
module.exports = {
  access: {
    identity: accessIdentity,
    createPermissions: createAccessPermissions,
    createDoorPair: createAccessDoorPair,
    createDoorProbe: createAccessDoorProbe,
  },
  activation,
  client,
  playerInteractions,
  trade,
};
