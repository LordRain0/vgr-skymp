'use strict'

const crypto = require('crypto')
const db     = require('./backendDb')

const SESSION_TTL = 24 * 60 * 60 * 1000

async function collection() {
  return db.collection('playSessions')
}

function normalizeProfileId(profileId) {
  const id = Number(profileId)
  return Number.isInteger(id) && id >= 0 ? id : null
}

async function create({ discordId, username = '', profileId }) {
  const token = crypto.randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + SESSION_TTL)
  const selectedProfileId = normalizeProfileId(profileId)
  await (await collection()).insertOne({
    token,
    profileId: selectedProfileId,
    discordId,
    username,
    expiresAt,
    createdAt: new Date(),
    launchCheck: null,
  })

  return { profileId: selectedProfileId, session: token }
}

async function lookup(token) {
  if (!token) return null

  const entry = await (await collection()).findOne({
    token,
    expiresAt: { $gt: new Date() },
  })

  if (!entry) return null
  return {
    token: entry.token,
    profileId: normalizeProfileId(entry.profileId),
    discordId: entry.discordId,
    username: entry.username,
    expiresAt: entry.expiresAt,
    launchCheck: entry.launchCheck || null,
  }
}

async function refresh(token) {
  const expiresAt = new Date(Date.now() + SESSION_TTL)
  await (await collection()).updateOne({ token }, { $set: { expiresAt } })
}

async function markActive(token) {
  const timestamp = new Date()
  const expiresAt = new Date(Date.now() + SESSION_TTL)
  const result = await (await collection()).updateOne(
    { token, expiresAt: { $gt: timestamp } },
    { $set: { lastActiveAt: timestamp, expiresAt } },
  )
  return result.matchedCount > 0
}

async function wasRecentlyActive(discordId, withinMs) {
  const owner = String(discordId || '').trim()
  const windowMs = Number(withinMs)
  if (!owner || !Number.isFinite(windowMs) || windowMs <= 0) return false

  const since = new Date(Date.now() - windowMs)
  const count = await (await collection()).countDocuments({
    discordId: owner,
    lastActiveAt: { $gte: since },
  })
  return count > 0
}

async function setProfileId(token, profileId) {
  const selectedProfileId = normalizeProfileId(profileId)
  if (selectedProfileId === null) {
    const err = new Error('invalid profileId')
    err.status = 400
    throw err
  }

  const result = await (await collection()).updateOne(
    { token, expiresAt: { $gt: new Date() } },
    { $set: { profileId: selectedProfileId, updatedAt: new Date() } },
  )
  return result.matchedCount > 0
}

async function recordLaunchCheck(token, check) {
  const result = await (await collection()).updateOne(
    { token, expiresAt: { $gt: new Date() } },
    { $set: { launchCheck: { ...check, at: Date.now() } } },
  )
  return result.matchedCount > 0
}

module.exports = {
  create,
  lookup,
  markActive,
  normalizeProfileId,
  recordLaunchCheck,
  refresh,
  setProfileId,
  wasRecentlyActive,
}
