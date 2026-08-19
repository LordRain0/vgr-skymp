'use strict'

/**
 * Mod Organizer 2 integration - portable install fully managed by the launcher.
 *
 *   <launcher dir>\VengefulRealms\MO2\ by default, or
 *   <chosen install folder>\MO2\ when the portable install location is set.
 *     ModOrganizer.exe          downloaded from the official MO2 release
 *     ModOrganizer.ini          portable instance config (written by us)
 *     nxmhandler.ini            nxm:// → this MO2 instance
 *     downloads\                Nexus "Mod Manager Download" archives land here
 *     mods\<Mod Name>\          installed mods (assembled from the manifest)
 *     profiles\VengefulRealms\  the single launcher-managed profile
 *
 * Mods are installed by replaying a compiled manifest (see the backend's
 * scripts/compile-manifest.js): each archive is downloaded + verified by
 * sha256, extracted once, and the manifest's per-file directives reproduce the
 * reference install's exact layout. No FOMOD parsing or merge heuristics live
 * here - the manifest already encodes every choice.
 */

const path = require('path')
const fs   = require('fs')
const fsp  = fs.promises
const os   = require('os')
const https = require('https')
const http  = require('http')
const crypto = require('crypto')
const { spawn, execFileSync, execFile } = require('child_process')
const { Transform } = require('stream')
const { pipeline } = require('stream/promises')
const REQUIRED_CC = require('./required-cc')
const REQUIRED_CC_FILES = REQUIRED_CC.fileSet

const MO2_VERSION = '2.5.2'
const MO2_URL     = `https://github.com/ModOrganizer2/modorganizer/releases/download/v${MO2_VERSION}/Mod.Organizer-${MO2_VERSION}.7z`
const ROOTBUILDER_VERSION = '5.1.1'
const ROOTBUILDER_URL = `https://github.com/Kezyma/ModOrganizer-Plugins/releases/download/rootbuilder/rootbuilder.${ROOTBUILDER_VERSION}.zip`
const PROFILE     = 'VengefulRealms'

const BASE_GAME_PLUGINS = [
  'Skyrim.esm',
  'Update.esm',
  'Dawnguard.esm',
  'HearthFires.esm',
  'Dragonborn.esm',
]
const DLC_MODLIST = ['Dawnguard', 'Dragonborn', 'HearthFires']

const FORCE_LOADED_PLUGINS = [...BASE_GAME_PLUGINS, ...REQUIRED_CC.pluginOrder]
const FORCE_LOADED_PLUGIN_KEYS = new Set(FORCE_LOADED_PLUGINS.map(name => name.toLowerCase()))

// SKSE is edition-specific: the Steam and GOG builds ship different loaders and
// runtime DLLs, so we download the one matching the player's game.
const SKSE_VERSION = 'skse64_2_02_06'
const SKSE_URLS    = {
  steam: `https://skse.silverlock.org/beta/${SKSE_VERSION}.7z`,
  gog:   `https://skse.silverlock.org/beta/${SKSE_VERSION}_gog.7z`,
}

// Logger
let _log = (...args) => console.log('[mo2]', ...args)
function setLogger(fn) { _log = (...args) => fn('[mo2]', ...args) }

// Paths

let _rootProvider = null
function setRootProvider(fn) { _rootProvider = fn }

function getRoot() {
  const custom = _rootProvider ? _rootProvider() : null
  if (custom) return custom
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  return path.join(local, 'VengefulRealms', 'MO2')
}

const getExe          = () => path.join(getRoot(), 'ModOrganizer.exe')
const getDownloadsDir = () => path.join(getRoot(), 'downloads')
const getModsDir      = () => path.join(getRoot(), 'mods')
const getPluginsDir   = () => path.join(getRoot(), 'plugins')
const getProfileDir   = () => path.join(getRoot(), 'profiles', PROFILE)
const SKSE_MOD_NAME   = 'Skyrim Script Extender (SKSE64)'
const CLIENT_MOD_NAME = 'Vengeful Realms - Client'

function getManagedSkseLoaderPath() {
  return path.join(getModsDir(), SKSE_MOD_NAME, 'Root', 'skse64_loader.exe')
}

function getClientModName() {
  return CLIENT_MOD_NAME
}

function getClientModDir() {
  return path.join(getModsDir(), CLIENT_MOD_NAME)
}

function isInstalled() {
  return fs.existsSync(getExe())
}

// Full bundled 7-Zip from 7zip-bin-full; unlike 7za, it supports RAR.
function get7z() {
  const sevenBin = require('7zip-bin-full')
  return sevenBin.path7z.replace('app.asar', 'app.asar.unpacked')
}

// Download / install MO2

const DOWNLOAD_RETRY_ATTEMPTS = 5
const DOWNLOAD_TIMEOUT_MS = 180_000

function isTransientDownloadError(err) {
  return ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'ERANGE_RESTART'].includes(err?.code) ||
    /socket hang up|read ECONNRESET|download timed out/i.test(err?.message || '')
}

function contentRangeTotal(value) {
  const match = String(value || '').match(/bytes\s+\d+-\d+\/(\d+|\*)/i)
  if (!match || match[1] === '*') return 0
  return Number(match[1]) || 0
}

function downloadFileOnce(url, dest, onProgress, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    let target
    try { target = new URL(url) }
    catch (err) { return reject(err) }

    const existingSize = fs.existsSync(dest) ? fs.statSync(dest).size : 0
    const headers = existingSize > 0 ? { Range: `bytes=${existingSize}-` } : {}
    const transport = target.protocol === 'https:' ? https : target.protocol === 'http:' ? http : null
    if (!transport) return reject(new Error(`Unsupported download URL protocol: ${target.protocol}`))

    const req = transport.get(target, { headers }, res => {
      ;(async () => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume()
          if (redirectsLeft <= 0) throw new Error('Too many redirects')
          await downloadFileOnce(new URL(res.headers.location, target).href, dest, onProgress, redirectsLeft - 1)
          return
        }

        if (existingSize > 0 && res.statusCode === 416) {
          res.resume()
          try { fs.unlinkSync(dest) } catch {}
          const err = new Error('Server rejected resume range; restarting download')
          err.code = 'ERANGE_RESTART'
          throw err
        }

        const isResume = existingSize > 0 && res.statusCode === 206
        if (res.statusCode !== 200 && res.statusCode !== 206) {
          res.resume()
          throw new Error(`HTTP ${res.statusCode} downloading ${url}`)
        }

        const contentLength = parseInt(res.headers['content-length'] || '0', 10)
        const total = isResume
          ? (contentRangeTotal(res.headers['content-range']) || existingSize + contentLength)
          : contentLength
        let received = isResume ? existingSize : 0

        if (onProgress) onProgress(received, total)

        const progress = new Transform({
          transform(chunk, _encoding, callback) {
            received += chunk.length
            if (onProgress) onProgress(received, total)
            callback(null, chunk)
          }
        })

        await pipeline(res, progress, fs.createWriteStream(dest, { flags: isResume ? 'a' : 'w' }))
      })().then(resolve, reject)
    })
    req.on('error', reject)
    req.setTimeout(DOWNLOAD_TIMEOUT_MS, () => {
      const err = new Error('Download timed out')
      err.code = 'ETIMEDOUT'
      req.destroy(err)
    })
  })
}

/** Download url to dest, following redirects and resuming transient failures. */
async function downloadFile(url, dest, onProgress, redirectsLeft = 5) {
  let lastErr
  for (let attempt = 1; attempt <= DOWNLOAD_RETRY_ATTEMPTS; attempt++) {
    try {
      await downloadFileOnce(url, dest, onProgress, redirectsLeft)
      return
    } catch (err) {
      lastErr = err
      if (attempt >= DOWNLOAD_RETRY_ATTEMPTS || !isTransientDownloadError(err)) {
        try { fs.unlinkSync(dest) } catch {}
        throw err
      }
      _log(`download interrupted (${err.message}); retrying ${attempt + 1}/${DOWNLOAD_RETRY_ATTEMPTS}`)
      await sleep(1000 * attempt)
    }
  }
  throw lastErr
}

/** Extract archives with bundled full 7-Zip. */
function cancelledError() {
  return new Error('Cancelled')
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw cancelledError()
}

const LOCK_RETRY_CODES = new Set(['EBUSY', 'ENOTEMPTY', 'EPERM', 'EACCES'])

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function retryLockedFs(label, fn, signal, attempts = 8) {
  let lastErr = null
  for (let i = 0; i < attempts; i++) {
    throwIfAborted(signal)
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (!LOCK_RETRY_CODES.has(err.code) || i === attempts - 1) break
      await sleep(150 * (i + 1))
    }
  }
  throw new Error(`${label} failed: ${lastErr?.message || lastErr}`, { cause: lastErr })
}

