"use strict";

const identity = require("./vgr_access_identity");

module.exports = (mp, settings) => {
  const LOG = "[VGR access permissions]";
  const accessSettings = settings.vgrAccessControl || {};
  const configured = accessSettings.permissions || {};
  const permissionCache = new Map();
  const CACHE_MS = Math.max(1000, Number(accessSettings.permissionCacheMs) || 10000);

  function toStringSet(values) {
    if (!Array.isArray(values)) return new Set();
    return new Set(values.map((value) => String(value)).filter(Boolean));
  }

  function toNumberSet(values) {
    if (!Array.isArray(values)) return new Set();
    const out = new Set();
    for (const value of values) {
      const number = identity.asPositiveInt(value);
      if (number !== null) out.add(number);
    }
    return out;
  }

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

  function evaluate(pcFormId, name) {
    const who = identity.getIdentity(mp, pcFormId);
    if (!who) return { allowed: false, identity: null };

    const config = readPermissionConfig(name);
    const allowed =
      config.profileIds.has(who.profileId) ||
      (who.discordId && config.discordIds.has(who.discordId)) ||
      who.discordRoles.some((role) => config.discordRoleIds.has(String(role)));

    return { allowed, identity: who };
  }

  function hasPermission(pcFormId, name) {
    const key = String(pcFormId) + ":" + String(name);
    const cached = permissionCache.get(key);
    const now = Date.now();
    if (cached && now - cached.time < CACHE_MS) return cached.value;

    const value = evaluate(pcFormId, name);
    permissionCache.set(key, { time: now, value });
    return value;
  }

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

  const manage = readPermissionConfig("vgr.access.manage");
  if (manage.profileIds.size === 0 && manage.discordIds.size === 0 && manage.discordRoleIds.size === 0) {
    console.warn(LOG, "no vgr.access.manage permission source configured; admin mutations will fail closed");
  }

  const api = { hasPermission, invalidate };
  mp.vgrAccessPermissions = api;
  return api;
};
