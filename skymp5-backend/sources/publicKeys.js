const crypto = require('crypto')
const fs     = require('fs')
const path   = require('path')
const config = require('../config')

const PUBLIC_KEYS_PATH = path.join(__dirname, '..', 'data', 'public-keys.json')

function readJsonIfExists(file) {
  if (!file) return null
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) }
  catch { return null }
}

function normalizeKeyMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const entries = Object.entries(value)
    .filter(([, key]) => typeof key === 'string' && key.trim())
  return entries.length > 0 ? Object.fromEntries(entries) : null
}

function deriveFromServerSettings() {
  const settings = readJsonIfExists(config.serverSettingsPath)
  const serverKey = settings?.serverKey
  const alias = typeof serverKey?.alias === 'string' ? serverKey.alias.trim() : ''
  const privatePem = typeof serverKey?.private === 'string' ? serverKey.private : ''
  if (!alias || !privatePem) return null

  const privateKey = crypto.createPrivateKey(privatePem)
  const publicKey = crypto.createPublicKey(privateKey)
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' })
  return { [`CPP${alias}`]: publicPem }
}

function loadPublicKeys() {
  return normalizeKeyMap(readJsonIfExists(PUBLIC_KEYS_PATH))
}

function ensurePublicKeys() {
  const existing = loadPublicKeys()
  if (existing) return existing

  let generated = null
  try {
    generated = deriveFromServerSettings()
  } catch (err) {
    console.warn(`[public-keys] could not derive public key from server settings: ${err.message}`)
    return null
  }

  if (!generated) {
    console.warn('[public-keys] no public keys configured; server JS signature verification will be skipped by clients')
    return null
  }

  fs.mkdirSync(path.dirname(PUBLIC_KEYS_PATH), { recursive: true })
  fs.writeFileSync(PUBLIC_KEYS_PATH, JSON.stringify(generated, null, 2) + '\n')
  console.log(`[public-keys] wrote ${PUBLIC_KEYS_PATH} from ${config.serverSettingsPath}`)
  return generated
}

module.exports = {
  PUBLIC_KEYS_PATH,
  ensurePublicKeys,
  loadPublicKeys,
}