async function replaceDirectoryFromBuild(buildDir, destDir, signal) {
  try {
    await retryLockedFs(`remove existing ${destDir}`, () =>
      fsp.rm(lp(destDir), { recursive: true, force: true }), signal)
    await fsp.mkdir(lp(path.dirname(destDir)), { recursive: true })
    await retryLockedFs(`rename ${buildDir} to ${destDir}`, () =>
      fsp.rename(lp(buildDir), lp(destDir)), signal)
  } catch (err) {
    if (LOCK_RETRY_CODES.has(err.cause?.code || err.code)) {
      throw new Error(`${err.message}. Close Mod Organizer, Explorer windows, or antivirus scans touching the MO2 mods folder and retry.`)
    }
    throw err
  }
}

function clientZipEntryToModPath(entryName) {
  const parts = String(entryName || '').split(/[\\/]+/).filter(Boolean)
  if (parts.length === 0) return ''
  if (parts[0].toLowerCase() === 'data') return parts.slice(1).join('/')
  return ['Root', ...parts].join('/')
}

async function installClientZipAsMod(zipPath, version, signal, onProgress) {
  const extractDir = path.join(getRoot(), '.client')
  const buildDir = path.join(getRoot(), '.b', `client-${_applyCounter++}`)
  const modDir = getClientModDir()
  try { await fsp.rm(lp(extractDir), { recursive: true, force: true }) } catch {}
  try { await fsp.rm(lp(buildDir), { recursive: true, force: true }) } catch {}

  try {
    await extractArchive(zipPath, extractDir, signal)
    const files = await listFilesRelative(extractDir, signal)
    const total = files.length
    let copied = 0

    for (const { rel, full } of files) {
      throwIfAborted(signal)
      const destRel = clientZipEntryToModPath(rel)
      if (!destRel) continue
      const dest = path.join(buildDir, destRel.split('/').join(path.sep))
      await fsp.mkdir(lp(path.dirname(dest)), { recursive: true })
      await fsp.copyFile(lp(full), lp(dest))
      copied++
      if (onProgress) onProgress(destRel, copied, total)
    }

    fs.writeFileSync(lp(path.join(buildDir, 'meta.ini')), [
      '[General]', 'gameName=SkyrimSE', 'modid=0', `name=${CLIENT_MOD_NAME}`,
      'repository=', 'skyrpManaged=true', `skyrpHash=${version || ''}`, '',
    ].join('\r\n'))

    await replaceDirectoryFromBuild(buildDir, modDir, signal)
    _log(`installed ${CLIENT_MOD_NAME} (${copied} file(s))`)
    return { folder: CLIENT_MOD_NAME, files: copied }
  } catch (err) {
    try { await fsp.rm(lp(buildDir), { recursive: true, force: true }) } catch {}
    if (err.message === 'Cancelled') throw err
    throw err
  } finally {
    try { await fsp.rm(lp(extractDir), { recursive: true, force: true }) } catch {}
  }
}

async function listFilesRelative(rootDir, signal) {
  const files = []
  const stack = [rootDir]
  while (stack.length) {
    throwIfAborted(signal)
    const dir = stack.pop()
    let entries
    try { entries = await fsp.readdir(lp(dir), { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        stack.push(full)
      } else {
        files.push({ full, rel: path.relative(rootDir, full).split(path.sep).join('/') })
      }
    }
  }
  files.sort((a, b) => a.rel.localeCompare(b.rel))
  return files
}

async function extractArchive(archivePath, destDir, signal, selectedPaths) {
  fs.mkdirSync(destDir, { recursive: true })
  throwIfAborted(signal)

  const includeList = await createArchiveIncludeList(archivePath, destDir, selectedPaths, signal)
  const args = ['x', '-y', `-o${destDir}`]
  if (includeList) args.push('-scsUTF-8', `-i@${includeList}`)
  args.push(archivePath)

  return new Promise((resolve, reject) => {
    const child = spawn(get7z(), args, {
      stdio: 'ignore',
      windowsHide: true,
    })

    let aborting = false
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, 10 * 60 * 1000)
    const onAbort = () => {
      aborting = true
      child.kill()
    }

    if (signal) signal.addEventListener('abort', onAbort, { once: true })

    let settled = false
    const done = err => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
      if (includeList) { try { fs.unlinkSync(lp(includeList)) } catch {} }
      if (err) reject(err)
      else resolve()
    }

    child.on('error', done)
    child.on('exit', (code, signalName) => {
      if (aborting || signal?.aborted) return done(cancelledError())
      if (timedOut) return done(new Error(`7-Zip timed out extracting ${path.basename(archivePath)}`))
      if (code === 0) return done()
      done(new Error(`7-Zip failed extracting ${path.basename(archivePath)} (exit ${code}${signalName ? `, signal ${signalName}` : ''})`))
    })
  })
}

/**
 * Download and unpack MO2 itself. Resolves immediately if already installed.
 * onProgress(message) receives human-readable status lines.
 */
async function ensureInstalled(onProgress, signal) {
  if (isInstalled()) return
  throwIfAborted(signal)

  const root    = getRoot()
  const archive = path.join(os.tmpdir(), `mo2-${MO2_VERSION}.7z`)

  _log(`installing MO2 ${MO2_VERSION} to ${root}`)
  if (onProgress) onProgress('Downloading Mod Organizer 2…')

  await downloadFile(MO2_URL, archive, (received, total) => {
    if (onProgress && total > 0) {
      const mb = n => (n / 1024 / 1024).toFixed(1)
      onProgress(`Downloading Mod Organizer 2… ${mb(received)} / ${mb(total)} MB`)
    }
  })

  if (onProgress) onProgress('Extracting Mod Organizer 2…')
  await extractArchive(archive, root, signal)
  try { fs.unlinkSync(archive) } catch {}

  if (!isInstalled()) {
    throw new Error('MO2 extraction finished but ModOrganizer.exe was not found.')
  }
  _log('MO2 installed')
}

async function ensureMo2Plugins(onProgress, signal) {
  if (!isInstalled()) throw new Error('MO2 is not installed - install MO2 before installing plugins.')
  throwIfAborted(signal)

  await ensureRootBuilderInstalled(onProgress, signal)
}

async function ensureRootBuilderInstalled(onProgress, signal) {
  const pluginsDir = getPluginsDir()
  const marker = path.join(pluginsDir, '.vgr-rootbuilder-version')
  try {
    if (fs.readFileSync(marker, 'utf8').trim() === ROOTBUILDER_VERSION) return
  } catch { /* plugin not installed by this launcher version yet */ }

  fs.mkdirSync(pluginsDir, { recursive: true })
  const archive = path.join(os.tmpdir(), `rootbuilder-${ROOTBUILDER_VERSION}.zip`)
  const extractDir = path.join(os.tmpdir(), `rootbuilder-${ROOTBUILDER_VERSION}-${process.pid}`)
  try {
    try { await fsp.rm(lp(extractDir), { recursive: true, force: true }) } catch {}
    if (onProgress) onProgress('Downloading Root Builder plugin...')
    await downloadFile(ROOTBUILDER_URL, archive, (received, total) => {
      if (onProgress && total > 0) {
        const mb = n => (n / 1024 / 1024).toFixed(1)
        onProgress(`Downloading Root Builder plugin... ${mb(received)} / ${mb(total)} MB`)
      }
    })

    if (onProgress) onProgress('Installing Root Builder plugin...')
    await extractArchive(archive, extractDir, signal)
    const sourceDir = fs.existsSync(path.join(extractDir, 'plugins'))
      ? path.join(extractDir, 'plugins')
      : extractDir
    await fsp.cp(lp(sourceDir), lp(pluginsDir), { recursive: true, force: true })
    fs.writeFileSync(marker, ROOTBUILDER_VERSION + '\n')
    _log(`Root Builder plugin installed (${ROOTBUILDER_VERSION})`)
  } finally {
    try { fs.unlinkSync(archive) } catch {}
    try { await fsp.rm(lp(extractDir), { recursive: true, force: true }) } catch {}
  }
}

// Portable instance / profile

// Forward slashes everywhere: valid for Windows APIs and avoids INI escaping.
const fwd = p => p.replace(/\\/g, '/')

// Detect the Skyrim SE store edition
function detectEdition(gameDir) {
  try {
    const names = fs.readdirSync(gameDir)
    if (names.includes('Galaxy64.dll') || names.some(f => /^goggame-.*\.(info|dll|hashdb)$/i.test(f))) return 'GOG'
    if (names.includes('EOSSDK-Win64-Shipping.dll')) return 'Epic Games'
    if (names.some(f => /^Gaming\.Desktop|appxmanifest/i.test(f))) return 'Microsoft Store'
    if (names.includes('steam_api64.dll')) return 'Steam'
  } catch { /* unreadable */ }
  return 'Steam'
}

