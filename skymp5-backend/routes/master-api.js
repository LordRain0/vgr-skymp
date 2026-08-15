'use strict'

/**
 * Master API, called by the SkyMP game server (not the client directly).
 * Mounted twice in server.js:
 *   app.use('/auth',        masterApiRoute)  -> POST /auth/session
 *   app.use('/api/servers', masterApiRoute)  -> GET/POST /api/servers/:key/...
 *
 * Endpoints:
 *   POST /auth/session
 *     Body: { discordUser: { id, username } }  Returns: { profileId, session }
 *     Called by the launcher after Discord login; the game client passes the session token to the game server.
 *   GET /api/servers/:key/sessions/:session
 *     Validates a session token. Returns: { user: { id, discordId, username } }
 *   GET /api/servers/:key/sessions/:session/balance
 *     Returns a player's coin balance: { user: { id, balance } }
 *   POST /api/servers/:key/sessions/:session/purchase  (X-Auth-Token)
 *     Spends a player's coins. Body: { balanceToSpend: number }  Returns: { balanceSpent, success }
 *   POST /api/servers/:key/profiles/:profileId/disconnect  (X-Auth-Token)
 *     Marks an accepted profile active at disconnect time for short reconnect grace.
 *   GET /api/servers/:key/profiles/:profileId/check
 *     Offline-mode profileId check, same lock/whitelist rules as session validation. Returns { allowed: true } or 403/404 { error }
 *   POST /api/servers/:key/profiles/:profileId/factions  (X-Auth-Token)
 *     In-game faction appointment. Body: { requirementId, playerName?, notes? }
 *   DELETE /api/servers/:key/profiles/:profileId/factions/:assignmentId  (X-Auth-Token)
 *     Removes one official backend faction slot.
 */

const router = require('express').Router()
const fs     = require('fs')
const path   = require('path')
const config = require('../config')
const characters = require('../sources/characters')
const factionWhitelist = require('../sources/factionWhitelist')
const serverAccess = require('../sources/serverAccess')
const profiles = require('../sources/profiles')
const players  = require('../sources/players')
const playSessions = require('../sources/playSessions')
const bans = require('../sources/bans')
const hwids = require('../sources/hwids')

// Helper: look up a session entry (exported for serverinfo route)

async function lookupSession(token) {
  return playSessions.lookup(token)
}

// Launch sanity check: the launcher reports files version + plugin list to POST /api/launch-check; the result is stored on the session so validation can refuse stale or launcher-skipping clients

const LAUNCH_VERSION_PATH = path.join(__dirname, '..', 'data', 'files-version.json')

function currentFilesVersion() {
  try { return JSON.parse(fs.readFileSync(LAUNCH_VERSION_PATH, 'utf8')).version || null }
  catch { return null }   // no package published yet: nothing to enforce
}

async function recordLaunchCheck(token, check) {
  return playSessions.recordLaunchCheck(token, check)
}

// Returns { ok: true } or { ok: false, error } for the session-validation gate.
function launchGateStatus(entry) {
  if (!config.launchCheckEnforce) return { ok: true }
  const required = currentFilesVersion()
  if (!required) return { ok: true }   // no published package: can't compare
  const lc = entry.launchCheck
  if (!lc) return { ok: false, error: 'launchCheckMissing' }
  if (lc.filesVersion !== required) return { ok: false, error: 'clientOutdated' }
  if (lc.pluginsOk === false) return { ok: false, error: 'loadOrderMismatch' }
  return { ok: true }
}

// Helper: validate server master key

function checkKey(req, res) {
  if (req.params.key !== config.serverMasterKey) {
    res.status(403).json({ error: 'Invalid master key.' })
    return false
  }
  return true
}

function checkWriteToken(req, res) {
  const authToken = req.headers['x-auth-token']
  if (!authToken || authToken !== config.masterApiAuthToken) {
    res.status(403).json({ error: 'Invalid auth token.' })
    return false
  }
  return true
}

async function getProfileDiscordId(req, res) {
  const profileId = parseInt(req.params.profileId, 10)
  if (isNaN(profileId)) {
    res.status(400).json({ error: 'Invalid profileId.' })
    return null
  }

  const discordId = await profiles.getDiscordIdByProfileId(profileId)
  if (!discordId) {
    res.status(404).json({ error: 'profileNotFound' })
    return null
  }

  return discordId
}

