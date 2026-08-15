'use strict'

const db = require('./backendDb')

const PENDING_TTL     = 10 * 60 * 1000
const DONE_TTL        =  5 * 60 * 1000
const DELIVERED_GRACE =      60 * 1000

async function collection() {
  return db.collection('oauthStates')
}

async function get(state) {
  if (!state) return null
  return (await collection()).findOne({
    state: String(state),
    expiresAt: { $gt: new Date() },
  })
}

async function setPending(state) {
  const key = String(state)
  const existing = await get(key)
  if (existing && existing.status === 'done') return existing

  const entry = {
    state: key,
    status: 'pending',
    expiresAt: new Date(Date.now() + PENDING_TTL),
    createdAt: existing?.createdAt || new Date(),
    updatedAt: new Date(),
  }
  await (await collection()).updateOne(
    { state: key },
    { $set: entry },
    { upsert: true },
  )
  return entry
}

async function setDone(state, payload) {
  const entry = {
    state: String(state),
    status: 'done',
    expiresAt: new Date(Date.now() + DONE_TTL),
    updatedAt: new Date(),
    ...payload,
  }
  await (await collection()).updateOne(
    { state: entry.state },
    { $set: entry },
    { upsert: true },
  )
  return entry
}

async function markDelivered(state) {
  const deliveredAt = new Date()
  await (await collection()).updateOne(
    { state: String(state), deliveredAt: { $exists: false } },
    { $set: { deliveredAt, expiresAt: new Date(Date.now() + DELIVERED_GRACE) } },
  )
}

async function remove(state) {
  if (!state) return
  await (await collection()).deleteOne({ state: String(state) })
}

module.exports = {
  get,
  markDelivered,
  remove,
  setDone,
  setPending,
}