// Full portable-instance ini, written once when the instance is first created.
function buildInstanceIni(skyrimPath, style) {
  return [
    '[General]',
    'gameName=Skyrim Special Edition',
    `gameEdition=${detectEdition(skyrimPath)}`,
    `gamePath=@ByteArray(${fwd(skyrimPath)})`,
    `selected_profile=@ByteArray(${PROFILE})`,
    `version=${MO2_VERSION}`,
    'first_start=false',
    '',
    '[Settings]',
    'check_for_updates=false',
    'force_enable_core_files=true',
    ...(style ? [`style=${style}`] : []),
    '',
    '[customExecutables]',
    'size=1',
    '1\\title=SKSE',
    `1\\binary=${fwd(getManagedSkseLoaderPath())}`,
    `1\\workingDirectory=${fwd(skyrimPath)}`,
    '1\\arguments=',
    '1\\hide=false',
    '1\\toolbar=true',
    '1\\ownicon=true',
    '',
  ].join('\r\n')
}

// Update only the path lines in an existing ini so a moved install still
// launches, without touching gameEdition or any other MO2-written state.
function healInstancePaths(iniPath, skyrimPath) {
  const gamePath = fwd(skyrimPath)
  const ssePath  = fwd(getManagedSkseLoaderPath())
  let txt = fs.readFileSync(iniPath, 'utf8')
  // Function replacers avoid '$' in paths being treated as replacement tokens.
  txt = txt.replace(/^gamePath=.*$/m,            () => `gamePath=@ByteArray(${gamePath})`)
  txt = txt.replace(/^1\\binary=.*$/m,           () => `1\\binary=${ssePath}`)
  txt = txt.replace(/^1\\workingDirectory=.*$/m, () => `1\\workingDirectory=${gamePath}`)
  if (/^\[Settings\]/m.test(txt)) {
    if (/^force_enable_core_files=.*$/m.test(txt)) {
      txt = txt.replace(/^force_enable_core_files=.*$/m, 'force_enable_core_files=true')
    } else {
      txt = txt.replace(/^\[Settings\]\r?\n/m, match => `${match}force_enable_core_files=true\r\n`)
    }
  } else {
    txt += '\r\n[Settings]\r\nforce_enable_core_files=true\r\n'
  }
  fs.writeFileSync(iniPath, txt)
}

/**
 * Pick a dark stylesheet bundled with MO2 (preference order, then any *.qss
 * with "dark" in the name). Returns '' if none found.
 */
function pickDarkStyle() {
  const dir = path.join(getRoot(), 'stylesheets')
  const preferred = ['Paper Dark.qss', 'paper-dark.qss', 'VS15.qss', 'dark.qss', '1809.qss']
  try {
    const files = fs.readdirSync(dir)
    for (const name of preferred) {
      if (files.includes(name)) return name
    }
    const anyDark = files.find(f => /dark/i.test(f) && f.toLowerCase().endsWith('.qss'))
    if (anyDark) return anyDark
  } catch { /* stylesheets dir missing */ }
  return ''
}

/**
 * Create or refresh the portable instance config and the VengefulRealms profile.
 * Safe to call repeatedly; user data (mods, downloads) is never touched.
 *
 * @param {string}   skyrimPath
 * @param {string[]} [loadOrder]  Server esp/esm order for the profile's plugins.txt
 */
function ensureInstance(skyrimPath, loadOrder) {
  const root = getRoot()
  for (const dir of [getDownloadsDir(), getModsDir(), getProfileDir(), path.join(root, 'overwrite')]) {
    fs.mkdirSync(dir, { recursive: true })
  }

  // portable.txt is MO2's portable-instance marker. Without it MO2 ignores
  // the local ModOrganizer.ini and opens the user's registry-selected
  // (global) instance instead.
  fs.writeFileSync(path.join(root, 'portable.txt'), '')

  const iniPath = path.join(root, 'ModOrganizer.ini')
  if (fs.existsSync(iniPath)) {
    healInstancePaths(iniPath, skyrimPath)
  } else {
    fs.writeFileSync(iniPath, buildInstanceIni(skyrimPath, pickDarkStyle()))
  }

  // Profile files - only created when missing so MO2-side changes survive.
  const modlistPath = path.join(getProfileDir(), 'modlist.txt')
  if (!fs.existsSync(modlistPath)) {
    fs.writeFileSync(modlistPath, '# This file was automatically generated by Mod Organizer.\r\n')
  }

  const pluginsPath = path.join(getProfileDir(), 'plugins.txt')
  if (Array.isArray(loadOrder) && loadOrder.length > 0) {
    setPlugins(loadOrder.map(f => `*${path.basename(f)}`))
  } else if (!fs.existsSync(pluginsPath)) {
    fs.writeFileSync(pluginsPath, '# This file was automatically generated by Mod Organizer.\r\n')
  }
}

/**
 * Point the nxm:// protocol at our portable instance so Nexus
 * "Mod Manager Download" buttons feed MO2's downloads folder.
 */
function registerNxmHandler() {
  const root       = getRoot()
  const nxmHandler = path.join(root, 'nxmhandler.exe')

  fs.writeFileSync(path.join(root, 'nxmhandler.ini'), [
    '[handlers]',
    'size=1',
    '1\\games=skyrimse',
    `1\\executable=${fwd(getExe())}`,
    '1\\arguments=',
    '',
  ].join('\r\n'))

  if (process.platform !== 'win32') return
  try {
    // Pass argv arrays to reg.exe (no cmd.exe) so a baseDirPath containing shell
    // metacharacters (& ^ %) cannot inject commands. The command value keeps its
    // embedded quotes around the handler path and %1 so spaced paths still work.
    const run = args => execFileSync('reg', args, { timeout: 5000, stdio: 'ignore' })
    run(['add', 'HKCU\\Software\\Classes\\nxm', '/ve', '/d', 'URL:NXM Protocol', '/f'])
    run(['add', 'HKCU\\Software\\Classes\\nxm', '/v', 'URL Protocol', '/d', '', '/f'])
    run(['add', 'HKCU\\Software\\Classes\\nxm\\shell\\open\\command', '/ve', '/d', `"${nxmHandler}" "%1"`, '/f'])
    _log('nxm:// handler registered')
  } catch (err) {
    _log('nxm handler registration failed:', err.message)
  }
}

// Mod management

// Windows caps fs paths at MAX_PATH (260) unless prefixed with \\?\. Big mods
// (deep mesh trees, e.g. JK's) exceed that while building, so prefix every fs
// boundary - MO2 itself opts into long paths, so it succeeds where plain Node
// copies would fail.
function lp(p) {
  if (process.platform !== 'win32') return p
  const abs = path.resolve(p)
  return abs.startsWith('\\\\?\\') ? abs : '\\\\?\\' + abs
}

/** Streaming SHA-256 of a file (handles multi-GB archives without buffering). */
function sha256File(p) {
  const fd  = fs.openSync(lp(p), 'r')
  const h   = crypto.createHash('sha256')
  const buf = Buffer.alloc(1 << 20)
  try {
    let n
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n))
  } finally { fs.closeSync(fd) }
  return h.digest('hex')
}

/** True when the archive on disk matches the manifest's expected sha256. */
function verifyArchive(archivePath, sha256) {
  try { return sha256File(archivePath).toLowerCase() === String(sha256).toLowerCase() }
  catch { return false }
}

/** Find a finished download whose .meta records the given Nexus fileId. */
function findDownloadByFileId(fileId) {
  let names
  try { names = fs.readdirSync(getDownloadsDir()) } catch { return null }
  for (const name of names) {
    if (/\.(meta|unfinished)$/i.test(name)) continue
    try {
      const meta = fs.readFileSync(path.join(getDownloadsDir(), name + '.meta'), 'utf8')
      const id   = (meta.match(/^fileID\s*=\s*(\d+)/im) || [])[1]
      if (id && Number(id) === Number(fileId)) return name
    } catch { /* no meta - skip */ }
  }
  return null
}

// Delete downloaded archives the manifest no longer references, so renamed
// releases (e.g. "Mod 1.1.7z" -> "Mod 1.2.7z") don't pile up in downloads\.
// Kept: every current archive name, renamed Nexus files whose .meta fileId
// still matches, SKSE (installed outside the manifest), and non-archive files.
function pruneStaleDownloads(manifest) {
  const dir = getDownloadsDir()
  let names
  try { names = fs.readdirSync(dir) } catch { return { removed: [] } }
  const archives = Array.isArray(manifest && manifest.archives) ? manifest.archives : []
  const keepNames = new Set(archives.map(a => String(a.name || '').toLowerCase()))
  const keepFileIds = new Set(archives.map(a => a.source && a.source.fileId).filter(Boolean).map(Number))
  const removed = []
  for (const name of names) {
    if (!/\.(7z|zip|rar)$/i.test(name)) continue
    if (/^skse/i.test(name)) continue
    if (keepNames.has(name.toLowerCase())) continue
    let fileId = null
    try {
      const meta = fs.readFileSync(path.join(dir, name + '.meta'), 'utf8')
      fileId = Number((meta.match(/^fileID\s*=\s*(\d+)/im) || [])[1]) || null
    } catch { /* no meta */ }
    if (fileId && keepFileIds.has(fileId)) continue
    try {
      for (const p of [name, name + '.meta', name + '.unfinished']) {
        fs.rmSync(lp(path.join(dir, p)), { force: true })
      }
      removed.push(name)
    } catch { /* locked file - retry next install */ }
  }
  return { removed }
}

