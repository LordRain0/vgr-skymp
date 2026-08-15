'use strict'

const db    = require('./backendDb')
const hwids = require('./hwids')

function now() {
  return new Date()
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

function normalizeOptionalDiscordId(value) {
  return String(value || '').trim() || null
}

function normalizeProfileId(value) {
  const profileId = Number(value)
  return Number.isInteger(profileId) && profileId > 0 ? profileId : null
}

function activeClause() {
  return {
    revokedAt: null,
    $or: [
      { expiresAt: null },
      { expiresAt: { $exists: false } },
      { expiresAt: { $gt: now() } },
    ],
  }
}

async function collection() {
  return db.collection('bans')
}

function publicBan(ban, source = null) {
  if (!ban) return null
  return {
    id: String(ban._id),
    source: source || ban.source || null,
    discordId: ban.discordId || null,
    profileId: normalizeProfileId(ban.profileId),
    reason: ban.reason || '',
    createdAt: ban.createdAt || null,
    expiresAt: ban.expiresAt || null,
  }
}

async function findActiveForDiscordId(discordId) {
  const owner = normalizeOptionalDiscordId(discordId)
  if (!owner) return null

  return (await collection()).findOne({
    ...activeClause(),
    discordId: owner,
  })
}

async function findActiveForHwidHash(hwidHash) {
  const fingerprint = hwids.hashHwid(hwidHash)
  if (!fingerprint) return null

  return (await collection()).findOne({
    ...activeClause(),
    hwidHash: fingerprint,
  })
}

async function findActiveForSession({ discordId, hwidHash }) {
  const directDiscordBan = await findActiveForDiscordId(discordId)
  if (directDiscordBan) {
    return publicBan(directDiscordBan, 'discordId')
  }

  const directHwidBan = await findActiveForHwidHash(hwidHash)
  if (directHwidBan) {
    return publicBan(directHwidBan, 'hwid')
  }

  const linkedDiscordIds = await hwids.getLinkedDiscordIds(hwidHash)
  if (linkedDiscordIds.length === 0) return null

  const linkedBan = await (await collection()).findOne({
    ...activeClause(),
    discordId: { $in: linkedDiscordIds },
  })
  return linkedBan ? publicBan(linkedBan, 'linkedHwid') : null
}

async function banDiscordId(discordId, input = {}) {
  const owner = normalizeDiscordId(discordId)
  const timestamp = now()
  const ban = {
    discordId: owner,
    profileId: normalizeProfileId(input.profileId),
    reason: String(input.reason || '').trim(),
    createdBy: normalizeOptionalDiscordId(input.createdBy),
    source: input.source || 'manual',
    expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
    revokedAt: null,
    revokedBy: null,
    updatedAt: timestamp,
  }

  await (await collection()).updateOne(
    { discordId: owner, revokedAt: null },
    {
      $set: ban,
      $setOnInsert: { createdAt: timestamp },
    },
    { upsert: true },
  )

  return publicBan(await findActiveForDiscordId(owner), 'discordId')
}

async function unbanDiscordId(discordId, input = {}) {
  const owner = normalizeDiscordId(discordId)
  const result = await (await collection()).updateMany(
    { discordId: owner, revokedAt: null },
    {
      $set: {
        revokedAt: now(),
        revokedBy: normalizeOptionalDiscordId(input.revokedBy),
        updatedAt: now(),
      },
    },
  )
  return { discordId: owner, revoked: result.modifiedCount }
}

module.exports = {
  banDiscordId,
  findActiveForDiscordId,
  findActiveForHwidHash,
  findActiveForSession,
  publicBan,
  unbanDiscordId,
}
