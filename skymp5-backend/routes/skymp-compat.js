'use strict'

/**
 * SkyMP Master API compatibility routes: the endpoints the SkyMP game client
 * expects on the master server, bridged to the backend Mongo runtime stores.
 *
 * Endpoints:
 *   GET /api/users/login-discord?state=<hex>
 *   GET /api/users/login-discord/callback?code=...&state=...
 *   GET /api/users/login-discord/status?state=<hex>
 *   POST /api/users/me/play/:serverKey
 *   GET /api/users/me/characters
 *   POST /api/users/me/characters
 *   DELETE /api/users/me/characters/:profileId
 *   POST /api/users/me/characters/:profileId/cancel-delete
 *   POST /api/users/me/queue
 *   GET /api/users/me/queue
 *   DELETE /api/users/me/queue
 *   POST /api/users/me/queue/complete
 */

const router  = require('express').Router()
const https   = require('https')
const config  = require('../config')
const characters = require('../sources/characters')
const bans = require('../sources/bans')
const hwids = require('../sources/hwids')
const loginQueue = require('../sources/loginQueue')
const oauthStates = require('../sources/oauthStates')
const players = require('../sources/players')
const playSessions = require('../sources/playSessions')
const { getCapacity } = require('./servers')

const RECENT_ACTIVE_QUEUE_SKIP_MS = 3 * 60 * 1000

async function requirePlaySession(req, res) {
  const token = req.headers['authorization']
  if (!token) {
    res.status(401).json({ error: 'Missing authorization header.' })
    return null
  }

  const session = await playSessions.lookup(token)
  if (!session) {
    res.status(401).json({ error: 'Invalid or expired session token.' })
    return null
  }

  const hwidHash = hwids.fromRequest(req)
  if (hwidHash) {
    await hwids.record({
      hwidHash,
      discordId: session.discordId,
    })
  }

  const ban = await bans.findActiveForSession({
    discordId: session.discordId,
    hwidHash,
  })
  if (ban) {
    res.status(403).json({ error: 'banned', ban })
    return null
  }

  return session
}

async function requirePlayableCharacter(profileId, discordId, res) {
  const character = await characters.getByProfileId(profileId)
  if (!character || character.discordId !== String(discordId)) {
    res.status(403).json({ error: 'characterNotOwnedBySession' })
    return null
  }

  if (characters.isDeletionPending(character)) {
    res.status(409).json({ error: 'characterPendingDeletion', character })
    return null
  }

  if (character.permaDead === true) {
    res.status(409).json({ error: 'characterPermaDead' })
    return null
  }

  return character
}

// GET /api/users/login-discord

router.get('/login-discord', async (req, res) => {
  const { state } = req.query
  if (!state) return res.status(400).send('Missing state parameter.')

  if (!config.discordClientId) {
    return res.status(503).send(authPage({
      ok: false,
      title: 'Login unavailable',
      message: 'Discord login is not configured on this server yet. Tell the server admin to set DISCORD_CLIENT_ID.',
    }))
  }

  await oauthStates.setPending(state)
  console.log(`[skymp-compat] auth started (state ${String(state).slice(0, 8)}...)`)

  const params = new URLSearchParams({
    client_id:     config.discordClientId,
    redirect_uri:  config.discordRedirectUri,
    response_type: 'code',
    scope:         'identify',
    state,
  })

  res.redirect(`https://discord.com/api/oauth2/authorize?${params}`)
})

// GET /api/users/login-discord/callback

