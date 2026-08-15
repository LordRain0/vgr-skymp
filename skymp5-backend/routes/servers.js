'use strict'

const router = require('express').Router()
const config = require('../config')
const { getGameLoadOrder } = require('../sources/gameLoadOrder')
const { loadPublicKeys } = require('../sources/publicKeys')

// Last heartbeat received from the game server via POST /:key
let heartbeat = null
const HEARTBEAT_TTL_MS = 20_000

function isHeartbeatFresh() {
  return !!heartbeat?.lastSeen && (Date.now() - new Date(heartbeat.lastSeen).getTime()) < HEARTBEAT_TTL_MS
}

function getCapacity() {
  const maxPlayers = heartbeat?.maxPlayers ?? config.serverMaxPlayers
  const online = isHeartbeatFresh() && typeof heartbeat?.online === 'number'
    ? heartbeat.online
    : null
  const known = typeof online === 'number'
  const isFull = known
    && typeof maxPlayers === 'number'
    && maxPlayers > 0
    && online >= maxPlayers

  return {
    online,
    maxPlayers,
    known,
    isFull,
    hasCapacity: known && !isFull,
  }
}

router.get('/', (_req, res) => {
  res.json([
    {
      name:    heartbeat?.name    ?? config.serverName,
      address: config.skyrimServerAddress,
      port:    config.skyrimServerPort,
      online:  heartbeat?.online  ?? null,
      maxPlayers: heartbeat?.maxPlayers ?? config.serverMaxPlayers,
      lastSeen:   heartbeat?.lastSeen   ?? null,
    },
  ])
})

// Called by the SkyMP in-game client for the game server's host/port; sessionValid/allowed are extra UI hints when X-Session is sent
router.get('/:key/serverinfo', async (req, res) => {
  if (req.params.key !== config.serverMasterKey) {
    return res.status(403).json({ error: 'Invalid master key.' })
  }

  // Optional session validation for the allowed/sessionValid hints
  const { lookupSession, isDiscordWhitelisted } = require('./master-api')
  const token = req.headers['x-session']
  let sessionValid = false
  let allowed      = true

  if (token) {
    const entry = await lookupSession(token)
    if (!entry) {
      sessionValid = false
      allowed      = false
    } else {
      sessionValid = true
      if (config.serverLocked) {
        allowed = config.serverLockedAllowList.includes(entry.discordId)
      } else {
        try {
          allowed = await isDiscordWhitelisted(entry.discordId)
        } catch {
          allowed = false
        }
      }
    }
  }

  res.json({
    host:        config.skyrimServerAddress,
    port:        config.skyrimServerPort,
    name:        heartbeat?.name       ?? config.serverName,
    maxPlayers:  heartbeat?.maxPlayers ?? config.serverMaxPlayers,
    offlineMode: config.serverOfflineMode,
    masterKey:   config.serverMasterKey || null,
    masterUrl:   config.masterUrl       || null,
    locked:      config.serverLocked,
    loadOrder:   await getGameLoadOrder(),
    publicKeys:  loadPublicKeys(),
    sessionValid,
    allowed,
  })
})

// Called by the SkyMP client for the server's mod list; returns a v1 manifest so the client doesn't loop on 404s
router.get('/:key/manifest.json', async (req, res) => {
  if (req.params.key !== config.serverMasterKey) {
    return res.status(403).json({ error: 'Invalid master key.' })
  }
  const loadOrder = await getGameLoadOrder()
  res.json({ versionMajor: 1, mods: [], loadOrder: loadOrder || [] })
})

// Called by MasterClient every 5 s: POST /api/servers/:key
// Body: { name, maxPlayers, online }
router.post('/:key', (req, res) => {
  if (req.params.key !== config.serverMasterKey) {
    return res.status(403).json({ error: 'Invalid master key.' })
  }

  const { name, maxPlayers, online } = req.body || {}
  heartbeat = {
    name:       typeof name       === 'string' ? name       : config.serverName,
    maxPlayers: typeof maxPlayers === 'number' ? maxPlayers : config.serverMaxPlayers,
    online:     typeof online     === 'number' ? online     : null,
    lastSeen:   new Date().toISOString(),
  }

  res.json({ ok: true })
})

module.exports = router
module.exports.getHeartbeat = () => heartbeat
module.exports.getCapacity = getCapacity
