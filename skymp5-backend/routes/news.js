const router = require('express').Router()
const fs   = require('fs')
const path = require('path')

const NEWS_FILE = path.join(__dirname, '..', 'data', 'news.json')

// Re-read on change (mtime check) so Server Manager edits are served without a
// backend restart. A missing or momentarily-invalid file keeps the last good copy.
let cache = { mtimeMs: -1, items: [] }
function loadNews() {
  let stat
  try { stat = fs.statSync(NEWS_FILE) } catch { return cache.items }
  if (stat.mtimeMs !== cache.mtimeMs) {
    try {
      const parsed = JSON.parse(fs.readFileSync(NEWS_FILE, 'utf8'))
      cache = { mtimeMs: stat.mtimeMs, items: Array.isArray(parsed) ? parsed : [] }
    } catch { /* mid-write or bad JSON: serve the previous copy */ }
  }
  return cache.items
}

router.get('/', (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`
  const items = loadNews().map(item => ({
    ...item,
    image: item.image
      ? /^https?:\/\//i.test(item.image) ? item.image : `${base}${item.image}`
      : null,
  }))
  res.json(items)
})

module.exports = router