// Download any URL into the MO2 downloads folder. Returns the archive name.
async function downloadToDownloads(url, fileName, onProgress, { overwrite = false } = {}) {
  const dest = path.join(getDownloadsDir(), fileName)
  if (fs.existsSync(dest)) {
    if (!overwrite) return fileName
    try { fs.rmSync(lp(dest), { force: true }) }
    catch (err) {
      throw new Error(`Cannot replace outdated archive ${fileName}: ${err.message}. Close MO2 or any program that has it open, then retry.`)
    }
  }
  fs.mkdirSync(getDownloadsDir(), { recursive: true })
  const temp = dest + '.unfinished'
  await downloadFile(url, temp, onProgress)
  fs.renameSync(temp, dest)
  return fileName
}

// Manifest install (deterministic replay)

/**
 * Extract an archive into a per-run cache dir (.x/<archiveId>) and return its
 * path. Re-extraction is skipped if the cache already exists this run.
 */
async function extractToCache(archivePath, archiveId, signal, selectedPaths) {
  const dir = path.join(getRoot(), '.x', String(archiveId))
  _extractedFileIndexes.delete(dir)
  try { fs.rmSync(lp(dir), { recursive: true, force: true }) } catch {}
  try {
    await extractArchive(archivePath, dir, signal, selectedPaths)
    return dir
  } catch (err) {
    try { fs.rmSync(lp(dir), { recursive: true, force: true }) } catch {}
    throw err
  }
}

/** Remove a cached extraction (or the whole .x cache when no id is given). */
function clearCache(archiveId) {
  const dir = archiveId == null ? path.join(getRoot(), '.x') : path.join(getRoot(), '.x', String(archiveId))
  if (archiveId == null) _extractedFileIndexes.clear()
  else _extractedFileIndexes.delete(dir)
  try { fs.rmSync(lp(dir), { recursive: true, force: true }) } catch {}
}

/**
 * Build one mod folder from its directives, OVERWRITING any existing install.
 * Files are assembled in a short temp dir and swapped into place only on
 * success, so a failed (re)install never destroys a working folder.
 *
 *   files: [{ to, archive, from, sha256, size } | { to, inline, sha256, size }]
 *   extractedDirs: { [archiveId]: <extracted path> }
 *
 * @returns { folder } | { error }
 */
