const router = require('express').Router()
const fs = require('fs')

// Bump FALLBACK_LATEST_VERSION on each launcher release, or set LAUNCHER_LATEST_VERSION in env.
// LAUNCHER_DOWNLOAD_URL is the installer link (e.g. a file-server URL or GitHub Releases URL).
const FALLBACK_LATEST_VERSION = '2.1.0'
const FALLBACK_DOWNLOAD_URL   = 'https://vengefulrealms.com/VengefulRealms-Data/VGR-Launcher/VengefulRealmsLauncher.exe'
const DOWNLOAD_URL = process.env.LAUNCHER_DOWNLOAD_URL || FALLBACK_DOWNLOAD_URL

router.get('/', (_req, res) => {
  res.json({
    version:     currentVersion(),
    downloadUrl: DOWNLOAD_URL,
  })
})

// Re-read LATEST_VERSION from disk each request so a version bump is served without a backend restart.
function currentVersion() {
  if (process.env.LAUNCHER_LATEST_VERSION) return process.env.LAUNCHER_LATEST_VERSION
  try {
    const m = fs.readFileSync(__filename, 'utf8').match(/const\s+FALLBACK_LATEST_VERSION\s*=\s*['"]([^'"]+)['"]/)
    if (m) return m[1]
  } catch { /* fall back to the value loaded at startup */ }
  return FALLBACK_LATEST_VERSION
}

module.exports = router
