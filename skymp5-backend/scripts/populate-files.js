/**
 * Copies the built client files into the backend's file bucket:
 *   build/dist/client/Data/ -> <clientFilesDir>/root/Data/
 *   build/dist/client/*.dll  -> <clientFilesDir>/root/*.dll
 * SKSE is not included; the launcher installs it separately.
 * Run from backend/: npm run populate (override the source with SKYMP_CLIENT_DATA=<Data/ path>).
 */

const fs   = require('fs')
const path = require('path')
const { copyVgrUi } = require('./copy-vgr-ui')

// Source: the skymp build output directory
const SKYMP_DATA = process.env.SKYMP_CLIENT_DATA
  || path.join(__dirname, '..', '..', 'build', 'dist', 'client', 'Data')
const SKYMP_ROOT = process.env.SKYMP_CLIENT_ROOT
  || path.dirname(SKYMP_DATA)

// Destination
const config    = require('../config')
const ROOT_DEST = path.join(config.clientFilesDir, 'root')
const DATA_DEST = path.join(ROOT_DEST, 'Data')

if (!fs.existsSync(SKYMP_DATA)) {
  console.error(`\nClient build output not found:\n  ${SKYMP_DATA}\n`)
  console.error('Build the client first, or set SKYMP_CLIENT_DATA to its Data/ folder.\n')
  process.exit(1)
}

// Copy the whole Data/ tree
let copied = 0
function copyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name)
    const d = path.join(dest, entry.name)
    if (entry.isDirectory()) copyTree(s, d)
    else { fs.copyFileSync(s, d); copied++ }
  }
}

console.log(`\nCopying client Data from\n  ${SKYMP_DATA}\nto\n  ${DATA_DEST}`)
fs.rmSync(DATA_DEST, { recursive: true, force: true })
copyTree(SKYMP_DATA, DATA_DEST)

// The Vengeful Realms UI is maintained in-repo and should override the
// generic SkyMP UI in both the built client tree and the downloadable bucket.
copied += copyVgrUi([
  path.join(SKYMP_DATA, 'Platform', 'UI'),
  path.join(DATA_DEST, 'Platform', 'UI'),
])

// Root-level runtime dependencies. These are loaded by MpClientPlugin.dll from
// the game root, not from Data/, so they must sit next to SkyrimSE.exe.
const ROOT_FILES = [
  'livekit.dll',
  'livekit_ffi.dll',
]
for (const rel of ROOT_FILES) {
  const src = path.join(SKYMP_ROOT, rel)
  const dest = path.join(ROOT_DEST, rel)
  if (fs.existsSync(src)) {
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(src, dest)
    copied++
  }
}

// Completeness check
const REQUIRED = [
  'Platform/UI/index.html',                                   // CEF UI entry point
  'Platform/UI/js/login.js',                                  // VGR login/character flow
  'Platform/UI/js/shell.js',                                  // VGR shared UI shell
  'Platform/UI/js/ingame/ui_manager.js',                      // VGR in-game UI manager
  'Platform/UI/css/master.css',                               // VGR shared styles
  'Platform/UI/css/login.css',                                // VGR login styles
  'Platform/UI/assets/logo.png',                              // VGR watermark
  'Platform/Plugins/skymp5-client.js',                        // client logic
  'SKSE/Plugins/SkyrimPlatform.dll',                          // JS/CEF host plugin
  'SKSE/Plugins/MpClientPlugin.dll',                          // multiplayer plugin
  '../livekit.dll',                                            // voice chat runtime dependency, game root
  '../livekit_ffi.dll',                                        // voice chat runtime dependency, game root
  'Platform/Distribution/RuntimeDependencies/libcef.dll',     // CEF runtime
  'Platform/Distribution/RuntimeDependencies/SkyrimPlatformCEF.exe.hidden',
  'Platform/Distribution/RuntimeDependencies/cacert.pem',      // CA bundle for SkyrimPlatform HTTPS
]
const missing = REQUIRED.filter(rel => !fs.existsSync(path.join(DATA_DEST, rel.replace(/\//g, path.sep))))

console.log(`\nDone. ${copied} file(s) copied.`)
if (missing.length > 0) {
  console.warn('\nWARNING - required client files are MISSING from the build output:')
  for (const m of missing) console.warn(`  - Data/${m}`)
  console.warn('The in-game client will not activate without them - rebuild the client.\n')
}
