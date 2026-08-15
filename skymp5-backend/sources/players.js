'use strict'

const characters       = require('./characters')
const db               = require('./backendDb')
const factionWhitelist = require('./factionWhitelist')

const DEFAULT_MAX_CHARACTER_SLOTS = 3
const DEFAULT_HAS_PRIORITY_QUE = false
const DEFAULT_ADMIN = false

function nowIso() {
  return new Date().toISOString()
}

function normalizeDiscordId(value) {
  const discordId = String(value || '').trim()
  if (!discordId) {
    const err = new Error('discordId is required')
    err.status = 400
    throw err
  }
  return discordId
}

async function collection() {
  return db.collection('players')
}

function normalizeMaxCharacterSlots(value) {
  const slots = Number(value)
  return Number.isInteger(slots) && slots >= 0 ? slots : DEFAULT_MAX_CHARACTER_SLOTS
}

function normalizeHasPriorityQue(value) {
  return value === true
}

function normalizeAdmin(value) {
  if (value === true) return true
  if (value === 1) return true
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    return normalized === 'true' || normalized === '1' || normalized === 'yes'
  }
  return false
}

function withDefaults(player) {
  if (!player) return null
  return {
    ...player,
    maxCharacterSlots: normalizeMaxCharacterSlots(player.maxCharacterSlots),
    hasPriorityQue: normalizeHasPriorityQue(player.hasPriorityQue),
    admin: normalizeAdmin(player.admin),
  }
}

async function upsertAccount(discordUser) {
  const discordId = normalizeDiscordId(discordUser.id)
  const current = await (await collection()).findOne({ discordId })
  const timestamp = nowIso()
  const username = String(discordUser.username || current?.username || '').trim()
  const displayName = String(discordUser.global_name || discordUser.displayName || discordUser.username || current?.displayName || '').trim()
  const avatar = discordUser.avatar !== undefined ? discordUser.avatar : current?.avatar || null

  const player = {
    discordId,
    username,
    displayName,
    avatar,
    notes: current?.notes || '',
    maxCharacterSlots: discordUser.maxCharacterSlots !== undefined
      ? normalizeMaxCharacterSlots(discordUser.maxCharacterSlots)
      : normalizeMaxCharacterSlots(current?.maxCharacterSlots),
    hasPriorityQue: discordUser.hasPriorityQue !== undefined
      ? normalizeHasPriorityQue(discordUser.hasPriorityQue)
      : normalizeHasPriorityQue(current?.hasPriorityQue),
    admin: discordUser.admin !== undefined
      ? normalizeAdmin(discordUser.admin)
      : normalizeAdmin(current?.admin),
    createdAt: current?.createdAt || timestamp,
    updatedAt: timestamp,
    lastSeenAt: timestamp,
  }

  await (await collection()).updateOne(
    { discordId },
    { $set: player },
    { upsert: true },
  )

  return player
}

async function getAccountByDiscordId(discordId) {
  const col = await collection()
  const player = await col.findOne({ discordId: normalizeDiscordId(discordId) })
  const normalized = withDefaults(player)
  if (!normalized) return null

  const patch = {}
  if (player.maxCharacterSlots !== normalized.maxCharacterSlots) {
    patch.maxCharacterSlots = normalized.maxCharacterSlots
  }
  if (player.hasPriorityQue !== normalized.hasPriorityQue) {
    patch.hasPriorityQue = normalized.hasPriorityQue
  }
  if (player.admin !== normalized.admin) {
    patch.admin = normalized.admin
  }
  if (Object.keys(patch).length > 0) {
    await col.updateOne({ discordId: normalized.discordId }, { $set: patch })
  }

  return normalized
}

async function upsertFromDiscordUser(discordUser) {
  if (!discordUser || !discordUser.id) throw new Error('discordUser.id is required')

  const player = await upsertAccount(discordUser)
  return decorate({ ...player, profileId: null }, null)
}

async function createManual(input) {
  const discordId = normalizeDiscordId(input.discordId)
  const player = await upsertAccount({
    id: discordId,
    username: input.username,
    displayName: input.displayName || input.username,
    maxCharacterSlots: input.maxCharacterSlots,
    hasPriorityQue: input.hasPriorityQue,
    admin: input.admin,
  })
  const character = await characters.getOrCreateDefault(discordId, player)
  return decorate({ ...player, profileId: character.profileId }, character)
}

