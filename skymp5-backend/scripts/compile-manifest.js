'use strict'

/**
 * Compile an install manifest from a reference MO2 install.
 * Author overrides live in data/manifest-sources.json (all optional):
 *   { "urls": { "<archiveName>": "https://direct-download/…" }, "rootInclude": ["skse64_loader.exe", …] }
 * `urls` gives a download source to non-Nexus archives; `rootInclude` lists
 * game-root files to capture (skse64_*.exe/.dll are picked up automatically).
 */

const fs      = require('fs')
const path    = require('path')
const crypto  = require('crypto')
const zlib    = require('zlib')
const { execFileSync } = require('child_process')
const BUNDLED_SEVEN = require('7zip-bin').path7za
const SEVEN   = process.env.SKYRP_7Z && fs.existsSync(process.env.SKYRP_7Z)
  ? process.env.SKYRP_7Z
  : BUNDLED_SEVEN

// Args

function parseArgs(argv) {
  const a = { profile: 'SkyRP' }
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    if      (k === '--mo2')     a.mo2     = argv[++i]
    else if (k === '--game')    a.game    = argv[++i]
    else if (k === '--profile') a.profile = argv[++i]
    else if (k === '--out')     a.out     = argv[++i]
  }
  return a
}

const args = parseArgs(process.argv.slice(2))
if (!args.mo2) {
  console.error('Usage: node scripts/compile-manifest.js --mo2 <MO2 root> [--game <game root>] [--profile SkyRP]')
  process.exit(1)
}

const MO2         = path.resolve(args.mo2)
const DOWNLOADS   = path.join(MO2, 'downloads')
const MODS        = path.join(MO2, 'mods')
const PROFILE_DIR = path.join(MO2, 'profiles', args.profile)
const DATA_DIR    = path.join(__dirname, '..', 'data')
const OUT         = args.out ? path.resolve(args.out) : path.join(DATA_DIR, 'install-manifest.json')
const MODLIST_OUT = path.join(DATA_DIR, 'modlist.json')

const DEFAULT_INLINE_LIMIT = 50 * 1024 * 1024
const INLINE_LIMIT = parseInlineLimit(process.env.SKYRP_INLINE_LIMIT_MB)
const INLINE_WARN = Math.min(INLINE_LIMIT, DEFAULT_INLINE_LIMIT)

let sources = { urls: {}, rootInclude: [] }
const SOURCES_FILE = path.join(DATA_DIR, 'manifest-sources.json')
try {
  sources = { urls: {}, rootInclude: [], ...JSON.parse(fs.readFileSync(SOURCES_FILE, 'utf8')) }
} catch (err) {
  // Absent is fine (the file is optional); present-but-broken must abort, or
  // every URL override is silently dropped and the mods get inlined as 'manual'.
  if (err.code !== 'ENOENT') {
    console.error(`manifest-sources.json is unreadable (${err.message}) - fix or delete it, refusing to build with overrides silently ignored`)
    process.exit(1)
  }
}

// Hash helpers

function sha256Buf(buf)  { return crypto.createHash('sha256').update(buf).digest('hex') }
function crc32ToHex(crc) { return (crc >>> 0).toString(16).toUpperCase().padStart(8, '0') }

function parseInlineLimit(value) {
  if (value == null || value === '') return DEFAULT_INLINE_LIMIT
  const mb = Number(value)
  if (!Number.isFinite(mb) || mb < 0) return DEFAULT_INLINE_LIMIT
  return Math.floor(mb * 1024 * 1024)
}