function getProfileFactionPayload(discordId) {
  return {
    permissions: factionWhitelist.getPlayerFactionPermissions(discordId),
    gameFactions: factionWhitelist.getPlayerGameFactions(discordId),
    factions: factionWhitelist.getPlayerAssignments(discordId),
  }
}

async function getPlayableSession(token, res) {
  const entry = await lookupSession(token)
  if (!entry) {
    res.status(404).json({ error: 'Session not found or expired.' })
    return null
  }

  const profileId = playSessions.normalizeProfileId(entry.profileId)
  if (!profileId) {
    res.status(409).json({ error: 'selectedCharacterRequired' })
    return null
  }

  const character = await characters.getByProfileId(profileId)
  if (!character || character.discordId !== String(entry.discordId)) {
    res.status(403).json({ error: 'characterSessionMismatch' })
    return null
  }

  return { ...entry, profileId, character }
}

async function enforceBanForSession(req, res, entry) {
  const hwidHash = hwids.fromRequest(req)
  if (hwidHash) {
    await hwids.record({
      hwidHash,
      discordId: entry.discordId,
    })
  }

  const ban = await bans.findActiveForSession({
    discordId: entry.discordId,
    hwidHash,
  })
  if (!ban) return true

  res.status(403).json({ error: 'banned', ban })
  return false
}

// Session creation helper (used by POST /auth/session and discord-auth callback)

async function createSession(discordUser) {
  const player = await players.upsertFromDiscordUser(discordUser)
  return playSessions.create({
    profileId: player.profileId,
    discordId: discordUser.id,
    username: discordUser.username || '',
  })
}

// POST /auth/session

router.post('/session', async (req, res) => {
  const { discordUser } = req.body || {}
  if (!discordUser || !discordUser.id)
    return res.status(400).json({ error: 'Missing discordUser.id' })

  try {
    const result = await createSession(discordUser)
    res.json(result)
  } catch (err) {
    console.error('[master-api] create session failed:', err.message)
    res.status(500).json({ error: 'failed to create session' })
  }
})

// GET /api/servers/:key/sessions/:session

router.get('/:key/sessions/:session', async (req, res) => {
  if (!checkKey(req, res)) return

  const entry = await getPlayableSession(req.params.session, res)
  if (!entry) return
  if (!await enforceBanForSession(req, res, entry)) return

  let access
  try {
    access = await serverAccess.getDiscordAccess(entry.discordId)
  } catch (err) {
    console.error('[master-api] access role check failed:', err.message)
    return res.status(503).json({ error: 'accessUnavailable' })
  }

  if (!access.allowed) {
    return res.status(403).json({ error: access.error || 'accessDenied' })
  }

  // Refuse clients whose files/load order weren't verified by the launcher right before this game start
  const gate = launchGateStatus(entry)
  if (!gate.ok) {
    console.log(`[master-api] refused session for ${entry.username || entry.profileId}: ${gate.error}`)
    return res.status(403).json({ error: gate.error })
  }

  // Sliding expiration and reconnect-grace marker
  await playSessions.markActive(entry.token)
  await characters.markActive(entry.profileId)
  const player = await players.getAccountByDiscordId(entry.discordId)

  res.json({
    user: {
      id:        entry.profileId,
      discordId: entry.discordId,
      username:  entry.username,
      maxCharacterSlots: player?.maxCharacterSlots ?? players.DEFAULT_MAX_CHARACTER_SLOTS,
      hasPriorityQue: player?.hasPriorityQue === true,
      admin: player?.admin === true,
      roles:     access.roles,
      permissions: factionWhitelist.getPlayerFactionPermissions(entry.discordId),
      gameFactions: factionWhitelist.getPlayerGameFactions(entry.discordId),
      factions: factionWhitelist.getPlayerAssignments(entry.discordId),
    },
  })
})

// GET /api/servers/:key/profiles/:profileId/check
// Used by the game server in offline mode to verify a profileId is allowed.

router.get('/:key/profiles/:profileId/check', async (req, res) => {
  if (!checkKey(req, res)) return

  const discordId = await getProfileDiscordId(req, res)
  if (!discordId) return
  const ban = await bans.findActiveForSession({ discordId, hwidHash: hwids.fromRequest(req) })
  if (ban) return res.status(403).json({ error: 'banned', ban })

  let access
  try {
    access = await serverAccess.getDiscordAccess(discordId)
  } catch (err) {
    console.error('[master-api] offline access role check failed:', err.message)
    return res.status(503).json({ error: 'accessUnavailable' })
  }

  if (!access.allowed) {
    return res.status(403).json({ error: access.error || 'accessDenied' })
  }

  res.json({
    allowed: true,
    roles: access.roles,
    ...getProfileFactionPayload(discordId),
  })
})