async function applyMod(modName, files, extractedDirs, modId, hash, signal, onProgress) {
  const folderName = String(modName).replace(/[<>:"/\\|?*]/g, '')
  const modDir     = path.join(getModsDir(), folderName)
  const buildDir   = path.join(getRoot(), '.b', String(_applyCounter++))
  const totalBytes  = files.reduce((sum, f) => sum + directiveExpectedSize(f), 0)
  let installedBytes = 0

  try { fs.rmSync(lp(buildDir), { recursive: true, force: true }) } catch {}
  try {
    for (let i = 0; i < files.length; i++) {
      const f = files[i]
      throwIfAborted(signal)
      const report = bytesDone => {
        if (!onProgress) return
        onProgress({
          modName: folderName,
          file: f.to,
          fileIndex: i + 1,
          fileTotal: files.length,
          installedBytes: installedBytes + bytesDone,
          totalBytes,
        })
      }
      const bytesWritten = await writeDirective(f, buildDir, extractedDirs, signal, report)
      installedBytes += bytesWritten
      report(0)
    }

    fs.writeFileSync(lp(path.join(buildDir, 'meta.ini')), [
      '[General]', 'gameName=SkyrimSE', `modid=${modId || 0}`, `name=${folderName}`,
      'repository=Nexus', 'skyrpManaged=true', `skyrpHash=${hash || ''}`, '',
    ].join('\r\n'))

    await replaceDirectoryFromBuild(buildDir, modDir, signal)
    _log(`installed ${folderName} (${files.length} file(s))`)
    return { folder: folderName }
  } catch (err) {
    try { fs.rmSync(lp(buildDir), { recursive: true, force: true }) } catch {}
    if (err.message === 'Cancelled') throw err
    return { error: err.message }   // existing modDir left intact
  }
}
let _applyCounter = 1

/** Place game-root files (SKSE, preloaders) directly into the game folder. */
async function applyRootFiles(rootFiles, extractedDirs, gameDir, signal, onProgress) {
  const files = rootFiles || []
  const totalBytes = files.reduce((sum, f) => sum + directiveExpectedSize(f), 0)
  let installedBytes = 0
  for (let i = 0; i < files.length; i++) {
    const f = files[i]
    throwIfAborted(signal)
    const report = bytesDone => {
      if (!onProgress) return
      onProgress({
        file: f.to,
        fileIndex: i + 1,
        fileTotal: files.length,
        installedBytes: installedBytes + bytesDone,
        totalBytes,
      })
    }
    const bytesWritten = await writeDirective(f, gameDir, extractedDirs, signal, report)
    installedBytes += bytesWritten
    report(0)
  }
  return files.length
}

/** Materialise a single directive (FromArchive or Inline) under destRoot, verifying sha256. */
async function writeDirective(f, destRoot, extractedDirs, signal, onProgress) {
  const dest = path.join(destRoot, f.to.split('/').join(path.sep))
  await fsp.mkdir(lp(path.dirname(dest)), { recursive: true })

  if (f.inline != null) {
    const data = Buffer.from(f.inline, 'base64')
    await fsp.writeFile(lp(dest), data)
    if (onProgress) onProgress(data.length)
    if (f.sha256 && sha256Buffer(data) !== String(f.sha256).toLowerCase()) {
      throw new Error(`hash mismatch for ${f.to}`)
    }
    return data.length
  } else {
    const dir = extractedDirs[f.archive]
    if (!dir) throw new Error(`archive ${f.archive} was not extracted`)
    const src = await resolveExtractedFile(dir, f.from, signal, f.sha256, f.size)
    if (!src) throw new Error(`"${f.from}" not found in archive ${f.archive}`)
    return await copyFileVerifying(src, dest, f.sha256 ? String(f.sha256).toLowerCase() : null, signal, onProgress)
  }
}

function directiveExpectedSize(f) {
  if (typeof f.size === 'number' && f.size >= 0) return f.size
  if (f.inline != null) return Buffer.byteLength(String(f.inline), 'base64')
  return 0
}

function sha256Buffer(data) {
  return crypto.createHash('sha256').update(data).digest('hex')
}

async function copyFileVerifying(src, dest, expectedSha, signal, onProgress) {
  const h = expectedSha ? crypto.createHash('sha256') : null
  let copied = 0
  let lastProgress = 0
  const progressStream = new Transform({
    transform(chunk, encoding, callback) {
      if (h) h.update(chunk)
      copied += chunk.length
      if (onProgress) {
        const now = Date.now()
        if (now - lastProgress >= 500) {
          lastProgress = now
          onProgress(copied)
        }
      }
      callback(null, chunk)
    },
  })

  try {
    await pipeline(
      fs.createReadStream(lp(src), { highWaterMark: 1 << 20 }),
      progressStream,
      fs.createWriteStream(lp(dest)),
      { signal })
  } catch (err) {
    try { fs.unlinkSync(lp(dest)) } catch {}
    if (signal?.aborted) throw cancelledError()
    throw err
  }

  if (onProgress) onProgress(copied)

  if (h && h.digest('hex') !== expectedSha) {
    try { fs.unlinkSync(lp(dest)) } catch {}
    throw new Error(`hash mismatch for ${path.relative(getRoot(), dest) || dest}`)
  }
  return copied
}

function archivePathKey(p) {
  return String(p || '').split(/[\\/]+/).filter(Boolean).join('/').toLowerCase()
}

async function createArchiveIncludeList(archivePath, destDir, selectedPaths, signal) {
  const selected = [...(selectedPaths || [])].map(p => String(p || '').trim()).filter(Boolean)
  if (selected.length === 0) return null

  const entries = await listArchiveEntries(archivePath, signal)
  if (entries.length === 0) return null

  const resolver = buildArchiveEntryResolver(entries)
  const include = []
  const missing = []
  for (const wantedPath of selected) {
    const key = archivePathKey(wantedPath)
    const entry = resolver.exact.get(key) || resolver.suffix.get(key)
    if (entry) include.push(entry)
    else missing.push(wantedPath)
  }

  if (missing.length > 0) {
    _log(`selective extraction disabled for ${path.basename(archivePath)}; ${missing.length} manifest path(s) did not match archive listing`)
    return null
  }

  const unique = [...new Set(include)].sort((a, b) => a.localeCompare(b))
  const includeList = path.join(os.tmpdir(), `vgr-7z-include-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`)
  await fsp.writeFile(lp(includeList), unique.join('\n') + '\n', 'utf8')
  _log(`selective extraction for ${path.basename(archivePath)}: ${unique.length}/${entries.length} archive file(s)`)
  return includeList
}

const _archiveEntryCache = new Map()

async function listArchiveEntries(archivePath, signal) {
  throwIfAborted(signal)
  let st
  try { st = await fsp.stat(lp(archivePath)) } catch { return [] }
  const cached = _archiveEntryCache.get(archivePath)
  if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) return cached.entries

  const stdout = await run7zListTechnical(archivePath, signal)
  const entries = parse7zTechnicalListing(stdout)
  _archiveEntryCache.set(archivePath, { size: st.size, mtimeMs: st.mtimeMs, entries })
  return entries
}

function run7zListTechnical(archivePath, signal) {
  return new Promise((resolve, reject) => {
    let settled = false
    const done = (err, stdout) => {
      if (settled) return
      settled = true
      if (signal) signal.removeEventListener('abort', onAbort)
      if (err) return reject(err)
      resolve(stdout)
    }

    const child = execFile(get7z(), ['l', '-slt', '-sccUTF-8', lp(archivePath)], {
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 64 << 20,
      windowsHide: true,
    }, done)
    const onAbort = () => {
      child.kill()
      done(cancelledError())
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
  })
}

function parse7zTechnicalListing(stdout) {
  const entries = []
  let current = null
  const flush = () => {
    if (current?.path && current.folder === '-') entries.push(current.path)
    current = null
  }
  for (const raw of String(stdout || '').split(/\r?\n/)) {
    const line = raw.trimEnd()
    if (!line) { flush(); continue }
    const m = line.match(/^([^=]+) = (.*)$/)
    if (!m) continue
    const key = m[1].trim()
    const value = m[2]
    if (key === 'Path') {
      if (current?.path) flush()
      current = { path: value, folder: '' }
    } else if (key === 'Folder' && current) {
      current.folder = value
    }
  }
  flush()
  return entries
}

function buildArchiveEntryResolver(entries) {
  const exact = new Map()
  const suffix = new Map()
  const ambiguous = new Set()
  for (const entry of entries) {
    const key = archivePathKey(entry)
    if (!exact.has(key)) exact.set(key, entry)

    const parts = key.split('/')
    for (let i = 1; i < parts.length; i++) {
      const suffixKey = parts.slice(i).join('/')
      if (ambiguous.has(suffixKey)) continue
      if (!suffix.has(suffixKey)) {
        suffix.set(suffixKey, entry)
      } else if (suffix.get(suffixKey) !== entry) {
        suffix.delete(suffixKey)
        ambiguous.add(suffixKey)
      }
    }
  }
  return { exact, suffix }
}

const _extractedFileIndexes = new Map()

async function pathExists(p) {
  try {
    await fsp.access(lp(p))
    return true
  } catch {
    return false
  }
}

async function getExtractedFileIndex(rootDir, signal) {
  let cached = _extractedFileIndexes.get(rootDir)
  if (cached) return cached

  const indexPromise = buildExtractedFileIndex(rootDir, signal)
  _extractedFileIndexes.set(rootDir, indexPromise)
  try {
    return await indexPromise
  } catch (err) {
    _extractedFileIndexes.delete(rootDir)
    throw err
  }
}

async function buildExtractedFileIndex(rootDir, signal) {
  const exact = new Map()
  const suffix = new Map()
  const bySize = new Map()
  const ambiguous = new Set()
  const stack = [rootDir]

  while (stack.length) {
    throwIfAborted(signal)
    const dir = stack.pop()
    let entries
    try { entries = await fsp.readdir(lp(dir), { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        stack.push(full)
        continue
      }

      const rel = archivePathKey(path.relative(rootDir, full))
      if (!exact.has(rel)) exact.set(rel, full)

      let st
      try { st = await fsp.stat(lp(full)) } catch { st = null }
      if (st?.isFile()) {
        const sameSize = bySize.get(st.size) || []
        sameSize.push(full)
        bySize.set(st.size, sameSize)
      }

      const parts = rel.split('/')
      for (let i = 1; i < parts.length; i++) {
        const key = parts.slice(i).join('/')
        if (ambiguous.has(key)) continue
        if (!suffix.has(key)) {
          suffix.set(key, full)
        } else if (suffix.get(key) !== full) {
          suffix.delete(key)
          ambiguous.add(key)
        }
      }
    }
  }

  return { exact, suffix, bySize }
}

function lookupExtractedIndex(index, wanted) {
  return index.exact.get(wanted) || index.suffix.get(wanted) || null
}

async function findExtractedFileByContent(index, expectedSha, expectedSize, signal) {
  if (!expectedSha || typeof expectedSize !== 'number' || expectedSize < 0) return null
  const candidates = index.bySize?.get(expectedSize) || []
  const wantedSha = String(expectedSha).toLowerCase()
  for (const candidate of candidates) {
    throwIfAborted(signal)
    try {
      if (sha256File(candidate).toLowerCase() === wantedSha) return candidate
    } catch { /* try next candidate */ }
  }
  return null
}

async function resolveExtractedFile(rootDir, archivePath, signal, expectedSha, expectedSize) {
  const wanted = archivePathKey(archivePath)
  const cached = _extractedFileIndexes.get(rootDir)
  if (cached) {
    const index = await cached
    return lookupExtractedIndex(index, wanted) ||
      await findExtractedFileByContent(index, expectedSha, expectedSize, signal)
  }

  const direct = path.join(rootDir, archivePath.split('/').join(path.sep))
  if (await pathExists(direct)) return direct

  const index = await getExtractedFileIndex(rootDir, signal)
  return lookupExtractedIndex(index, wanted) ||
    await findExtractedFileByContent(index, expectedSha, expectedSize, signal)
}

/**
 * Write the profile's modlist.txt from the manifest's order so MO2's
 * conflict-resolution priority matches the reference install. MO2 renders the
 * first managed lines with the highest left-pane priority, so launcher-owned
 * override mods are inserted before the manifest order by the caller. The
 * order includes separators (names ending in "_separator"), whose empty
 * folders are recreated here. Any user-added mods already in modlist.txt are
 * preserved below the managed set, so re-installing never wipes a player's own
 * texture mods.
 */
function setModlistOrder(order) {
  fs.mkdirSync(getProfileDir(), { recursive: true })
  const managed = new Set(order)

  // Recreate separators (empty folders MO2 recognises by the _separator suffix).
  for (const name of order) {
    if (!name.endsWith('_separator')) continue
    const dir = path.join(getModsDir(), name)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'meta.ini'),
        ['[General]', 'gameName=SkyrimSE', 'modid=0', `name=${name}`, 'skyrpManaged=true', ''].join('\r\n'))
    }
  }

  // Reconcile the previous modlist against the new manifest:
  //  - genuine user-added mods (not launcher-managed) are kept below ours;
  //  - launcher-managed mods that dropped out of the manifest are stale - their
  //    folder is deleted and their line removed, so changes apply without a
  //    full reinstall.
  const modlistPath = path.join(getProfileDir(), 'modlist.txt')
  let userLines = []
  try {
    const leftover = fs.readFileSync(modlistPath, 'utf8').split(/\r?\n/)
      .filter(l => /^[+-]/.test(l) && !managed.has(l.slice(1).trim()))
    for (const line of leftover) {
      const name = line.slice(1).trim()
      if (isManaged(name)) {
        try { fs.rmSync(lp(path.join(getModsDir(), name)), { recursive: true, force: true }) } catch {}
        _log(`removed stale managed mod (no longer in manifest): ${name}`)
      } else {
        userLines.push(line)
      }
    }
  } catch { /* first install */ }

  const lines = [
    '# This file was automatically generated by Mod Organizer.',
    ...order.map(n => `+${n}`),
    ...userLines,
    ...REQUIRED_CC.modlistOrder.map(n => `*Creation Club: ${n}`),
    ...DLC_MODLIST.map(n => `*DLC: ${n}`),
  ]
  fs.writeFileSync(modlistPath, lines.join('\r\n') + '\r\n')
}

