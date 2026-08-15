'use strict'

const db = require('./backendDb')

const MAX_CHARACTER_SLOTS = 3
const DEFAULT_CHARACTER_DELETION_GRACE_MS = 3 * 60 * 1000
const CHARACTER_LOCK_TIMEOUT_MS = 30000
const CHARACTER_LOCK_RETRY_MS = 50
const CHARACTER_LOCK_ATTEMPTS = 100

function nowIso() {
  return new Date().toISOString()
}

function normalizeName(input, fallback) {
  const value = String(input || '').trim()
  return value || fallback
}

async function collection() {
  return db.collection('characters')
}

async function lockCollection() {
  return db.collection('characterLocks')
}

function normalizeMaxSlots(value) {
  const slots = Number(value)
  return Number.isInteger(slots) && slots >= 0 ? slots : MAX_CHARACTER_SLOTS
}

function isDuplicateKeyError(err) {
  return err?.code === 11000 || err?.codeName === 'DuplicateKey'
}

function deletionGraceMs() {
  const configured = Number(
    process.env.CHARACTER_DELETION_GRACE_MS || process.env.CHARACTER_DELETE_DELAY_MS,
  )
  return Number.isFinite(configured) && configured >= 0
    ? configured
    : DEFAULT_CHARACTER_DELETION_GRACE_MS
}

function isDeletionPending(character) {
  return !!character && !character.deletedAt && !!character.deleteAt
}

function isValidProfileId(profileId) {
  const id = Number(profileId)
  return Number.isInteger(id) && id >= 0
}

async function listForDiscordId(discordId, options = {}) {
  const col = await collection()
  const query = { discordId: String(discordId), profileId: { $gte: 0 } }
  if (!options.includeDeleted) query.deletedAt = null

  return col.find(query)
    .sort({ profileId: 1 })
    .toArray()
}

async function listActive() {
  const col = await collection()
  return col.find({ deletedAt: null, profileId: { $gte: 0 } })
    .sort({ profileId: 1 })
    .toArray()
}

async function getByProfileId(profileId, options = {}) {
  const id = Number(profileId)
  if (!isValidProfileId(id)) return null

  const query = { profileId: id }
  if (!options.includeDeleted) query.deletedAt = null

  return (await collection()).findOne(query)
}

async function maxAllocatedProfileId() {
  const col = await collection()
  const records = await col.find({}, { projection: { profileId: 1 } }).toArray()
  return records.reduce((max, record) => {
    const id = Number(record.profileId)
    return Number.isInteger(id) && id > max ? id : max
  }, -1)
}

async function ensureProfileIdCounter() {
  const highestProfileId = await maxAllocatedProfileId()
  const counter = await db.getSequence('profileId')
  const counterValue = Number(counter?.value)
  if (!Number.isInteger(counterValue) || counterValue < highestProfileId) {
    await db.setSequenceAtLeast('profileId', highestProfileId)
  }
}

async function allocateProfileId() {
  await ensureProfileIdCounter()
  const profileId = await db.nextSequence('profileId')
  if (isValidProfileId(profileId)) return profileId

  const err = new Error('failed to allocate profileId')
  err.status = 500
  throw err
}

async function belongsToDiscordId(profileId, discordId) {
  const character = await getByProfileId(profileId)
  return !!character && character.discordId === String(discordId)
}

async function isPlayableByDiscordId(profileId, discordId) {
  const character = await getByProfileId(profileId)
  return !!character && character.discordId === String(discordId) && !isDeletionPending(character)
}

