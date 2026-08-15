'use strict'

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })

/**
 * Merge pipeline: copies the client source into the bucket the launcher downloads and builds the zip.
 *   build/dist/client (via `npm run populate`) -> build/client-files/root/ -> build/client-files/<zip> + data/files-version.json
 * SKSE is NOT included; the user manages it via the Vortex collection.
 * Run standalone: node scripts/merge-files.js. Called by scripts/setup-client.js and routes/webhook.js.
 */

const path               = require('path')
const fs                 = require('fs')
const { execFileSync }   = require('child_process')
const archiver           = require('archiver')
const config             = require('../config')
const { copyVgrUi }      = require('./copy-vgr-ui')

const ROOT = path.join(__dirname, '..')

const CLIENT_SRC   = path.join(ROOT, 'sources', 'client')
const OUTPUT_DIR   = path.join(config.clientFilesDir, 'root')
const ZIP_PATH     = path.join(config.clientFilesDir, config.clientZipName)
const VERSION_FILE = path.join(ROOT, 'data', 'files-version.json')
const DIST_UI_DIR  = path.join(ROOT, '..', 'build', 'dist', 'client', 'Data', 'Platform', 'UI')

// Version helpers

// Short git hash for the client files version: tries the legacy sources/client checkout, then the skyrp monorepo; changes only on new commits, 'nogit' if neither is a repo
function clientGitHash() {
  for (const dir of [CLIENT_SRC, path.join(ROOT, '..')]) {
    try {
      return execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], {
        encoding: 'utf8',
        stdio:    ['ignore', 'pipe', 'ignore'],
      }).trim()
    } catch { /* try next */ }
  }
  return 'nogit'
}

// File copy

function copyDir(srcDir, destDir, skipNames = new Set()) {
  if (!fs.existsSync(srcDir)) {
    console.warn(`[merge] source not found, skipping: ${srcDir}`)
    return 0
  }
  let count = 0
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (skipNames.has(entry.name)) continue
    const src  = path.join(srcDir, entry.name)
    const dest = path.join(destDir, entry.name)
    if (entry.isDirectory()) {
      fs.mkdirSync(dest, { recursive: true })
      count += copyDir(src, dest, skipNames)
    } else {
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.copyFileSync(src, dest)
      count++
    }
  }
  return count
}

// Zip builder

function buildZip(srcDir, zipPath) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(zipPath), { recursive: true })
    const output  = fs.createWriteStream(zipPath)
    const archive = archiver('zip', { zlib: { level: 6 } })

    output.on('close', () => resolve(archive.pointer()))
    archive.on('error', reject)

    archive.pipe(output)
    archive.directory(srcDir, false)  // false = no root folder prefix in zip
    archive.finalize()
  })
}

// Main export

async function mergeSourcesIntoRoot() {
  const startMs = Date.now()

  console.log('[merge] Starting merge…')
  console.log(`[merge]   client  : ${CLIENT_SRC}`)
  console.log(`[merge]   output  : ${OUTPUT_DIR}`)

  fs.mkdirSync(OUTPUT_DIR, { recursive: true })

  const SKIP_ALWAYS = new Set(['.git', '.gitignore', '.gitattributes'])

  let clientFiles = 0
  if (fs.existsSync(CLIENT_SRC)) {
    clientFiles = copyDir(CLIENT_SRC, OUTPUT_DIR, SKIP_ALWAYS)
  } else {
    console.log(`[merge] Optional client overlay not found, skipping: ${CLIENT_SRC}`)
  }
  copyVgrUi([DIST_UI_DIR])
  const uiFiles = copyVgrUi([path.join(OUTPUT_DIR, 'Data', 'Platform', 'UI')])
  console.log(`[merge] Files merged: ${clientFiles + uiFiles} total in ${Date.now() - startMs}ms`)

  console.log('[merge] Building zip…')
  const zipStart = Date.now()
  const zipSize  = await buildZip(OUTPUT_DIR, ZIP_PATH)
  console.log(`[merge] Zip built: ${(zipSize / 1024 / 1024).toFixed(1)} MB in ${Date.now() - zipStart}ms`)

  // Set CLIENT_VERSION in .env to override the update-signal version
  const version = (process.env.CLIENT_VERSION || '').trim() || clientGitHash()
  fs.mkdirSync(path.dirname(VERSION_FILE), { recursive: true })
  fs.writeFileSync(VERSION_FILE, JSON.stringify({
    version,
    builtAt:   new Date().toISOString(),
    fileCount: clientFiles + uiFiles,
    zipSize,
  }, null, 2) + '\n')
  console.log(`[merge] Version: ${version}`)

  return { clientFiles, uiFiles, total: clientFiles + uiFiles, zipSize }
}

// CLI entry

if (require.main === module) {
  mergeSourcesIntoRoot().catch(err => {
    console.error('[merge] Fatal:', err.message)
    process.exit(1)
  })
}

module.exports = { mergeSourcesIntoRoot }