function ensureHighPriorityMods(modNames) {
  const requested = [...new Set((modNames || []).map(name => String(name || '').trim()).filter(Boolean))]
  const missing = requested.filter(name => !fs.existsSync(path.join(getModsDir(), name)))
  const present = requested.filter(name => !missing.includes(name))
  if (present.length === 0) return { changed: false, missing }

  const modlistPath = path.join(getProfileDir(), 'modlist.txt')
  let lines
  try {
    lines = fs.readFileSync(modlistPath, 'utf8').split(/\r?\n/)
  } catch {
    lines = ['# This file was automatically generated by Mod Organizer.']
  }

  const wantedKeys = new Set(present.map(name => name.toLowerCase()))
  const withoutWanted = lines.filter(line => {
    if (!/^[+-]/.test(line)) return true
    return !wantedKeys.has(line.slice(1).trim().toLowerCase())
  })

  let insertAt = withoutWanted.findIndex(line => /^[+\-*]/.test(line))
  if (insertAt < 0) insertAt = withoutWanted.length

  const next = [
    ...withoutWanted.slice(0, insertAt),
    ...present.map(name => `+${name}`),
    ...withoutWanted.slice(insertAt),
  ]
  const changed = next.join('\n') !== lines.join('\n')
  if (changed) {
    fs.writeFileSync(modlistPath, next.filter((line, i) => line !== '' || i < next.length - 1).join('\r\n') + '\r\n')
    _log(`moved high-priority mod(s) to top of modlist.txt: ${present.join(', ')}`)
  }
  return { changed, missing }
}

const PROFILE_FILE_HEADER = '# This file was automatically generated by Mod Organizer.'

function pluginName(line) {
  return path.basename(String(line || '').trim().replace(/^\*/, ''))
}

function enabledPluginLine(nameOrLine) {
  const name = pluginName(nameOrLine)
  return name ? `*${name}` : ''
}

function normalizePluginLines(pluginLines) {
  const seen = new Set()
  const lines = []
  for (const raw of pluginLines || []) {
    const name = pluginName(raw)
    if (!name || name.startsWith('#')) continue
    const key = name.toLowerCase()
    if (FORCE_LOADED_PLUGIN_KEYS.has(key)) continue
    if (seen.has(key)) continue
    seen.add(key)
    lines.push(`*${name}`)
  }

  const ussepIndex = lines.findIndex(line => pluginName(line).toLowerCase() === 'unofficial skyrim special edition patch.esp')
  if (ussepIndex > 0) {
    const [ussep] = lines.splice(ussepIndex, 1)
    lines.unshift(ussep)
  }
  return lines
}

function writeProfileList(fileName, lines) {
  fs.writeFileSync(path.join(getProfileDir(), fileName),
    [PROFILE_FILE_HEADER, ...lines].join('\r\n') + '\r\n')
}

/** Write plugins.txt and loadorder.txt from the manifest's captured esp/esm order. */
function setPlugins(pluginLines) {
  if (!Array.isArray(pluginLines) || pluginLines.length === 0) return
  fs.mkdirSync(getProfileDir(), { recursive: true })
  const requiredCcPlugins = REQUIRED_CC.pluginOrder
    .map(enabledPluginLine)
    .filter(Boolean)
  const plugins = normalizePluginLines(pluginLines)
  writeProfileList('plugins.txt', [
    ...requiredCcPlugins,
    ...plugins,
  ])
  writeProfileList('loadorder.txt', [
    ...FORCE_LOADED_PLUGINS,
    ...plugins.map(pluginName),
  ])
}

// SKSE (edition-aware)

/** Pick the SKSE download matching the game's store edition (GOG vs Steam). */
function skseSourceFor(gameDir) {
  const edition = detectEdition(gameDir)
  const gog     = edition === 'GOG'
  return {
    edition,
    url:      gog ? SKSE_URLS.gog : SKSE_URLS.steam,
    fileName: `${SKSE_VERSION}${gog ? '_gog' : ''}.7z`,
  }
}

/**
 * Install SKSE from its archive into a managed MO2 mod. The loader and runtime
 * DLLs live under Root/ so MO2 can launch the virtualized executable directly.
 * Edition selection happens in skseSourceFor.
 *
 * @returns {{ folder: string|null }}  the scripts-mod folder, if one was made
 */
async function installSkse(archivePath, gameDir, signal) {
  const tmp = path.join(getRoot(), '.skse')
  try { fs.rmSync(lp(tmp), { recursive: true, force: true }) } catch {}
  await extractArchive(archivePath, tmp, signal)
  try {
    // Descend a single wrapper folder (skse64_2_02_06/…) to the real root.
    let rootDir = tmp
    for (let i = 0; i < 3; i++) {
      const entries = fs.readdirSync(rootDir, { withFileTypes: true })
      if (entries.some(e => !e.isDirectory() && /^skse64_loader\.exe$/i.test(e.name))) break
      const dirs = entries.filter(e => e.isDirectory())
      if (dirs.length === 1 && entries.length === 1) { rootDir = path.join(rootDir, dirs[0].name); continue }
      break
    }

    const folder = SKSE_MOD_NAME
    const modDir = path.join(getModsDir(), folder)
    const rootOut = path.join(modDir, 'Root')
    try { fs.rmSync(lp(modDir), { recursive: true, force: true }) } catch {}
    fs.mkdirSync(lp(rootOut), { recursive: true })

    let copied = 0
    for (const e of fs.readdirSync(rootDir, { withFileTypes: true })) {
      if (!e.isDirectory() && /\.(exe|dll)$/i.test(e.name)) {
        fs.copyFileSync(path.join(rootDir, e.name), path.join(rootOut, e.name)); copied++
      }
    }
    if (copied === 0) throw new Error('no skse64 exe/dll found in the SKSE archive')

    const dataDir = fs.readdirSync(rootDir, { withFileTypes: true })
      .find(e => e.isDirectory() && e.name.toLowerCase() === 'data')
    if (dataDir) {
      const src = path.join(rootDir, dataDir.name)
      for (const entry of fs.readdirSync(src)) fs.renameSync(path.join(src, entry), path.join(modDir, entry))
    }
    fs.writeFileSync(path.join(modDir, 'meta.ini'),
      ['[General]', 'gameName=SkyrimSE', 'modid=0', `name=${folder}`, 'repository=', 'skyrpManaged=true', ''].join('\r\n'))
    _log(`SKSE installed (${copied} root file(s))`)
    return { folder }
  } finally {
    try { fs.rmSync(lp(tmp), { recursive: true, force: true }) } catch {}
  }
}

// Launch-time lockdown (anti-desync / anti-cheat)

const PLUGIN_RE = /\.(esp|esm|esl)$/i

/** True if modName's meta.ini marks it as launcher-installed (managed). */
function isManaged(modName) {
  try {
    return /^skyrpManaged\s*=\s*true/im.test(fs.readFileSync(path.join(getModsDir(), modName, 'meta.ini'), 'utf8'))
  } catch { return false }
}

/**
 * The content hash recorded in a mod's meta.ini at install time, or '' if the
 * mod folder is absent / has no recorded hash. Lets the installer skip a mod
 * that's already on disk in the exact version the manifest expects (repair,
 * not reinstall) without trusting external state.
 */