async function countActiveForDiscordId(discordId) {
  return (await collection()).countDocuments({
    discordId: String(discordId),
    profileId: { $gte: 0 },
    deletedAt: null,
  })
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function acquireCharacterLock(discordId) {
  const owner = String(discordId)
  const locks = await lockCollection()

  for (let attempt = 0; attempt < CHARACTER_LOCK_ATTEMPTS; attempt++) {
    const now = new Date()
    await locks.deleteOne({ _id: owner, expiresAt: { $lte: now } })

    try {
      await locks.insertOne({
        _id: owner,
        expiresAt: new Date(Date.now() + CHARACTER_LOCK_TIMEOUT_MS),
      })
      return owner
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err
      await sleep(CHARACTER_LOCK_RETRY_MS)
    }
  }

  const err = new Error('character creation is already in progress')
  err.status = 429
  throw err
}

async function releaseCharacterLock(lockId) {
  if (lockId) await (await lockCollection()).deleteOne({ _id: lockId })
}

async function createForDiscordId(discordId, input = {}, options = {}) {
  const owner = String(discordId || '').trim()
  if (!owner) {
    const err = new Error('discordId is required')
    err.status = 400
    throw err
  }

  const lockId = await acquireCharacterLock(owner)
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      const activeCount = await countActiveForDiscordId(owner)
      if (activeCount >= normalizeMaxSlots(options.maxCharacterSlots)) {
        const err = new Error('character limit reached')
        err.status = 409
        throw err
      }

      const profileId = await allocateProfileId()
      const createdAt = nowIso()
      const character = {
        profileId,
        discordId: owner,
        name: normalizeName(input.name, `Character ${activeCount + 1}`),
        portrait: input.portrait || null,
        balance: 0,
        createdAt,
        updatedAt: createdAt,
        lastPlayedAt: null,
        deleteRequestedAt: null,
        deleteAt: null,
        deletedAt: null,
      }

      try {
        await (await collection()).insertOne(character)
        return character
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err
        await db.setSequenceAtLeast('profileId', await maxAllocatedProfileId())
      }
    }

    const err = new Error('failed to create character without a profileId collision')
    err.status = 409
    throw err
  } finally {
    await releaseCharacterLock(lockId)
  }
}

async function getBalance(profileId) {
  const character = await getByProfileId(profileId)
  return typeof character?.balance === 'number' ? character.balance : 0
}

async function markActive(profileId) {
  const id = Number(profileId)
  if (!isValidProfileId(id)) return false

  const timestamp = nowIso()
  const result = await (await collection()).updateOne(
    { profileId: id, deletedAt: null },
    { $set: { lastActiveAt: timestamp, updatedAt: timestamp } },
  )
  return result.matchedCount > 0
}

async function wasRecentlyActive(profileId, withinMs) {
  const id = Number(profileId)
  const windowMs = Number(withinMs)
  if (!isValidProfileId(id) || !Number.isFinite(windowMs) || windowMs <= 0) {
    return false
  }

  const since = new Date(Date.now() - windowMs).toISOString()
  const count = await (await collection()).countDocuments({
    profileId: id,
    deletedAt: null,
    lastActiveAt: { $gte: since },
  })
  return count > 0
}

async function setBalance(profileId, balance) {
  const id = Number(profileId)
  const value = Number(balance)
  if (!isValidProfileId(id) || !Number.isFinite(value)) {
    const err = new Error('invalid balance update')
    err.status = 400
    throw err
  }

  const result = await (await collection()).updateOne(
    { profileId: id, deletedAt: null },
    { $set: { balance: value, updatedAt: nowIso() } },
  )

  if (result.matchedCount === 0) {
    const err = new Error('character not found')
    err.status = 404
    throw err
  }
}

async function spendBalance(profileId, amount) {
  const id = Number(profileId)
  const value = Number(amount)
  if (!isValidProfileId(id) || !Number.isFinite(value) || value < 0) {
    const err = new Error('invalid balance spend request')
    err.status = 400
    throw err
  }

  const result = await (await collection()).updateOne(
    {
      profileId: id,
      deletedAt: null,
      $expr: { $gte: [{ $ifNull: ['$balance', 0] }, value] },
    },
    {
      $inc: { balance: -value },
      $set: { updatedAt: nowIso() },
    },
  )

  return result.matchedCount > 0
}

async function getOrCreateDefault(discordId, input = {}) {
  const existing = await listForDiscordId(discordId)
  if (existing.length > 0) return existing[0]

  return createForDiscordId(discordId, {
    name: input.displayName || input.username || 'Character 1',
    portrait: input.portrait || null,
  })
}

async function deleteForDiscordId(discordId, profileId) {
  return scheduleDeleteForDiscordId(discordId, profileId)
}

async function scheduleDeleteForDiscordId(discordId, profileId) {
  const owner = String(discordId || '').trim()
  const id = Number(profileId)
  if (!owner || !isValidProfileId(id)) {
    const err = new Error('invalid character delete request')
    err.status = 400
    throw err
  }

  const existing = await (await collection()).findOne({
    profileId: id,
    discordId: owner,
    deletedAt: null,
  })

  if (!existing) {
    const err = new Error('character not found')
    err.status = 404
    throw err
  }

  if (isDeletionPending(existing)) return existing

  const deleteRequestedAt = nowIso()
  const deleteAt = new Date(Date.now() + deletionGraceMs()).toISOString()
  const result = await (await collection()).findOneAndUpdate(
    { profileId: id, discordId: owner, deletedAt: null },
    {
      $set: { deleteRequestedAt, deleteAt, updatedAt: deleteRequestedAt },
      $unset: { deletionStartedAt: '' },
    },
    { returnDocument: 'after' },
  )
  const character = result && result.value ? result.value : result

  if (!character) {
    const err = new Error('character not found')
    err.status = 404
    throw err
  }

  return character
}

