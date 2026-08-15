const router      = require('express').Router()
const config      = require('../config')
const { lookupSession, isDiscordWhitelisted } = require('./master-api')
const { getHeartbeat }  = require('./servers')
const { loadPublicKeys } = require('../sources/publicKeys')
const { getGameLoadOrder } = require('../sources/gameLoadOrder')

router.get('/', async (req, res) => {
  const token = req.headers['x-session']

  let sessionValid = false
  let allowed      = true   // true when no session provided (offline / launcher handles it)

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

  const hb = getHeartbeat()

  res.json({
    name:                hb?.name       ?? config.serverName,
    maxPlayers:          hb?.maxPlayers ?? config.serverMaxPlayers,
    port:                config.skyrimServerPort,
    offlineMode:         config.serverOfflineMode,
    npcEnabled:          config.serverNpcEnabled,
    gamemode:            config.serverGamemode,
    discordAuthRequired: !!config.discordClientId,
    masterKey:           config.serverMasterKey  || null,
    masterUrl:           config.masterUrl         || null,
    locked:              config.serverLocked,
    // Server's esp/esm load order (basenames, in order); null if offline
    loadOrder:           await getGameLoadOrder(),
    // lockedAllowList intentionally omitted: never expose the allow-list to clients.
    // Session-aware fields: only meaningful when X-Session header is present
    sessionValid,
    allowed,
    publicKeys: loadPublicKeys(),
  })
})

module.exports = router
// Exposed for the launch-check route, which compares a client's reported plugin list to the server's current load order
module.exports.getGameLoadOrder = getGameLoadOrder