function readModHash(modName) {
  const folder = String(modName).replace(/[<>:"/\\|?*]/g, '')
  try {
    const meta = fs.readFileSync(path.join(getModsDir(), folder, 'meta.ini'), 'utf8')
    return (meta.match(/^skyrpHash\s*=\s*(.*)$/im) || [])[1]?.trim() || ''
  } catch { return '' }
}

/** Does a mod folder ship a plugin (esp/esm/esl) or an SKSE plugin DLL? */
function modHasRestrictedContent(modDir) {
  const stack = [modDir]
  while (stack.length) {
    const dir = stack.pop()
    let entries
    try { entries = fs.readdirSync(lp(dir), { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (e.isDirectory()) { stack.push(path.join(dir, e.name)); continue }
      if (PLUGIN_RE.test(e.name)) return true
      if (/\.dll$/i.test(e.name) && /[\\/]skse[\\/]plugins$/i.test(dir)) return true
    }
  }
  return false
}

/**
 * Disable any user-added mod that ships a plugin or an SKSE plugin DLL, so only
 * the server's modpack content can load (prevents desync and SKSE-plugin
 * cheats). Launcher-managed mods and separators are always kept; texture/mesh-
 * only user mods stay enabled. Returns the names that were disabled.
 */
function enforceModRules() {
  const modlistPath = path.join(getProfileDir(), 'modlist.txt')
  let lines
  try { lines = fs.readFileSync(modlistPath, 'utf8').split(/\r?\n/) } catch { return [] }

  const disabled = []
  const out = lines.map(line => {
    if (line[0] !== '+') return line               // comment, blank, or already disabled
    const name = line.slice(1).trim()
    if (!name || name.endsWith('_separator') || isManaged(name)) return line
    if (modHasRestrictedContent(path.join(getModsDir(), name))) {
      disabled.push(name)
      return `-${name}`
    }
    return line
  })

  if (disabled.length > 0) {
    fs.writeFileSync(modlistPath, out.join('\r\n'))
    _log(`disabled ${disabled.length} unauthorised mod(s): ${disabled.join(', ')}`)
  }
  return disabled
}

// Browser-partial and sidecar files that are never a finished archive.
const PARTIAL_RE = /\.(meta|unfinished|part|tmp|crdownload|download)$/i
// Caches so repeated scans (the wait loop, locate) don't re-hash or re-list unchanged files.
const _archiveHashCache = new Map()   // full -> { size, mtimeMs, hash }
const _archiveListCache = new Map()   // full -> { size, mtimeMs, listing }

/** Async streaming SHA-256 that yields to the event loop, so the UI stays responsive mid-scan. */
function sha256FileAsync(p, onProgress, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Cancelled'))
    const h = crypto.createHash('sha256')
    const s = fs.createReadStream(lp(p), { highWaterMark: 1 << 20 })
    // destroy(err) emits 'error' with that error, so an abort rejects within one chunk.
    const onAbort = () => s.destroy(new Error('Cancelled'))
    signal?.addEventListener('abort', onAbort, { once: true })
    let read = 0
    let lastProgress = 0
    s.on('data', chunk => {
      h.update(chunk)
      if (!onProgress) return
      read += chunk.length
      const now = Date.now()
      if (now - lastProgress >= 500) {
        lastProgress = now
        onProgress(read)
      }
    })
    s.on('end', () => {
      signal?.removeEventListener('abort', onAbort)
      if (onProgress) onProgress(read)
      resolve(h.digest('hex'))
    })
    s.on('error', err => {
      signal?.removeEventListener('abort', onAbort)
      reject(err)
    })
  })
}

async function verifyArchiveAsync(archivePath, sha256, onProgress) {
  try { return (await sha256FileAsync(archivePath, onProgress)).toLowerCase() === String(sha256).toLowerCase() }
  catch { return false }
}

/**
 * Verify an installed mod folder against its manifest file list.
 * Detects added, removed, and modified files:
 *  - files not in the manifest are DELETED here (returned as extrasRemoved);
 *  - missing, size-changed, or (with `deep`) content-mismatched files set
 *    `mismatched`, and the caller rebuilds the whole mod from the verified
 *    archives (the normal reinstall path).
 * Default mode is a stat walk (readdir + size compare) so a healthy modpack
 * verifies in seconds on every Play; `deep: true` additionally hashes file
 * contents (same-size tampering) and is meant for explicit Mod Pack installs
 * and failed-state self-heals, not the routine Play path.
 * meta.ini (MO2's own bookkeeping, holds our skyrpHash) is exempt. MO2's
 * overwrite folder lives outside mods\ and is never touched by this walk -
 * it legitimately differs per user (shader caches etc).
 */
async function verifyModContents(modDir, files, { signal, onProgress, deep = false } = {}) {
  const expected = new Map()
  for (const f of files || []) {
    if (f && f.to) expected.set(String(f.to).replace(/\\/g, '/').toLowerCase(), f)
  }
  // A manifest entry with no expected files is malformed (compile-manifest
  // never emits one) - "no expectations" must never read as "all extras".
  if (expected.size === 0) return { mismatched: false, extrasRemoved: 0 }

  const extras = []
  const seen = new Set()
  let mismatched = false
  let checked = 0

  const walkDir = dir => {
    let entries = []
    try { entries = fs.readdirSync(lp(dir), { withFileTypes: true }) } catch { return [] }
    const out = []
    for (const e of entries) {
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) out.push(...walkDir(abs))
      else if (e.isFile()) out.push(abs)
    }
    return out
  }

  const checkFile = async (abs, exp) => {
    const st = fs.statSync(lp(abs))
    if (Number.isFinite(exp.size)) {
      if (st.size !== exp.size) return false
      if (!deep) return true                     // stat mode: matching size passes
    }
    if (!exp.sha256) return true
    checked++
    if (onProgress && checked % 20 === 0) onProgress(checked)
    const hash = await sha256FileAsync(abs, null, signal)
    return hash.toLowerCase() === String(exp.sha256).toLowerCase()
  }

  for (const abs of walkDir(modDir)) {
    if (signal?.aborted) throw new Error('Cancelled')
    const rel = path.relative(modDir, abs).split(path.sep).join('/')
    const relLc = rel.toLowerCase()
    if (relLc === 'meta.ini') continue
    const exp = expected.get(relLc)
    if (!exp) { extras.push(abs); continue }
    seen.add(relLc)
    if (mismatched) continue  // already rebuilding; keep walking only for extras
    try {
      let ok = false
      try {
        ok = await checkFile(abs, exp)
      } catch (err) {
        if (signal?.aborted || err.message === 'Cancelled') throw err
        // Transient AV locks can fail a healthy multi-GB file - retry once.
        await new Promise(r => setTimeout(r, 250))
        ok = await checkFile(abs, exp)
      }
      if (!ok) mismatched = true
    } catch (err) {
      if (signal?.aborted || err.message === 'Cancelled') throw new Error('Cancelled')
      mismatched = true
    }
  }

  // Removed files: anything the manifest expects that the walk never saw.
  if (!mismatched) {
    for (const key of expected.keys()) {
      if (!seen.has(key)) { mismatched = true; break }
    }
  }

  for (const p of extras) {
    try { fs.rmSync(lp(p), { force: true }) } catch { /* best effort */ }
  }

  return { mismatched, extrasRemoved: extras.length }
}

const mb = n => (n / 1024 / 1024).toFixed(1)

function archiveVerifyMessage(name, received, total) {
  if (total > 0) return `Verifying ${name}... ${mb(received)} / ${mb(total)} MB`
  return `Verifying ${name}... ${mb(received)} MB`
}

// Hash a file through the cache; a changed size/mtime (e.g. a finishing copy) re-hashes.
async function hashCached(full, st, onProgress) {
  const c = _archiveHashCache.get(full)
  if (c && c.size === st.size && c.mtimeMs === st.mtimeMs) return c.hash
  const hash = (await sha256FileAsync(full, onProgress)).toLowerCase()
  _archiveHashCache.set(full, { size: st.size, mtimeMs: st.mtimeMs, hash })
  return hash
}

/** Finished (non-partial) archive files in the downloads folder, one stat pass. */
function listDownloadArchives() {
  const out = []
  let names
  try { names = fs.readdirSync(getDownloadsDir()) } catch { return out }
  for (const file of names) {
    if (PARTIAL_RE.test(file)) continue
    const full = path.join(getDownloadsDir(), file)
    let st
    try { st = fs.statSync(lp(full)) } catch { continue }
    if (st.isFile()) out.push({ file, full, st })
  }
  const present = new Set(out.map(a => a.full))
  for (const cache of [_archiveHashCache, _archiveListCache]) {
    for (const key of cache.keys()) if (!present.has(key)) cache.delete(key)
  }
  return out
}

/**
 * Path of a finished archive in the downloads folder whose sha256 == hash, or
 * null. Matches by content so manually moved ("Slow Download") files are found
 * regardless of filename; the size pre-filter avoids hashing partials/unrelated files.
 */
async function findArchiveByHash(hash, size, onProgress) {
  if (!hash) return null
  const want = String(hash).toLowerCase()
  for (const a of listDownloadArchives()) {
    if (typeof size === 'number' && size > 0 && a.st.size !== size) continue
    try {
      const progress = onProgress ? received => onProgress(a.file, received, a.st.size) : null
      if (await hashCached(a.full, a.st, progress) === want) return a.full
    } catch { /* mid-copy or locked; caller retries */ }
  }
  return null
}

/**
 * 7-Zip listing of an archive, or null when unreadable (locked, truncated, or
 * not an archive). Successful listings are cached per size/mtime so an
 * unchanged file isn't re-listed on every scan.
 */
function listArchiveContents(archivePath, st) {
  const c = _archiveListCache.get(archivePath)
  if (c && c.size === st.size && c.mtimeMs === st.mtimeMs) return Promise.resolve(c.listing)
  return new Promise(resolve => {
    execFile(get7z(), ['l', '-sccUTF-8', lp(archivePath)],
      { encoding: 'utf8', timeout: 60_000, maxBuffer: 64 << 20, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null)
        _archiveListCache.set(archivePath, { size: st.size, mtimeMs: st.mtimeMs, listing: stdout })
        resolve(stdout)
      })
  })
}

/**
 * Poll until every wanted archive is present in the downloads folder.
 * `hash` items match by content, whatever the filename; their `namePattern`
 * only flags a look-alike file that fails verification in the status message.
 * `namePattern`-only items match by filename (pre-existing files included) and
 * must yield a readable 7-Zip listing matching every `expect` regex, so mid-copy
 * files or the wrong archive are never claimed. Items with neither never
 * match: guessing an unidentified file risks extracting it into the game root.
 * The deadline slides while the user is actively staging files (a file appears
 * or grows, or an item resolves).
 * Resolves to an array of local paths parallel to `wanted`.
 *
 *   wanted: [{ name, hash?, size?, namePattern?, expect? }]
 */