async function cancelDeleteForDiscordId(discordId, profileId) {
  const owner = String(discordId || '').trim()
  const id = Number(profileId)
  if (!owner || !isValidProfileId(id)) {
    const err = new Error('invalid character delete cancellation request')
    err.status = 400
    throw err
  }

  const existing = await (await collection()).findOne({
    profileId: id,
    discordId: owner,
    deletedAt: null,
  })

  if (!existing) {
    const err = new Error('character not found')
    err.status = 404
    throw err
  }

  if (!isDeletionPending(existing)) return existing

  if (existing.deletionStartedAt) {
    const err = new Error('character deletion is already being finalized')
    err.status = 409
    throw err
  }

  const updatedAt = nowIso()
  const result = await (await collection()).findOneAndUpdate(
    {
      profileId: id,
      discordId: owner,
      deletedAt: null,
      $or: [
        { deletionStartedAt: { $exists: false } },
        { deletionStartedAt: null },
      ],
    },
    {
      $set: { updatedAt },
      $unset: { deleteRequestedAt: '', deleteAt: '', deletionStartedAt: '' },
    },
    { returnDocument: 'after' },
  )
  const character = result && result.value ? result.value : result

  if (!character) {
    const err = new Error('character deletion is already being finalized')
    err.status = 409
    throw err
  }

  return character
}

async function listDueForDeletion(now = new Date()) {
  const cutoff = now instanceof Date ? now.toISOString() : new Date(now).toISOString()
  return (await collection()).find({
    profileId: { $gte: 0 },
    deletedAt: null,
    deleteAt: { $lte: cutoff },
  })
    .sort({ deleteAt: 1, profileId: 1 })
    .toArray()
}

async function markDeletionStarted(profileId) {
  const id = Number(profileId)
  if (!isValidProfileId(id)) return null

  const deletionStartedAt = nowIso()
  const result = await (await collection()).findOneAndUpdate(
    {
      profileId: id,
      deletedAt: null,
      deleteAt: { $ne: null },
      $or: [
        { deletionStartedAt: { $exists: false } },
        { deletionStartedAt: null },
      ],
    },
    { $set: { deletionStartedAt, updatedAt: deletionStartedAt } },
    { returnDocument: 'after' },
  )
  return result && result.value ? result.value : result
}

async function finalizeDeletion(profileId) {
  const id = Number(profileId)
  if (!isValidProfileId(id)) return null

  const deletedAt = nowIso()
  const result = await (await collection()).findOneAndUpdate(
    {
      profileId: id,
      deletedAt: null,
      deleteAt: { $ne: null },
    },
    { $set: { deletedAt, deletionCompletedAt: deletedAt, updatedAt: deletedAt } },
    { returnDocument: 'after' },
  )
  return result && result.value ? result.value : result
}

async function updateForDiscordId(discordId, profileId, input = {}) {
  const owner = String(discordId || '').trim()
  const id = Number(profileId)
  if (!owner || !isValidProfileId(id)) {
    const err = new Error('invalid character update request')
    err.status = 400
    throw err
  }

  const patch = {
    updatedAt: nowIso(),
    appearanceSyncedAt: nowIso(),
  }

  const name = String(input.name || '').trim()
  if (name) patch.name = name

  if (input.portrait !== undefined) {
    patch.portrait = input.portrait || null
  }

  const result = await (await collection()).findOneAndUpdate(
    { profileId: id, discordId: owner, deletedAt: null },
    { $set: patch },
    { returnDocument: 'after' },
  )
  const character = result && result.value ? result.value : result

  if (!character) {
    const err = new Error('character not found')
    err.status = 404
    throw err
  }

  return character
}

module.exports = {
  DEFAULT_CHARACTER_DELETION_GRACE_MS,
  MAX_CHARACTER_SLOTS,
  belongsToDiscordId,
  cancelDeleteForDiscordId,
  createForDiscordId,
  deleteForDiscordId,
  deletionGraceMs,
  finalizeDeletion,
  getByProfileId,
  getBalance,
  getOrCreateDefault,
  isValidProfileId,
  isDeletionPending,
  isPlayableByDiscordId,
  listDueForDeletion,
  listActive,
  listForDiscordId,
  markDeletionStarted,
  markActive,
  scheduleDeleteForDiscordId,
  setBalance,
  spendBalance,
  updateForDiscordId,
  wasRecentlyActive,
}
