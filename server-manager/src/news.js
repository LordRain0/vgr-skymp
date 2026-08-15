'use strict'

// Launcher news store: reads and writes skymp5-backend/data/news.json and lists
// the images under skymp5-backend/public/images. Plain Node (no Electron), so
// it can be exercised outside the app. The backend serves the same file at
// GET /api/news, re-reading it on change, so saves here go live immediately.

const fs   = require('fs')
const path = require('path')
const config = require('./config')

const IMAGE_EXTS = new Set(['.gif', '.png', '.jpg', '.jpeg', '.webp'])

function readItems() {
  let raw
  try { raw = fs.readFileSync(config.paths.newsFile, 'utf8') }
  catch (err) {
    if (err.code === 'ENOENT') return []            // fresh box: no news yet
    throw new Error(`could not read news.json: ${err.message}`)
  }
  let parsed
  try { parsed = JSON.parse(raw) }
  catch (err) { throw new Error(`news.json is invalid JSON (${err.message}) - fix the file first`) }
  if (!Array.isArray(parsed)) throw new Error('news.json is not an array - fix the file first')
  return parsed
}

// The launcher renders {title, body, date, tag, image} verbatim; image is a
// /images/<file> path the backend absolutizes, or a full http(s) URL.
function sanitizeItem(item, index) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new Error(`entry ${index + 1}: not an object`)
  }
  const title = String(item.title ?? '').trim()
  if (!title) throw new Error(`entry ${index + 1}: title is required`)
  const out = {
    title,
    body:  String(item.body ?? '').trim(),
    date:  String(item.date ?? '').trim(),
    tag:   String(item.tag ?? '').trim().toUpperCase() || 'UPDATE',
  }
  const image = String(item.image ?? '').trim()
  if (image) {
    if (!/^https?:\/\//i.test(image) && !image.startsWith('/images/')) {
      throw new Error(`entry ${index + 1}: image must be /images/<file> or an http(s) URL`)
    }
    out.image = image
  }
  return out
}

// Atomic write (tmp + rename): the live backend re-reads this file on change
// and must never observe a half-written JSON.
function writeItems(items) {
  if (!Array.isArray(items)) throw new Error('news: not an array')
  const clean = items.map(sanitizeItem)
  const file = config.paths.newsFile
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2) + '\n')
  fs.renameSync(tmp, file)
  return clean
}

// Images the picker offers, gifs first (the launcher animates them natively).
function listImages() {
  const dir = config.paths.newsImagesDir
  let entries = []
  try { entries = fs.readdirSync(dir) } catch { return { dir, images: [] } }
  const images = []
  for (const name of entries) {
    const ext = path.extname(name).toLowerCase()
    if (!IMAGE_EXTS.has(ext)) continue
    let stat
    try { stat = fs.statSync(path.join(dir, name)) } catch { continue }
    if (!stat.isFile()) continue
    images.push({
      name,
      url: '/images/' + name,                        // what goes into news.json
      file: path.join(dir, name),                    // what the picker previews
      gif: ext === '.gif',
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    })
  }
  images.sort((a, b) => (b.gif - a.gif) || (b.mtimeMs - a.mtimeMs))
  return { dir, images }
}

// Copy an image picked from anywhere on disk into the served images folder.
// The name is sanitized and never overwrites an existing file.
function importImage(sourcePath) {
  const ext = path.extname(sourcePath).toLowerCase()
  if (!IMAGE_EXTS.has(ext)) throw new Error(`unsupported image type ${ext || '(none)'}`)
  const dir = config.paths.newsImagesDir
  fs.mkdirSync(dir, { recursive: true })
  const base = path.basename(sourcePath, path.extname(sourcePath))
    .replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'news-image'
  let name = base + ext
  for (let n = 2; fs.existsSync(path.join(dir, name)); n++) name = `${base}-${n}${ext}`
  fs.copyFileSync(sourcePath, path.join(dir, name))
  return { name, url: '/images/' + name, file: path.join(dir, name) }
}

// Default date string in the display format the launcher shows verbatim.
function todayLabel(d = new Date()) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`
}

module.exports = { readItems, writeItems, listImages, importImage, todayLabel, sanitizeItem }
