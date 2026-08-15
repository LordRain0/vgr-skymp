'use strict'
// Dashboard session store: short-lived tokens issued after Discord OAuth.

const crypto = require('crypto')
const db     = require('./backendDb')

const TTL = 24 * 60 * 60 * 1000  // 24 h

async function collection() {
  return db.collection('dashboardSessions')
}

async function create(discordId, username, avatar, roles = [], permissions = []) {
  const token = crypto.randomBytes(32).toString('hex')
  await (await collection()).insertOne({
    token,
    discordId,
    username,
    avatar,
    roles,
    permissions,
    expiresAt: new Date(Date.now() + TTL),
    createdAt: new Date(),
  })
  return token
}

async function validate(token) {
  if (!token) return null

  const session = await (await collection()).findOne({
    token,
    expiresAt: { $gt: new Date() },
  })

  return session ? {
    discordId: session.discordId,
    username: session.username,
    avatar: session.avatar,
    roles: session.roles || [],
    permissions: session.permissions || [],
    expiresAt: session.expiresAt,
  } : null
}

async function revoke(token) {
  if (!token) return
  await (await collection()).deleteOne({ token })
}

module.exports = { create, validate, revoke }