// GET /api/servers/:key/holds/:holdSlug/roster
// Full member list of one hold (online or not) for the in-game faction menu.

router.get('/:key/holds/:holdSlug/roster', async (req, res) => {
  if (!checkKey(req, res)) return

  try {
    // Read-only profile lookup, and discordIds stay out of the response
    const profileMap = (await profiles.load()).map
    const members = factionWhitelist.getHoldRoster(req.params.holdSlug).map(member => ({
      profileId: profileMap[member.discordId] || null,
      playerName: member.playerName,
      rank: member.rank,
      rankSlug: member.rankSlug,
      slot: member.slot,
    }))
    res.json({ hold: req.params.holdSlug, members })
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'failed to load roster' })
  }
})

// POST /api/servers/:key/profiles/:profileId/factions

router.post('/:key/profiles/:profileId/factions', async (req, res) => {
  if (!checkKey(req, res) || !checkWriteToken(req, res)) return

  const discordId = await getProfileDiscordId(req, res)
  if (!discordId) return

  try {
    const assignment = factionWhitelist.createAssignment({
      ...req.body,
      discordId,
    }, 'skymp-server')
    res.status(201).json({
      assignment,
      ...getProfileFactionPayload(discordId),
    })
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'failed to assign faction' })
  }
})

// DELETE /api/servers/:key/profiles/:profileId/factions/:assignmentId

router.delete('/:key/profiles/:profileId/factions/:assignmentId', async (req, res) => {
  if (!checkKey(req, res) || !checkWriteToken(req, res)) return

  const discordId = await getProfileDiscordId(req, res)
  if (!discordId) return

  try {
    const belongsToPlayer = factionWhitelist
      .getPlayerAssignments(discordId)
      .some(assignment => assignment.id === req.params.assignmentId)
    if (!belongsToPlayer) return res.status(404).json({ error: 'assignment not found for player' })

    factionWhitelist.deleteAssignment(req.params.assignmentId)
    res.json({
      ok: true,
      ...getProfileFactionPayload(discordId),
    })
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'failed to remove faction' })
  }
})

// GET /api/servers/:key/sessions/:session/balance

router.get('/:key/sessions/:session/balance', async (req, res) => {
  if (!checkKey(req, res)) return

  const entry = await getPlayableSession(req.params.session, res)
  if (!entry) return
  if (!await enforceBanForSession(req, res, entry)) return

  const balance = await characters.getBalance(entry.profileId)
  res.json({ user: { id: entry.profileId, balance } })
})

// POST /api/servers/:key/sessions/:session/purchase

router.post('/:key/sessions/:session/purchase', async (req, res) => {
  if (!checkKey(req, res)) return

  if (!checkWriteToken(req, res)) return

  const entry = await getPlayableSession(req.params.session, res)
  if (!entry) return
  if (!await enforceBanForSession(req, res, entry)) return

  const { balanceToSpend } = req.body || {}
  if (typeof balanceToSpend !== 'number' || balanceToSpend < 0)
    return res.status(400).json({ error: 'balanceToSpend must be a non-negative number.' })

  const spent = await characters.spendBalance(entry.profileId, balanceToSpend)
  if (!spent)
    return res.json({ balanceSpent: 0, success: false })

  res.json({ balanceSpent: balanceToSpend, success: true })
})

// POST /api/servers/:key/profiles/:profileId/disconnect

router.post('/:key/profiles/:profileId/disconnect', async (req, res) => {
  if (!checkKey(req, res) || !checkWriteToken(req, res)) return

  const touched = await characters.markActive(req.params.profileId)
  if (!touched) return res.status(404).json({ error: 'profileNotFound' })
  res.json({ ok: touched })
})

// Wraps getDiscordAccess for the serverinfo routes.
async function isDiscordWhitelisted(discordId) {
  const result = await serverAccess.getDiscordAccess(discordId)
  return result.allowed === true
}

module.exports = router
module.exports.lookupSession  = lookupSession
module.exports.createSession  = createSession
module.exports.isDiscordWhitelisted = isDiscordWhitelisted
module.exports.recordLaunchCheck    = recordLaunchCheck
module.exports.currentFilesVersion  = currentFilesVersion