async function updateByProfileId(profileId, patch) {
  const character = await characters.getByProfileId(profileId)
  if (!character) {
    const err = new Error('player not found')
    err.status = 404
    throw err
  }

  const current = await (await collection()).findOne({ discordId: character.discordId })
  const next = {
    discordId: character.discordId,
    username: patch.username !== undefined ? String(patch.username || '').trim() : current?.username || '',
    displayName: patch.displayName !== undefined ? String(patch.displayName || '').trim() : current?.displayName || '',
    avatar: current?.avatar || null,
    notes: patch.notes !== undefined ? String(patch.notes || '').trim() : current?.notes || '',
    maxCharacterSlots: patch.maxCharacterSlots !== undefined
      ? normalizeMaxCharacterSlots(patch.maxCharacterSlots)
      : normalizeMaxCharacterSlots(current?.maxCharacterSlots),
    hasPriorityQue: patch.hasPriorityQue !== undefined
      ? normalizeHasPriorityQue(patch.hasPriorityQue)
      : normalizeHasPriorityQue(current?.hasPriorityQue),
    admin: patch.admin !== undefined
      ? normalizeAdmin(patch.admin)
      : normalizeAdmin(current?.admin),
    createdAt: current?.createdAt || nowIso(),
    updatedAt: nowIso(),
    lastSeenAt: current?.lastSeenAt || null,
  }

  await (await collection()).updateOne(
    { discordId: character.discordId },
    { $set: next },
    { upsert: true },
  )

  return decorate({ ...next, profileId: character.profileId }, character)
}

async function list() {
  const col = await collection()
  const activeCharacters = await characters.listActive()
  const result = []

  for (const character of activeCharacters) {
    const player = await col.findOne({ discordId: character.discordId }) || {
      discordId: character.discordId,
      username: '',
      displayName: '',
      avatar: null,
      notes: '',
      maxCharacterSlots: DEFAULT_MAX_CHARACTER_SLOTS,
      hasPriorityQue: DEFAULT_HAS_PRIORITY_QUE,
      admin: DEFAULT_ADMIN,
      createdAt: null,
      updatedAt: null,
      lastSeenAt: null,
    }
    result.push(decorate({ ...player, profileId: character.profileId }, character))
  }

  return result.sort((a, b) => a.profileId - b.profileId)
}

async function getByProfileId(profileId) {
  const character = await characters.getByProfileId(profileId)
  if (!character) return null

  const player = await (await collection()).findOne({ discordId: character.discordId }) || {
    discordId: character.discordId,
    username: '',
    displayName: '',
    avatar: null,
    notes: '',
    maxCharacterSlots: DEFAULT_MAX_CHARACTER_SLOTS,
    hasPriorityQue: DEFAULT_HAS_PRIORITY_QUE,
    admin: DEFAULT_ADMIN,
    createdAt: null,
    updatedAt: null,
    lastSeenAt: null,
  }

  return decorate({ ...player, profileId: character.profileId }, character)
}

function decorate(player, character = null) {
  const normalizedPlayer = withDefaults(player)
  const profileId = Number(normalizedPlayer.profileId)
  return {
    ...normalizedPlayer,
    profileId: Number.isInteger(profileId) && profileId > 0 ? profileId : null,
    character: character ? {
      profileId: character.profileId,
      name: character.name,
      portrait: character.portrait || null,
      balance: typeof character.balance === 'number' ? character.balance : 0,
      createdAt: character.createdAt,
      updatedAt: character.updatedAt,
      lastPlayedAt: character.lastPlayedAt || null,
      deletedAt: character.deletedAt || null,
    } : null,
    assignments: factionWhitelist.getPlayerAssignments(normalizedPlayer.discordId),
    factionPermissions: factionWhitelist.getPlayerFactionPermissions(normalizedPlayer.discordId),
    gameFactions: factionWhitelist.getPlayerGameFactions(normalizedPlayer.discordId),
  }
}

module.exports = {
  DEFAULT_ADMIN,
  DEFAULT_HAS_PRIORITY_QUE,
  DEFAULT_MAX_CHARACTER_SLOTS,
  createManual,
  getAccountByDiscordId,
  getByProfileId,
  list,
  updateByProfileId,
  upsertFromDiscordUser,
}