router.get('/login-discord/callback', async (req, res) => {
  const { code, state, error } = req.query

  if (error) {
    await oauthStates.remove(state)
    return res.status(400).send(authPage({
      ok: false,
      title: 'Login cancelled',
      message: `Discord reported: ${escapeHtml(String(error))}. Return to the launcher and try again.`,
    }))
  }

  if (!code || !state) {
    return res.status(400).send(authPage({
      ok: false,
      title: 'Login failed',
      message: 'The Discord response was missing its code or state. Return to the launcher and try again.',
    }))
  }

  const entry = await oauthStates.get(state)
  if (!entry || entry.status !== 'pending') {
    return res.status(400).send(authPage({
      ok: false,
      title: 'Login expired',
      message: 'This login link is no longer valid. It may have expired or already been used. Return to the launcher and try again.',
    }))
  }

  try {
    const tokenData = await discordTokenExchange({
      client_id:     config.discordClientId,
      client_secret: config.discordClientSecret,
      grant_type:    'authorization_code',
      code,
      redirect_uri:  config.discordRedirectUri,
    })

    const user = await discordGetUser(tokenData.access_token)
    const username = user.global_name || user.username
    const avatar = user.avatar
      ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64`
      : null

    const { createSession } = require('./master-api')
    const { session, profileId } = await createSession({
      id: user.id,
      username,
      avatar,
    })

    await oauthStates.setDone(state, {
      session,
      profileId,
      discordId: user.id,
      username,
      avatar,
    })
    console.log(`[skymp-compat] auth completed for ${username} (state ${String(state).slice(0, 8)}...)`)

    res.send(authPage({
      ok: true,
      title: 'Logged in',
      message: `Welcome, <strong>${escapeHtml(username)}</strong>. You can return to the launcher.`,
      autoClose: true,
    }))
  } catch (err) {
    console.error('[skymp-compat] Discord callback error:', err.message)
    await oauthStates.remove(state)
    res.status(500).send(authPage({
      ok: false,
      title: 'Login failed',
      message: 'Something went wrong while talking to Discord. Return to the launcher and try again.',
    }))
  }
})

// GET /api/users/login-discord/status

router.get('/login-discord/status', async (req, res) => {
  const { state } = req.query
  if (!state) return res.status(400).json({ error: 'Missing state.' })

  const entry = await oauthStates.get(state)
  if (!entry) return res.status(403).json({ error: 'Unknown or expired state.' })
  if (entry.status === 'pending') return res.status(401).json({ error: 'Auth not completed yet.' })

  if (!entry.deliveredAt) {
    await oauthStates.markDelivered(state)
    console.log(`[skymp-compat] auth result delivered to client for ${entry.username || entry.profileId}`)
  }

  res.json({
    token:                entry.session,
    masterApiId:          entry.profileId,
    discordUsername:      entry.username || null,
    discordDiscriminator: null,
    discordAvatar:        entry.avatar || null,
  })
})

// POST /api/users/me/play/:serverKey

router.post('/me/play/:serverKey', async (req, res) => {
  if (req.params.serverKey !== config.serverMasterKey) {
    return res.status(403).json({ error: 'Invalid server key.' })
  }

  const session = await requirePlaySession(req, res)
  if (!session) return

  const profileId = Number(req.body?.profileId)
  if (!characters.isValidProfileId(profileId)) {
    return res.status(400).json({ error: 'Missing or invalid profileId.' })
  }

  const character = await requirePlayableCharacter(profileId, session.discordId, res)
  if (!character) return

  const capacity = getCapacity()
  const queue = await loginQueue.statusForToken(session.token, { capacity })
  if (!queue) {
    return res.status(409).json({ error: 'queueEntryRequired' })
  }
  if (Number(queue.profileId) !== profileId) {
    return res.status(409).json({ error: 'queueProfileMismatch' })
  }
  if (queue.status !== 'ready') {
    if (queue.status !== 'admitting') {
      return res.status(409).json({ error: 'queueNotReady', queue })
    }
  }
  const admitted = await loginQueue.admit(session.token, { capacity })
  if (!admitted) {
    const currentQueue = await loginQueue.statusForToken(session.token, { capacity })
    return res.status(409).json({ error: 'queueNotReady', queue: currentQueue })
  }

  await playSessions.setProfileId(session.token, profileId)

  res.json({ session: session.token, profileId })
})

// GET /api/users/me/characters

router.get('/me/characters', async (req, res) => {
  const session = await requirePlaySession(req, res)
  if (!session) return
  const player = await players.getAccountByDiscordId(session.discordId)
  const maxCharacterSlots = player?.maxCharacterSlots ?? players.DEFAULT_MAX_CHARACTER_SLOTS

  res.json({
    maxSlots: maxCharacterSlots,
    maxCharacterSlots,
    hasPriorityQue: player?.hasPriorityQue === true,
    admin: player?.admin === true,
    serverTime: new Date().toISOString(),
    characters: await characters.listForDiscordId(session.discordId),
  })
})

// POST /api/users/me/characters

router.post('/me/characters', async (req, res) => {
  const session = await requirePlaySession(req, res)
  if (!session) return

  try {
    console.log(`[skymp-compat] creating character for ${session.discordId}`)
    const player = await players.getAccountByDiscordId(session.discordId)
    const maxCharacterSlots = player?.maxCharacterSlots ?? players.DEFAULT_MAX_CHARACTER_SLOTS
    const character = await characters.createForDiscordId(
      session.discordId,
      req.body || {},
      { maxCharacterSlots },
    )
    console.log(`[skymp-compat] created character profileId ${character.profileId} for ${session.discordId}`)
    res.status(201).json({
      character,
      maxSlots: maxCharacterSlots,
      maxCharacterSlots,
      hasPriorityQue: player?.hasPriorityQue === true,
      admin: player?.admin === true,
    })
  } catch (err) {
    console.error('[skymp-compat] create character failed:', err.message)
    res.status(err.status || 500).json({ error: err.message || 'failed to create character' })
  }
})

// POST /api/users/me/characters/:profileId/update

router.post('/me/characters/:profileId/update', async (req, res) => {
  const session = await requirePlaySession(req, res)
  if (!session) return

  try {
    const character = await characters.updateForDiscordId(
      session.discordId,
      req.params.profileId,
      req.body || {},
    )
    res.json({ ok: true, character })
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'failed to update character' })
  }
})

// DELETE /api/users/me/characters/:profileId

router.delete('/me/characters/:profileId', async (req, res) => {
  const session = await requirePlaySession(req, res)
  if (!session) return

  try {
    const character = await characters.scheduleDeleteForDiscordId(session.discordId, req.params.profileId)
    res.json({ ok: true, character })
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'failed to schedule character deletion' })
  }
})

router.post('/me/characters/:profileId/delete', async (req, res) => {
  const session = await requirePlaySession(req, res)
  if (!session) return

  try {
    const character = await characters.scheduleDeleteForDiscordId(session.discordId, req.params.profileId)
    res.json({ ok: true, character })
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'failed to schedule character deletion' })
  }
})

router.post('/me/characters/:profileId/cancel-delete', async (req, res) => {
  const session = await requirePlaySession(req, res)
  if (!session) return

  try {
    const character = await characters.cancelDeleteForDiscordId(session.discordId, req.params.profileId)
    res.json({ ok: true, character })
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'failed to cancel character deletion' })
  }
})

// POST /api/users/me/queue

router.post('/me/queue', async (req, res) => {
  const session = await requirePlaySession(req, res)
  if (!session) return

  const profileId = Number(req.body?.profileId)
  if (!characters.isValidProfileId(profileId)) {
    return res.status(400).json({ error: 'Missing or invalid profileId.' })
  }

  try {
    const character = await requirePlayableCharacter(profileId, session.discordId, res)
    if (!character) return

    const player = await players.getAccountByDiscordId(session.discordId)
    const capacity = getCapacity()
    const recentlyActive = await characters.wasRecentlyActive(profileId, RECENT_ACTIVE_QUEUE_SKIP_MS)
    const queue = await loginQueue.join({
      token: session.token,
      discordId: session.discordId,
      profileId,
      hasPriorityQue: player?.hasPriorityQue === true,
      skipQueueUntil: recentlyActive
        ? new Date(Date.now() + RECENT_ACTIVE_QUEUE_SKIP_MS)
        : null,
    }, { capacity })

    res.json({ queue })
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'failed to join queue' })
  }
})

// GET /api/users/me/queue

router.get('/me/queue', async (req, res) => {
  const session = await requirePlaySession(req, res)
  if (!session) return

  const queue = await loginQueue.statusForToken(session.token, { capacity: getCapacity() })
  if (!queue) return res.status(404).json({ error: 'queueEntryNotFound' })

  res.json({ queue })
})

// DELETE /api/users/me/queue

router.delete('/me/queue', async (req, res) => {
  const session = await requirePlaySession(req, res)
  if (!session) return

  await loginQueue.leave(session.token)
  res.json({ ok: true })
})

router.post('/me/queue/leave', async (req, res) => {
  const session = await requirePlaySession(req, res)
  if (!session) return

  await loginQueue.leave(session.token)
  res.json({ ok: true })
})

router.post('/me/queue/complete', async (req, res) => {
  const session = await requirePlaySession(req, res)
  if (!session) return

  await loginQueue.complete(session.token)
  res.json({ ok: true })
})

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function authPage({ ok, title, message, autoClose = false }) {
  const accent = ok ? '#c8a25f' : '#c0564f'
  const mark   = ok ? '&#10003;' : '&#10007;'
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SkyRP - ${escapeHtml(title)}</title>
<style>
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; align-items: center; justify-content: center;
    background: radial-gradient(ellipse at center, #16120d 0%, #0b0906 70%);
    color: #d8cdb8; font-family: Georgia, 'Times New Roman', serif;
    text-align: center;
  }
  .card { padding: 2.5rem 3rem; max-width: 26rem; }
  .mark {
    width: 4rem; height: 4rem; margin: 0 auto 1.25rem; border-radius: 50%;
    border: 2px solid ${accent}; color: ${accent};
    display: flex; align-items: center; justify-content: center;
    font-size: 1.8rem;
  }
  h1 {
    margin: 0 0 .75rem; font-size: 1.5rem; font-weight: normal;
    color: ${accent}; letter-spacing: .12em; text-transform: uppercase;
  }
  p { margin: 0; line-height: 1.6; font-size: 1rem; }
  .note { margin-top: 1.5rem; font-size: .85rem; color: #857a66; }
</style>
</head>
<body>
  <div class="card">
    <div class="mark">${mark}</div>
    <h1>${escapeHtml(title)}</h1>
    <p>${message}</p>
    <p class="note" id="note">${autoClose ? 'This tab will close itself...' : ''}</p>
  </div>
${autoClose ? `<script>
  window.close()
  setTimeout(function () {
    var n = document.getElementById('note')
    if (n) n.textContent = 'You can close this tab now.'
  }, 600)
</script>` : ''}
</body>
</html>`
}

function discordTokenExchange(params) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(params).toString()
    const req  = https.request(
      {
        hostname: 'discord.com',
        path:     '/api/oauth2/token',
        method:   'POST',
        headers:  {
          'Content-Type':   'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      res => {
        let data = ''
        res.on('data', c => { data += c })
        res.on('end', () => {
          const json = JSON.parse(data)
          if (json.error) reject(new Error(json.error_description || json.error))
          else resolve(json)
        })
      }
    )
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

function discordGetUser(accessToken) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      {
        hostname: 'discord.com',
        path:     '/api/users/@me',
        headers:  { Authorization: `Bearer ${accessToken}` },
      },
      res => {
        let data = ''
        res.on('data', c => { data += c })
        res.on('end', () => resolve(JSON.parse(data)))
      }
    )
    req.on('error', reject)
  })
}

module.exports = router
