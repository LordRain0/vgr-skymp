'use strict'

const crypto = require('crypto')
const config = require('../config')
const db     = require('./backendDb')

function now() {
  return new Date()
}

function hashHwid(input) {
  const raw = String(input || '').trim()
  if (!raw) return null

  // Store a backend-side salted fingerprint. This lets the client/server send
  // either a raw hardware value or its own stable hash without persisting that
  // original value in MongoDB.
  const secret = config.hwidHashSecret || config.serverMasterKey || 'skymp-hwid'
  return crypto.createHash('sha256').update(`${secret}:${raw}`).digest('hex')
}

function normalizeDiscordId(value) {
  const discordId = String(value || '').trim()
  return discordId || null
}

function fromRequest(req) {
  return String(
    req.headers['x-hwid-hash']
      || req.headers['x-hwid']
      || req.query?.hwidHash
      || req.query?.hwid
      || req.body?.hwidHash
      || req.body?.hwid
      || '',
  ).trim() || null
}

async function collection() {
  return db.collection('hwids')
}

async function record({ hwidHash, discordId }) {
  const fingerprint = hashHwid(hwidHash)
  if (!fingerprint) return null

  const owner = normalizeDiscordId(discordId)
  const timestamp = now()

  const update = {
    $setOnInsert: {
      hwidHash: fingerprint,
      firstSeenAt: timestamp,
    },
    $set: {
      lastSeenAt: timestamp,
      updatedAt: timestamp,
      ...(owner ? { lastDiscordId: owner } : {}),
    },
  }

  const addToSet = {}
  if (owner) addToSet.discordIds = owner
  if (Object.keys(addToSet).length > 0) update.$addToSet = addToSet

  await (await collection()).updateOne(
    { hwidHash: fingerprint },
    update,
    { upsert: true },
  )

  return fingerprint
}

async function getLinkedDiscordIds(hwidHash) {
  const fingerprint = hashHwid(hwidHash)
  if (!fingerprint) return []

  const record = await (await collection()).findOne({ hwidHash: fingerprint })
  return [...new Set((record?.discordIds || []).map(normalizeDiscordId).filter(Boolean))]
}

module.exports = {
  fromRequest,
  getLinkedDiscordIds,
  hashHwid,
  record,
}