function waitForDownloads(wanted, onProgress, signal, intervalMs = 1000, timeoutMs = 900_000) {
  let deadline   = Date.now() + timeoutMs
  // The sliding deadline keeps an actively-staging user alive, but any churn
  // in the downloads folder (a crawling browser download, antivirus rewrites)
  // also slides it - so a wait whose wanted file can never match used to hang
  // forever, wedging the whole install. Hard cap: three timeout windows.
  const hardDeadline = Date.now() + timeoutMs * 3
  const found    = new Array(wanted.length).fill(null)
  const prevSize = new Map()    // full -> size at the previous scan; a changing size = mid-copy
  let mismatched = []           // settled files that look like a wanted mod but fail verification
  let progressed = false        // a file appeared/grew or an item resolved since the last tick

  // Per-candidate rejection log (dev log only). One line per item+file+reason,
  // re-emitted only when the reason changes, so a stuck wait explains itself
  // instead of ignoring files silently.
  const lastReason = new Map()  // `${i}:${full}` -> reason
  const why = (i, a, reason) => {
    const key = `${i}:${a.full}`
    if (lastReason.get(key) === reason) return
    lastReason.set(key, reason)
    _log(`[wait] "${wanted[i].name}" vs "${a.file}": ${reason}`)
  }

  const scan = async () => {
    const archives = listDownloadArchives()
    const settled  = a => prevSize.get(a.full) === a.st.size
    const consumed = new Set(found.filter(Boolean))
    const suspect  = []
    for (let i = 0; i < wanted.length; i++) {
      if (found[i]) continue
      const w = wanted[i]
      for (const a of archives) {
        if (w.hash) {
          if (!settled(a)) { why(i, a, 'size still changing - copy in progress'); continue }
          const nameHit = w.namePattern && w.namePattern.test(a.file)
          if (typeof w.size === 'number' && w.size > 0 && a.st.size !== w.size) {
            why(i, a, `size mismatch (want ${w.size}, file is ${a.st.size})${nameHit ? ' - name matches, so likely a different version' : ''}`)
            if (nameHit) suspect.push(a)
            continue
          }
          try {
            const progress = onProgress
              ? received => onProgress(
                  found.filter(Boolean).length,
                  wanted.length,
                  archiveVerifyMessage(a.file, received, a.st.size))
              : null
            if (await hashCached(a.full, a.st, progress) !== String(w.hash).toLowerCase()) {
              why(i, a, `sha256 mismatch${nameHit ? ' - name matches, so likely a different version' : ''}`)
              if (nameHit) suspect.push(a)
              continue
            }
          } catch { why(i, a, 'unreadable right now (locked?)'); continue }   // retry next tick
        } else if (w.namePattern) {
          if (consumed.has(a.full)) continue
          if (!w.namePattern.test(a.file)) { why(i, a, `filename does not match ${w.namePattern}`); continue }
          const listing = await listArchiveContents(a.full, a.st)   // null while locked or incomplete
          if (listing == null) { why(i, a, '7-Zip could not list the archive (locked, incomplete, or not an archive)'); continue }
          const missing = [].concat(w.expect || []).filter(re => !re.test(listing))
          if (missing.length > 0) {   // right mod, wrong file (e.g. Part 1 vs 2)
            why(i, a, `archive lacks expected content: ${missing.map(re => re.source).join(', ')}`)
            if (settled(a)) suspect.push(a)
            continue
          }
        } else {
          continue
        }
        _log(`[wait] "${w.name}" matched by "${a.file}"`)
        found[i] = a.full
        consumed.add(a.full)
        progressed = true
        break
      }
    }
    mismatched = [...new Set(suspect.filter(a => !consumed.has(a.full)).map(a => a.file))]
    for (const a of archives) {
      if (prevSize.get(a.full) !== a.st.size) progressed = true // new file, or a copy still landing
      prevSize.set(a.full, a.st.size)
    }
  }

  return new Promise((resolve, reject) => {
    async function tick() {
      if (signal?.aborted) return reject(new Error('Cancelled'))
      progressed = false
      try { await scan() } catch { /* transient fs error; retry next tick */ }
      if (progressed) deadline = Date.now() + timeoutMs        // the user is actively staging files
      const remaining = wanted.filter((_, i) => !found[i]).map(w => w.name || 'download')
      const remainingText = remaining.map((name, i) =>
        `${name}${i < remaining.length - 1 ? ',' : ''}`).join('\n')
      const note = mismatched.length
        ? ` (${mismatched.map(f => `${f} is not the exact file the server expects - download it through its link on the downloads page, which pins the right version; if that version is gone from Nexus the server admin must update the modlist`).join('; ')})`
        : ''
      if (onProgress) {
        onProgress(wanted.length - remaining.length, wanted.length,
          remaining.length ? `Waiting for downloads:\n${remainingText}${note}` : 'All downloads received')
      }
      if (remaining.length === 0) return resolve(found)
      if (Date.now() > deadline || Date.now() > hardDeadline) {
        return reject(new Error(`Timed out waiting to download: ${remaining.join(', ')}${note}`))
      }
      setTimeout(tick, intervalMs)
    }
    setTimeout(tick, intervalMs)
  })
}

// Creation Club quarantine (non-portable installs)

// Real CC files follow the ccXXXsseNNN- naming (e.g. ccBGSSSE001-Fish.esm).
// A bare cc* match would also catch community mods like CCOR.esp.
const CC_FILE_RE = /^cc[a-z]{3}sse\d{3}-.*\.(?:es[mlp]|bsa)$/i
// AE extras the engine force-loads without a plugins.txt entry.
const CC_EXTRAS  = new Set(['_resourcepack.esl', '_resourcepack.bsa', 'marketplacetextures.bsa'])

/**
 * Move Creation Club plugins/archives (plus the AE resource pack and
 * marketplace textures) out of <gamePath>/Data into "<gamePath>/disabled CC
 * mods". Non-portable installs play from the user's real Skyrim folder, where
 * the engine force-loads CC content via Skyrim.ccc regardless of plugins.txt
 * and fights the server's load order. Files named in serverLoadOrder are left
 * alone. Idempotent; returns the number of files moved.
 */
function disableCcContent(gamePath, serverLoadOrder) {
  const dataDir = path.join(gamePath, 'Data')
  const keep = new Set((serverLoadOrder || []).map(f => path.basename(f).toLowerCase()))
  let names = []
  try { names = fs.readdirSync(dataDir) } catch { return 0 }

  const destDir = path.join(gamePath, 'disabled CC mods')
  let moved = 0
  for (const name of names) {
    const l = name.toLowerCase()
    if (!(CC_FILE_RE.test(l) || CC_EXTRAS.has(l))) continue
    if (REQUIRED_CC_FILES.has(l)) continue
    if (keep.has(l)) continue   // the server actually uses it - leave it alone
    try {
      fs.mkdirSync(lp(destDir), { recursive: true })
      fs.renameSync(lp(path.join(dataDir, name)), lp(path.join(destDir, name)))
      moved++
    } catch (err) {
      _log(`could not move ${name} to disabled CC mods: ${err.message}`)
    }
  }
  if (moved > 0) _log(`moved ${moved} Creation Club file(s) to ${destDir}`)
  return moved
}

// Launch

/** Launch the game through MO2's VFS using the SKSE executable entry. */
function launchGame() {
  if (!isInstalled()) throw new Error('MO2 is not installed - run setup in Settings first.')
  spawn(getExe(), ['-p', PROFILE, 'moshortcut://:SKSE'], {
    detached: true,
    stdio: 'ignore',
    cwd: getRoot(),
  }).unref()
}

/** Open the MO2 UI itself (for manual mod management / inspection). */
function openUI() {
  if (!isInstalled()) throw new Error('MO2 is not installed.')
  spawn(getExe(), ['-p', PROFILE], { detached: true, stdio: 'ignore', cwd: getRoot() }).unref()
}

// Status

function getStatus() {
  let modCount = 0
  try { modCount = fs.readdirSync(getModsDir(), { withFileTypes: true }).filter(e => e.isDirectory()).length }
  catch {}
  return {
    installed: isInstalled(),
    version:   MO2_VERSION,
    root:      getRoot(),
    modCount,
  }
}

module.exports = {
  setLogger,
  setRootProvider,
  PROFILE,
  getRoot,
  getDownloadsDir,
  getModsDir,
  getClientModName,
  getProfileDir,
  isInstalled,
  ensureInstalled,
  ensureMo2Plugins,
  ensureInstance,
  registerNxmHandler,
  downloadToDownloads,
  pruneStaleDownloads,
  findDownloadByFileId,
  findArchiveByHash,
  verifyArchive,
  verifyArchiveAsync,
  verifyModContents,
  sha256File,
  extractToCache,
  clearCache,
  installClientZipAsMod,
  applyMod,
  readModHash,
  applyRootFiles,
  setModlistOrder,
  ensureHighPriorityMods,
  setPlugins,
  skseSourceFor,
  installSkse,
  enforceModRules,
  waitForDownloads,
  disableCcContent,
  launchGame,
  openUI,
  getStatus,
}