function humanSize(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${bytes} B`
}

function fileFingerprint(absFile, collectInline) {
  const st = fs.statSync(absFile)
  const h = crypto.createHash('sha256')
  const chunks = collectInline ? [] : null
  const fd = fs.openSync(absFile, 'r')
  const buf = Buffer.allocUnsafe(1024 * 1024)
  let crc = 0
  let total = 0

  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null)
      if (n === 0) break
      const chunk = buf.subarray(0, n)
      h.update(chunk)
      crc = zlib.crc32(chunk, crc)
      total += n
      if (chunks) chunks.push(Buffer.from(chunk))
    }
  } finally {
    fs.closeSync(fd)
  }

  return {
    size: st.size,
    bytesRead: total,
    sha256: h.digest('hex'),
    crc: crc32ToHex(crc),
    inline: chunks ? Buffer.concat(chunks, total).toString('base64') : null,
  }
}

function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256')
    fs.createReadStream(p)
      .on('data', d => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject)
  })
}

// FS helpers

/** Recursively list files under dir as forward-slash paths relative to base. */
function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full, base, out)
    else out.push(path.relative(base, full).split(path.sep).join('/'))
  }
  return out
}

function normalizeGameName(value) {
  const v = String(value || '').trim()
  if (/^skyrim$/i.test(v)) return 'Skyrim'
  if (/^skyrimse$/i.test(v)) return 'SkyrimSE'
  return ''
}

function archiveNameKey(value) {
  return path.basename(String(value || '').trim()).toLowerCase()
}

function archiveStemKey(value) {
  return archiveNameKey(value).replace(/\.(7z|zip|rar)$/i, '')
}

function collectArchiveNameHints(meta) {
  const names = new Set()
  for (const line of String(meta || '').split(/\r?\n/)) {
    const m = line.match(/^[^=]*=\s*(.+?\.(?:7z|zip|rar))(?:\s|$)/i)
    if (m) names.add(archiveNameKey(m[1]))
  }
  return names
}

/** Read a download's .meta sidecar for Nexus mod/file ids. */
function readDownloadMeta(name) {
  try {
    const meta     = fs.readFileSync(path.join(DOWNLOADS, name + '.meta'), 'utf8')
    const modId    = (meta.match(/^modID\s*=\s*(\d+)/im)    || [])[1]
    const fileId   = (meta.match(/^fileID\s*=\s*(\d+)/im)   || [])[1]
    const gameName = (meta.match(/^gameName\s*=\s*([^\r\n]+)/im) || [])[1]
    return {
      modId:    modId ? Number(modId) : 0,
      fileId:   fileId ? Number(fileId) : 0,
      gameName: normalizeGameName(gameName),
    }
  } catch { return { modId: 0, fileId: 0, gameName: '' } }
}

/** Read a mod folder's MO2 meta.ini for its Nexus metadata. */
function readModMeta(modDir) {
  try {
    const meta     = fs.readFileSync(path.join(modDir, 'meta.ini'), 'utf8')
    const id       = (meta.match(/^modid\s*=\s*(\d+)/im) || [])[1]
    const gameName = (meta.match(/^gameName\s*=\s*([^\r\n]+)/im) || [])[1]
    return {
      modId: id ? Number(id) : 0,
      gameName: normalizeGameName(gameName),
      archiveNames: collectArchiveNameHints(meta),
    }
  } catch { return { modId: 0, gameName: '', archiveNames: new Set() } }
}

/** List archive entries as [{ path, size, crc }] (files only, with a CRC). */
function listEntries(archivePath) {
  const out = execFileSync(SEVEN, ['l', '-slt', '-ba', '-sccUTF-8', archivePath], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    timeout: 5 * 60 * 1000,
  })
  const entries = []
  let cur = null
  const push = () => { if (cur && cur.path) entries.push(cur) }
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith('Path = '))        { push(); cur = { path: line.slice(7), size: 0, crc: '', folder: false } }
    else if (cur && line.startsWith('Size = '))   cur.size   = parseInt(line.slice(7), 10) || 0
    else if (cur && line.startsWith('CRC = '))    cur.crc    = line.slice(6).trim()
    else if (cur && line.startsWith('Folder = ')) cur.folder = line.slice(9).trim() === '+'
  }
  push()
  return entries
    .filter(e => e.crc && !e.folder)
    .map(e => ({ path: e.path.split('\\').join('/'), size: e.size, crc: e.crc }))
}

// Main

async function main() {
  if (!fs.existsSync(MODS)) throw new Error(`mods folder not found: ${MODS}`)

  // 1. Resolve the enabled mod order before archive indexing, so disabled-only
  // Nexus downloads cannot accidentally satisfy files from enabled mods.
  const modFolders = fs.readdirSync(MODS, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)

  let order = []
  let disabledProfileMods = new Set()
  try {
    const profileEntries = fs.readFileSync(path.join(PROFILE_DIR, 'modlist.txt'), 'utf8')
      .split(/\r?\n/)
      .map(l => ({ state: l[0], name: l.slice(1).trim() }))
      .filter(e => (e.state === '+' || e.state === '-') && e.name)

    order = profileEntries
      .filter(e => e.state === '+' || (e.state === '-' && e.name.endsWith('_separator')))
      .map(e => e.name)

    disabledProfileMods = new Set(profileEntries
      .filter(e => e.state === '-' && !e.name.endsWith('_separator'))
      .map(e => e.name))
  } catch { /* no profile: fall back to every folder below */ }

  if (order.length === 0) {
    order = modFolders
    console.warn(`No profiles/${args.profile}/modlist.txt found - using all ${order.length} mod folders (unordered).`)
  }

  const enabledModNames = new Set(order.filter(n => !n.endsWith('_separator')))
  const allModIds = new Set()
  const enabledModIds = new Set()
  const enabledArchiveKeys = new Set()
  const disabledArchiveKeys = new Set()
  const enabledArchiveStems = new Set()
  const disabledArchiveStems = new Set()
  for (const modName of modFolders) {
    const modMeta = readModMeta(path.join(MODS, modName))
    const isEnabled = enabledModNames.has(modName)
    const isDisabled = disabledProfileMods.has(modName)
    if (modMeta.modId) {
      allModIds.add(modMeta.modId)
      if (isEnabled) enabledModIds.add(modMeta.modId)
    }
    for (const archiveName of modMeta.archiveNames) {
      if (isEnabled) enabledArchiveKeys.add(archiveName)
      else if (isDisabled) disabledArchiveKeys.add(archiveName)
    }
    const folderStem = archiveStemKey(modName)
    if (isEnabled) enabledArchiveStems.add(folderStem)
    else if (isDisabled) disabledArchiveStems.add(folderStem)
  }

  // 2. Index eligible archive entries by (size, CRC32)
  const archives = []                 // { id, hash, size, name, source, _entries }
  const index    = new Map()          // "size:CRC" -> { id, from }
  const referenced = new Set()
  let skippedDisabledArchives = 0

  const dlNames = fs.existsSync(DOWNLOADS)
    ? fs.readdirSync(DOWNLOADS).filter(n => !/\.(meta|unfinished|bak)$/i.test(n))
    : []

  for (const name of dlNames) {
    const full = path.join(DOWNLOADS, name)
    let st
    try { st = fs.statSync(full) } catch { continue }
    if (!st.isFile()) continue

    const meta = readDownloadMeta(name)
    if (meta.modId && allModIds.has(meta.modId) && !enabledModIds.has(meta.modId)) {
      skippedDisabledArchives++
      continue
    }
    const nameKey = archiveNameKey(name)
    const stemKey = archiveStemKey(name)
    if ((disabledArchiveKeys.has(nameKey) && !enabledArchiveKeys.has(nameKey)) ||
        (disabledArchiveStems.has(stemKey) && !enabledArchiveStems.has(stemKey))) {
      skippedDisabledArchives++
      continue
    }

    let entries
    try { entries = listEntries(full) } catch { continue }   // not an archive
    if (entries.length === 0) continue

    let source
    if (meta.modId && meta.fileId) source = {
      type: 'nexus',
      modId: meta.modId,
      fileId: meta.fileId,
      ...(meta.gameName ? { gameName: meta.gameName } : {}),
    }
    else if (sources.urls[name])   source = { type: 'url', url: sources.urls[name] }
    else                           source = { type: 'manual', name }

    const id   = 'a' + (archives.length + 1)
    const hash = await sha256File(full)
    archives.push({ id, hash, size: st.size, name, source })

    for (const e of entries) {
      const key = e.size + ':' + e.crc
      if (!index.has(key)) index.set(key, { id, from: e.path })   // first archive wins
    }
    console.log(`  indexed ${name} (${entries.length} entries, ${source.type})`)
  }

  const archiveById = new Map(archives.map(a => [a.id, a]))

  // 3. Resolve plugin load order from the profile. MO2's "*" prefix marks an enabled plugin.
  let plugins = []
  try {
    plugins = fs.readFileSync(path.join(PROFILE_DIR, 'plugins.txt'), 'utf8')
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'))
  } catch { /* no plugins.txt: load order then comes from the server at launch */ }

  // 4. Emit a directive per file in each mod folder
  const mods = []
  const inlineWarnings = []

  // Stable per-mod content fingerprint so the launcher reinstalls only mods that actually changed on rebuild
  const contentHash = files =>
    sha256Buf(Buffer.from(files.map(f => `${f.to}:${f.sha256}`).sort().join('\n')))

  function directiveFor(absFile, toRel) {
    const st = fs.statSync(absFile)
    const canInline = st.size <= INLINE_LIMIT
    const fp = fileFingerprint(absFile, canInline)
    if (fp.bytesRead !== fp.size) throw new Error(`failed to read complete file: ${absFile}`)

    const hit = index.get(fp.size + ':' + fp.crc)
    if (hit) {
      referenced.add(hit.id)
      return { to: toRel, archive: hit.id, from: hit.from, sha256: fp.sha256, size: fp.size }
    }

    if (!canInline) {
      const rel = path.relative(MO2, absFile) || absFile
      throw new Error(
        `large file is not present in any indexed download archive: ${rel} (${humanSize(fp.size)}). ` +
        `Put the original archive in "${DOWNLOADS}" or make sure full 7-Zip can read it; ` +
        `the builder will not inline files larger than ${humanSize(INLINE_LIMIT)}.`
      )
    }

    if (INLINE_WARN > 0 && fp.size >= INLINE_WARN) inlineWarnings.push(`${toRel} (${humanSize(fp.size)})`)
    return { to: toRel, inline: fp.inline, sha256: fp.sha256, size: fp.size }
  }

  function gameNameFromReferencedArchives(modName, files, fallback) {
    const fallbackGame = normalizeGameName(fallback)
    const seen = new Set()
    const gameNames = []
    for (const f of files) {
      const source = archiveById.get(f.archive)?.source
      if (source?.type !== 'nexus') continue
      const gameName = normalizeGameName(source.gameName)
      if (!gameName || seen.has(gameName)) continue
      seen.add(gameName)
      gameNames.push(gameName)
    }

    if (gameNames.length === 1) return gameNames[0]
    if (gameNames.length > 1) {
      if (fallbackGame && seen.has(fallbackGame)) return fallbackGame
      console.warn(`multiple Nexus gameName values for ${modName}; using ${gameNames[0]} (${gameNames.join(', ')})`)
      return gameNames[0]
    }
    return fallbackGame
  }

  for (const modName of order) {
    const modDir = path.join(MODS, modName)
    if (!fs.existsSync(modDir)) continue
    const rels = walk(modDir).filter(r => r.toLowerCase() !== 'meta.ini')
    if (rels.length === 0) continue

    const files = rels.map(rel => directiveFor(path.join(modDir, rel.split('/').join(path.sep)), rel))
    const modMeta = readModMeta(modDir)
    const gameName = gameNameFromReferencedArchives(modName, files, modMeta.gameName)
    mods.push({
      name: modName,
      modId: modMeta.modId,
      ...(gameName ? { gameName } : {}),
      files,
      hash: contentHash(files),
    })
  }

  // 5. Optional game-root files (preloaders, etc.)
  const root = []
  if (args.game) {
    const gameRoot = path.resolve(args.game)
    for (const rel of new Set(sources.rootInclude || [])) {
      const full = path.join(gameRoot, rel.split('/').join(path.sep))
      if (!fs.existsSync(full)) { console.warn(`rootInclude not found, skipping: ${rel}`); continue }
      root.push(directiveFor(full, rel))
    }
  }

  // 6. Write the manifest (only referenced archives carry over)
  const usedArchives = archives
    .filter(a => referenced.has(a.id))
    .map(({ id, hash, size, name, source }) => ({ id, hash, size, name, source }))

  const manifest = {
    schema:  2,
    builtAt: new Date().toISOString(),
    game:    'skyrimspecialedition',
    archives: usedArchives,
    mods,
    order,      // full modlist.txt order, separators included
    plugins,    // plugins.txt load order
    root,
    rootHash: contentHash(root),
  }
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify(manifest, null, '\t') + '\n')

  // Lightweight display list so /api/modlist (the launcher's Modlist panel) keeps its shape without a second source of truth
  const display = [
    { name: 'SkyMP Client', required: true, enabled: true, source: 'backend' },
    ...mods.map(m => ({
      name: m.name, required: true, enabled: true,
      source: m.modId ? 'nexus' : 'url',
      ...(m.modId ? { nexusId: m.modId } : {}),
      ...(m.gameName ? { gameName: m.gameName } : {}),
    })),
  ]
  fs.writeFileSync(MODLIST_OUT, JSON.stringify(display, null, 2) + '\n')

  // Report
  const inlineCount = mods.reduce((n, m) => n + m.files.filter(f => f.inline != null).length, 0) +
                      root.filter(f => f.inline != null).length
  const skippedSuffix = skippedDisabledArchives ? `, ${skippedDisabledArchives} skipped disabled` : ''
  console.log(`\narchives:    ${usedArchives.length} referenced (${archives.length} scanned${skippedSuffix})`)
  console.log(`mods:        ${mods.length}`)
  console.log(`separators:  ${order.filter(n => n.endsWith('_separator')).length}`)
  console.log(`plugins:     ${plugins.length}`)
  console.log(`root files:  ${root.length}`)
  console.log(`directives:  ${mods.reduce((n, m) => n + m.files.length, 0) + root.length} (${inlineCount} inline)`)

  const manual = usedArchives.filter(a => a.source.type === 'manual')
  if (manual.length) {
    console.warn('\nReferenced archives with NO download source - the launcher cannot fetch these.')
    console.warn('Add a URL for each in data/manifest-sources.json ("urls"):')
    for (const a of manual) console.warn(`  - ${a.name}`)
  }
  if (inlineWarnings.length) {
    console.warn('\nLarge files were inlined (bloats the manifest - add the source archive to downloads\\):')
    for (const w of inlineWarnings) console.warn(`  - ${w}`)
  }

  console.log(`\nWrote ${OUT}`)
  console.log(`Wrote ${MODLIST_OUT}`)
}

main().catch(err => {
  console.error('FAILED:', err.message)
  process.exit(1)
})
