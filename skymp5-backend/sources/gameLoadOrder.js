'use strict'

const http = require('http')
const config = require('../config')

let loadOrderCache = { value: null, expiresAt: 0 }

function normalizeLoadOrder(loadOrder) {
  if (!Array.isArray(loadOrder)) return null
  const value = loadOrder
    .filter(item => typeof item === 'string')
    .map(item => item.trim())
    .filter(Boolean)
  return value.length > 0 ? value : null
}

function fetchGameJson(pathname) {
  return new Promise(resolve => {
    const req = http.get(
      { host: config.skyrimServerHost, port: config.skympUiPort, path: pathname, timeout: 3000 },
      res => {
        if (res.statusCode !== 200) { res.resume(); return resolve(null) }
        let data = ''
        res.on('data', c => { data += c })
        res.on('end', () => {
          try { resolve(JSON.parse(data)) } catch { resolve(null) }
        })
      }
    )
    req.on('error',   () => resolve(null))
    req.on('timeout', () => { req.destroy(); resolve(null) })
  })
}

async function getGameLoadOrder() {
  if (loadOrderCache.expiresAt > Date.now()) return loadOrderCache.value

  const manifest = (await fetchGameJson('/manifest.json')) || (await fetchGameJson('/data/manifest.json'))
  const liveLoadOrder = normalizeLoadOrder(manifest?.loadOrder)
  const configuredLoadOrder = normalizeLoadOrder(config.serverLoadOrder)
  const value = liveLoadOrder || configuredLoadOrder || loadOrderCache.value
  loadOrderCache = { value, expiresAt: Date.now() + 60_000 }
  return value
}

module.exports = {
  getGameLoadOrder,
  normalizeLoadOrder,
}
