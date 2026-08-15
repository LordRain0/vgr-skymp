'use strict'

const db = require('./backendDb')

const QUEUE_TTL_MS = 30 * 1000

async function collection() {
  return db.collection('loginQueue')
}

function now() {
  return new Date()
}

function expiresAt() {
  return new Date(Date.now() + QUEUE_TTL_MS)
}

function toDateOrNull(value) {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isFinite(date.getTime()) ? date : null
}

function capacityFromOptions(options = {}) {
  const capacity = options.capacity || {}
  return {
    hasCapacity: capacity.hasCapacity !== false,
    isFull: capacity.isFull === true,
    online: typeof capacity.online === 'number' ? capacity.online : null,
    maxPlayers: typeof capacity.maxPlayers === 'number' ? capacity.maxPlayers : null,
  }
}

function queueSortValue(entry, capacity) {
  const skipUntil = toDateOrNull(entry.skipUntil)
  const skipActive = capacity.hasCapacity && skipUntil && skipUntil > now()
  if (entry.status === 'admitting') return 100
  if (skipActive) return 50
  return Number(entry.priority) || 0
}

function compareQueueEntries(a, b, capacity) {
  const rank = queueSortValue(b, capacity) - queueSortValue(a, capacity)
  if (rank !== 0) return rank

  const aAdmitted = toDateOrNull(a.admittedAt)?.getTime() || 0
  const bAdmitted = toDateOrNull(b.admittedAt)?.getTime() || 0
  if (aAdmitted !== bAdmitted) return aAdmitted - bAdmitted

  const aJoined = toDateOrNull(a.joinedAt)?.getTime() || 0
  const bJoined = toDateOrNull(b.joinedAt)?.getTime() || 0
  if (aJoined !== bJoined) return aJoined - bJoined

  return String(a.token).localeCompare(String(b.token))
}

async function join({ token, discordId, profileId, hasPriorityQue = false, skipQueueUntil = null }, options = {}) {
  const sessionToken = String(token || '').trim()
  const owner = String(discordId || '').trim()
  const selectedProfileId = Number(profileId)

  if (!sessionToken || !owner || !Number.isInteger(selectedProfileId) || selectedProfileId < 0) {
    const err = new Error('invalid queue join request')
    err.status = 400
    throw err
  }

  const timestamp = now()
  const priority = hasPriorityQue === true ? 1 : 0
  const skipUntil = toDateOrNull(skipQueueUntil)
  const col = await collection()
  const current = await col.findOne({ token: sessionToken })

  const entry = {
    token: sessionToken,
    discordId: owner,
    profileId: selectedProfileId,
    priority,
    status: 'waiting',
    joinedAt: current?.joinedAt || timestamp,
    updatedAt: timestamp,
    expiresAt: expiresAt(),
    skipUntil,
  }

  await col.updateOne(
    { token: sessionToken },
    { $set: entry },
    { upsert: true },
  )

  return statusForToken(sessionToken, options)
}

async function statusForToken(token, options = {}) {
  const sessionToken = String(token || '').trim()
  if (!sessionToken) return null

  const col = await collection()
  const entry = await col.findOne({ token: sessionToken, expiresAt: { $gt: now() } })
  if (!entry) return null

  const capacity = capacityFromOptions(options)
  const activeEntries = await col.find({ expiresAt: { $gt: now() } }).toArray()
  activeEntries.sort((a, b) => compareQueueEntries(a, b, capacity))

  const index = activeEntries.findIndex(candidate => candidate.token === sessionToken)
  if (index < 0) return null

  const position = index + 1
  const total = activeEntries.length
  const status = entry.status === 'admitting'
    ? 'admitting'
    : capacity.hasCapacity && position <= 1
      ? 'ready'
      : 'waiting'

  if (entry.status !== status) {
    await col.updateOne(
      { token: sessionToken },
      { $set: { status, updatedAt: now(), expiresAt: expiresAt() } },
    )
  } else {
    await col.updateOne(
      { token: sessionToken },
      { $set: { updatedAt: now(), expiresAt: expiresAt() } },
    )
  }

  return {
    profileId: entry.profileId,
    position,
    total,
    status,
    hasPriorityQue: entry.priority > 0,
    skipQueue: queueSortValue(entry, capacity) === 50,
    serverFull: capacity.isFull,
    online: capacity.online,
    maxPlayers: capacity.maxPlayers,
    message: capacity.isFull
      ? 'Server is full. Waiting for an open player slot.'
      : capacity.hasCapacity
        ? null
        : 'Server status is unavailable. Waiting for a fresh heartbeat.',
  }
}

async function admit(token, options = {}) {
  const sessionToken = String(token || '').trim()
  if (!sessionToken) return false

  const status = await statusForToken(sessionToken, options)
  if (!status || (status.status !== 'ready' && status.status !== 'admitting')) {
    return false
  }

  const timestamp = now()
  const result = await (await collection()).updateOne(
    { token: sessionToken, expiresAt: { $gt: now() } },
    {
      $set: {
        status: 'admitting',
        admittedAt: timestamp,
        updatedAt: timestamp,
        expiresAt: expiresAt(),
      },
    },
  )

  return result.matchedCount > 0
}

async function leave(token) {
  const sessionToken = String(token || '').trim()
  if (!sessionToken) return false

  const result = await (await collection()).deleteOne({ token: sessionToken })
  return result.deletedCount > 0
}

async function leaveIfNotAdmitting(token) {
  const sessionToken = String(token || '').trim()
  if (!sessionToken) return false

  const result = await (await collection()).deleteOne({
    token: sessionToken,
    status: { $nin: ['ready', 'admitting'] },
  })
  return result.deletedCount > 0
}

async function complete(token) {
  return leave(token)
}

module.exports = {
  admit,
  complete,
  join,
  leave,
  leaveIfNotAdmitting,
  statusForToken,
}
