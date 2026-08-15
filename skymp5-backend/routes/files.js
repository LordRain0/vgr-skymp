'use strict'

/**
 * File distribution endpoints, both built by `npm run merge` (scripts/merge-files.js); 404 until then.
 *   GET /api/files/version - version metadata the launcher uses to decide whether to re-download
 *   GET /api/files/zip     - the distributable zip streamed to the client
 */

const router = require('express').Router()
const path   = require('path')
const fs     = require('fs')
const http   = require('http')
const https  = require('https')
const rateLimit = require('express-rate-limit')
const config = require('../config')

const ZIP_PATH     = path.join(config.clientFilesDir, config.clientZipName)
const VERSION_PATH = path.join(__dirname, '..', 'data', 'files-version.json')
const REMOTE_ZIP_URL = (config.clientZipUrl || '').trim()
const REMOTE_TIMEOUT_MS = 120_000
const MAX_REMOTE_REDIRECTS = 5

const NOT_BUILT = { error: 'File package not found. Run `npm run merge` on the server first.' }

// Only the zip is rate-limited: /version is polled every 10s by every open launcher (90 requests/window each), which a router-wide cap of 100 would choke on
const filesRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' }
})

// GET /api/files/version

router.get('/version', (_req, res) => {
  if (!fs.existsSync(VERSION_PATH)) return res.status(404).json(NOT_BUILT)
  try {
    // Read fresh every time (do NOT use require(); it caches the module)
    res.json(JSON.parse(fs.readFileSync(VERSION_PATH, 'utf8')))
  } catch {
    res.status(500).json({ error: 'Could not read version file.' })
  }
})

function parseRangeHeader(rangeHeader, size) {
  const match = String(rangeHeader || '').match(/^bytes=(\d*)-(\d*)$/)
  if (!match) return null

  let start
  let end

  if (match[1] === '' && match[2] === '') return null

  if (match[1] === '') {
    const suffixLength = Number(match[2])
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null
    start = Math.max(size - suffixLength, 0)
    end = size - 1
  } else {
    start = Number(match[1])
    end = match[2] === '' ? size - 1 : Number(match[2])
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= size) {
    return null
  }

  return { start, end: Math.min(end, size - 1) }
}

function streamLocalZip(req, res) {
  if (!fs.existsSync(ZIP_PATH)) return res.status(404).json(NOT_BUILT)

  const stat = fs.statSync(ZIP_PATH)
  const range = parseRangeHeader(req.headers.range, stat.size)

  res.setHeader('Content-Type', 'application/zip')
  res.setHeader('Content-Disposition', 'attachment; filename="SkyMP-client.zip"')
  res.setHeader('Accept-Ranges', 'bytes')

  if (req.headers.range && !range) {
    res.setHeader('Content-Range', `bytes */${stat.size}`)
    return res.status(416).end()
  }

  if (range) {
    res.status(206)
    res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${stat.size}`)
    res.setHeader('Content-Length', range.end - range.start + 1)

    const stream = fs.createReadStream(ZIP_PATH, range)
    stream.on('error', () => res.destroy())
    stream.pipe(res)
    return
  }

  res.setHeader('Content-Length', stat.size)

  const stream = fs.createReadStream(ZIP_PATH)
  stream.on('error', () => res.destroy())
  stream.pipe(res)
}

function streamRemoteZip(urlString, req, res, redirectsLeft = MAX_REMOTE_REDIRECTS) {
  let url
  try {
    url = new URL(urlString)
  } catch {
    return res.status(500).json({ error: 'CLIENT_ZIP_URL is not a valid URL.' })
  }

  const transport = url.protocol === 'https:' ? https : url.protocol === 'http:' ? http : null
  if (!transport) return res.status(500).json({ error: 'CLIENT_ZIP_URL must use http or https.' })

  const upstreamReq = transport.get(url, {
    headers: req.headers.range ? { Range: req.headers.range } : undefined,
  }, upstream => {
    const statusCode = upstream.statusCode || 500
    if (statusCode >= 300 && statusCode < 400 && upstream.headers.location) {
      upstream.resume()
      if (redirectsLeft <= 0) {
        return res.status(502).json({ error: 'Remote client zip redirected too many times.' })
      }
      return streamRemoteZip(new URL(upstream.headers.location, url).href, req, res, redirectsLeft - 1)
    }

    if (statusCode < 200 || statusCode >= 300) {
      upstream.resume()
      return res.status(502).json({ error: `Remote client zip returned HTTP ${statusCode}.` })
    }

    res.setHeader('Content-Type', upstream.headers['content-type'] || 'application/zip')
    if (upstream.headers['content-length']) res.setHeader('Content-Length', upstream.headers['content-length'])
    if (upstream.headers['accept-ranges']) res.setHeader('Accept-Ranges', upstream.headers['accept-ranges'])
    if (upstream.headers['content-range']) res.setHeader('Content-Range', upstream.headers['content-range'])
    res.setHeader('Content-Disposition', 'attachment; filename="SkyMP-client.zip"')
    res.status(statusCode)

    upstream.on('error', () => res.destroy())
    upstream.pipe(res)
  })

  upstreamReq.setTimeout(REMOTE_TIMEOUT_MS, () => upstreamReq.destroy(new Error('Remote client zip download timed out.')))
  upstreamReq.on('error', err => {
    if (!res.headersSent) return res.status(502).json({ error: err.message || 'Could not fetch remote client zip.' })
    res.destroy()
  })
  res.on('close', () => upstreamReq.destroy())
}

// GET /api/files/zip

router.get('/zip', filesRateLimiter, (req, res) => {
  if (REMOTE_ZIP_URL) return streamRemoteZip(REMOTE_ZIP_URL, req, res)
  streamLocalZip(req, res)
})

module.exports = router
