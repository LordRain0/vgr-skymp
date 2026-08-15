"use strict";

function nowIso() {
  return new Date().toISOString();
}

function asPositiveInt(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function normalizeName(value, fallback) {
  const text = String(value || "").trim();
  return text || fallback || "Unknown";
}

function actorExists(mp, pcFormId) {
  if (pcFormId == null || pcFormId === 0) return false;
  try {
    mp.get(pcFormId, "profileId");
    return true;
  } catch (e) {
    return false;
  }
}

function getDisplayName(mp, pcFormId, fallback) {
  const fields = ["appearance", "appearanceDump"];
  for (const field of fields) {
    try {
      const value = mp.get(pcFormId, field);
      if (value && value.name) return normalizeName(value.name, fallback);
    } catch (e) {
      // Field may not be present on older actors.
    }
  }
  return normalizeName(fallback, "Adventurer");
}

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

function publicCharacter(character) {
  if (!character) return null;
  const profileId = asPositiveInt(character.profileId);
  if (profileId === null) return null;
  return {
    profileId,
    displayName: normalizeName(character.displayName || character.name, "Profile " + profileId),
  };
}

function sameProfile(a, b) {
  const left = asPositiveInt(a);
  const right = asPositiveInt(b);
  return left !== null && right !== null && left === right;
}

function isOwner(doc, profileId) {
  return !!doc && !!doc.owner && sameProfile(doc.owner.profileId, profileId);
}

function isUser(doc, profileId) {
  return !!doc && Array.isArray(doc.users) && doc.users.some((entry) => sameProfile(entry && entry.profileId, profileId));
}

function canAccess(doc, identity, hasAdminPermission) {
  if (!doc) return false;
  if (doc.locked !== true) return true;
  return false;
}

function canManage(doc, identity, hasAdminPermission) {
  if (hasAdminPermission) return true;
  if (!doc || !identity) return false;
  return isOwner(doc, identity.profileId);
}

function canManageOwner(doc, identity, hasAdminPermission) {
  return hasAdminPermission === true;
}

function canAddUser(doc, identity, hasAdminPermission) {
  return hasAdminPermission === true && !!doc;
}

function canRemoveUser(doc, identity, hasAdminPermission) {
  return canManage(doc, identity, hasAdminPermission);
}

function canToggleLock(doc, identity, hasAdminPermission) {
  return !!doc && canManage(doc, identity, hasAdminPermission);
}

module.exports = {
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
