"use strict";

const DEFAULT_UNKNOWN_NAME = "Stranger";
const DEFAULT_CUFF_BASE_IDS = [0x00103941, 0x0010E039, 0x0010E2D8];

function nowIso() {
  return new Date().toISOString();
}

function asPositiveInt(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function characterIdFromProfileId(profileId) {
  const id = asPositiveInt(profileId);
  return id === null ? null : String(id);
}

function normalizeName(value, fallback) {
  const text = String(value || "").trim();
  return text || fallback || "Adventurer";
}

function publicIdentity(input) {
  if (!input) return null;
  const profileId = asPositiveInt(input.profileId);
  if (profileId === null) return null;
  const characterId = input.characterId ? String(input.characterId) : characterIdFromProfileId(profileId);
  return {
    profileId,
    characterId,
    displayName: normalizeName(input.displayName || input.name, "Profile " + profileId),
  };
}

function introKey(viewerCharacterId, knownCharacterId) {
  if (viewerCharacterId == null || knownCharacterId == null) return null;
  return String(viewerCharacterId) + ":" + String(knownCharacterId);
}

function hasIntroduction(cache, viewerCharacterId, knownCharacterId) {
  const key = introKey(viewerCharacterId, knownCharacterId);
  return !!key && !!cache && typeof cache.has === "function" && cache.has(key);
}

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

function cloneEntry(entry) {
  return Object.assign({}, entry || {});
}

function getEntries(inv) {
  return Array.isArray(inv && inv.entries) ? inv.entries : [];
}

function cloneInventory(inv) {
  return { entries: getEntries(inv).map(cloneEntry) };
}

function normalizeCuffIds(ids) {
  const source = Array.isArray(ids) && ids.length ? ids : DEFAULT_CUFF_BASE_IDS;
  const out = [];
  for (const id of source) {
    const number = Number(id);
    if (Number.isInteger(number) && number > 0 && !out.includes(number)) out.push(number);
  }
  return out.length ? out : DEFAULT_CUFF_BASE_IDS.slice();
}

function sameEntryExceptCount(a, b) {
  const left = Object.assign({}, a || {});
  const right = Object.assign({}, b || {});
  delete left.count;
  delete right.count;
  const keys = Array.from(new Set(Object.keys(left).concat(Object.keys(right)))).sort();
  return JSON.stringify(left, keys) === JSON.stringify(right, keys);
}

function findCuffOptions(inv, cuffBaseIds) {
  const allowed = normalizeCuffIds(cuffBaseIds);
  const totals = new Map();
  for (const entry of getEntries(inv)) {
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

function removeOneCuff(inv, cuffBaseId, cuffBaseIds) {
  return takeOneCuff(inv, cuffBaseId, cuffBaseIds);
}

function distance3(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return Infinity;
  const dx = (Number(a[0]) || 0) - (Number(b[0]) || 0);
  const dy = (Number(a[1]) || 0) - (Number(b[1]) || 0);
  const dz = (Number(a[2]) || 0) - (Number(b[2]) || 0);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

module.exports = {
  DEFAULT_CUFF_BASE_IDS,
  DEFAULT_UNKNOWN_NAME,
  addCuff,
  asPositiveInt,
  characterIdFromProfileId,
  cloneInventory,
  distance3,
  findCuffOptions,
  hasIntroduction,
  introKey,
  normalizeCuffIds,
  normalizeName,
  nowIso,
  publicIdentity,
  removeOneCuff,
  takeOneCuff,
  visibleName,
};
