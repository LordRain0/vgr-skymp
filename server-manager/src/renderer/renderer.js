'use strict'

const $  = sel => document.querySelector(sel)
const $$ = sel => Array.from(document.querySelectorAll(sel))
const el = (tag, props = {}, html) => Object.assign(document.createElement(tag), props, html != null ? { innerHTML: html } : {})
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

// Per-pane line caps: the console tails services forever and unbounded
// textContent eventually breaks rendering, so keep only the newest lines.
const LINE_LIMITS = { log: 500, 'build-log': 2000 }

function appendLog(node, text) {
  if (!node) return
  const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 40
  // Normalise CRLF to LF
  text = text.replace(/\r\n/g, '\n')
  if (text.indexOf('\r') === -1) {
    node.textContent += text
  } else {
    const old = node.textContent
    const cut = old.lastIndexOf('\n') + 1          // only the unfinished last line can be rewritten
    node.textContent = old.slice(0, cut) + (old.slice(cut) + text)
      .split('\n')
      .map(seg => { const i = seg.lastIndexOf('\r'); return i === -1 ? seg : seg.slice(i + 1) })
      .join('\n')
  }
  const max = LINE_LIMITS[node.id]
  if (max) {
    // A trailing '' after split is the usual newline-terminated state, not a line
    const lines = node.textContent.split('\n')
    const count = lines[lines.length - 1] === '' ? lines.length - 1 : lines.length
    if (count > max) {
      const before = node.scrollHeight
      node.textContent = lines.slice(count - max).join('\n')
      // Content was removed from the top: keep a scrolled-up reader anchored
      if (!atBottom) node.scrollTop = Math.max(0, node.scrollTop - (before - node.scrollHeight))
    }
  }
  if (atBottom) node.scrollTop = node.scrollHeight
}

$$('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach(t => t.classList.remove('active'))
    $$('.panel').forEach(p => p.classList.remove('active'))
    tab.classList.add('active')
    $('#' + tab.dataset.tab).classList.add('active')
  })
})

// Build output streams to the active panel's log (Build → #build-log, Modlist → #modlist-log).
window.mgr.onBuildLog(t => appendLog($('.panel.active')?.querySelector('.log') || $('#build-log'), t))

// Keep in sync with `services` in src/config.js (the main process owns the
// nssm service names; this is the renderer's copy of key/label). If the two
// drift, the UI silently shows a stale set.
const SERVICES = [
  { key: 'nginx',   label: 'Nginx'   },
  { key: 'backend', label: 'Backend' },
  { key: 'game',    label: 'Game'    },
]
const logNode = $('#log')

function renderServices() {
  const box = $('#services')
  box.innerHTML = ''
  for (const s of SERVICES) {
    const row = el('div', { className: 'svc-row' })
    row.appendChild(el('span', { className: 'svc-name' }, s.label))
    row.appendChild(el('span', { className: 'svc-status', id: `svc-${s.key}` }, '…'))
    const sel = el('select', { className: 'svc-action' })
    sel.appendChild(el('option', { value: '' }, 'Action…'))
    sel.appendChild(el('option', { value: 'start' }, 'Start'))
    sel.appendChild(el('option', { value: 'stop' }, 'Stop'))
    sel.appendChild(el('option', { value: 'restart' }, 'Restart'))
    sel.addEventListener('change', async () => {
      const action = sel.value
      sel.value = ''
      if (!action) return
      sel.disabled = true
      appendLog(logNode, `\n--- ${action} ${s.label} ---\n`)
      const r = await window.mgr.serviceAction(s.key, action)
      if (r.steps) r.steps.forEach(x => appendLog(logNode, x + '\n'))
      if (r.error) appendLog(logNode, 'error: ' + r.error + '\n')
      if (r.status) paintStatus(r.status)
      sel.disabled = false
    })
    row.appendChild(sel)
    box.appendChild(row)
  }
  const allRow = el('div', { className: 'svc-row' })
  allRow.appendChild(el('span', { className: 'svc-name' }, 'All'))
  allRow.appendChild(el('span', { className: 'svc-status', id: 'svc-all' }, '…'))
  const allSel = el('select', { className: 'svc-action' })
  allSel.appendChild(el('option', { value: '' }, 'Action…'))
  allSel.appendChild(el('option', { value: 'start' }, 'Start all'))
  allSel.appendChild(el('option', { value: 'stop' }, 'Stop all'))
  allSel.appendChild(el('option', { value: 'restart' }, 'Restart all'))
  allSel.addEventListener('change', async () => {
    const action = allSel.value
    allSel.value = ''
    if (!action) return
    allSel.disabled = true
    appendLog(logNode, `\n--- ${action} all services ---\n`)
    const r = await window.mgr.servicesAction(action)
    if (r.steps) r.steps.forEach(x => appendLog(logNode, x + '\n'))
    if (r.error) appendLog(logNode, 'error: ' + r.error + '\n')
    if (r.status) paintStatus(r.status)
    allSel.disabled = false
  })
  allRow.appendChild(allSel)
  box.appendChild(allRow)
}

function paintStatus(st) {
  let up = 0
  for (const s of SERVICES) {
    const node = $(`#svc-${s.key}`)
    if (!node) continue
    const raw = st[s.key] || '?'
    const running = /SERVICE_RUNNING/i.test(raw)
    const stopped = /SERVICE_STOPPED/i.test(raw)
    if (running) up++
    node.textContent = running ? 'running' : stopped ? 'stopped'
      : /does not exist/i.test(raw) ? 'not installed'
      : raw.replace(/^SERVICE_/i, '').toLowerCase()
    node.title = running || stopped ? '' : raw
    node.className = 'svc-status ' + (running ? 'ok' : stopped ? 'bad' : 'unknown')
  }
  const all = $('#svc-all')
  if (all) {
    const total = SERVICES.length
    all.textContent = up === total ? 'all up' : up === 0 ? 'all down' : `${up}/${total} up`
    all.className = 'svc-status ' + (up === total ? 'ok' : up === 0 ? 'bad' : 'unknown')
  }
}

async function refreshStatus() {
  try { paintStatus(await window.mgr.servicesStatus()) } catch {}
}

window.mgr.onLog(d => appendLog(logNode, d.source ? `[${d.source}] ${d.text}` : d.text))
window.mgr.onConsoleRelay(d => {
  if (d.kind === 'status') appendLog(logNode, `\n[console] ${d.text}\n`)
  else appendLog(logNode, d.text.endsWith('\n') ? d.text : d.text + '\n')
})

$('#cmd-form').addEventListener('submit', async e => {
  e.preventDefault()
  const input = $('#cmd')
  const text = input.value.trim()
  if (!text) return
  appendLog(logNode, `> ${text}\n`)
  input.value = ''
  const r = await window.mgr.consoleCommand(text)
  if (!r.ok) appendLog(logNode, `[command not delivered] ${r.error}\n`)
})

renderServices()
refreshStatus()
setInterval(refreshStatus, 10000)
appendLog(logNode, "Type 'help' for manager commands (services, builds); anything else goes to the game console.\n")

// Destructive buttons ask for a second click within 4s instead of a dialog;
// disabled while the action runs so a double-click cannot fire it twice.
function armConfirm(btn, label, fn) {
  if (!btn) return
  btn.dataset.label = label
  btn.addEventListener('click', async () => {
    if (btn.disabled) return
    if (!btn.dataset.armed) {
      btn.dataset.armed = '1'
      btn.textContent = 'Click again to confirm'
      setTimeout(() => disarmConfirm(btn), 4000)
      return
    }
    disarmConfirm(btn)
    btn.disabled = true
    try { await fn() } finally { btn.disabled = false }
  })
}

function disarmConfirm(btn) {
  if (btn && btn.dataset.label) { delete btn.dataset.armed; btn.textContent = btn.dataset.label }
}

// ── News tab: launcher news entries with a gif picker ──────────────────────────

let newsItems = []
let newsSelected = -1        // index into newsItems
let newsToday = ''
let newsImageFiles = {}      // '/images/x.gif' -> absolute file path (for previews)

async function refreshNewsImages() {
  const r = await window.mgr.newsImages()
  newsImageFiles = {}
  if (r.ok) for (const img of r.images) newsImageFiles[img.url] = img.file
  return r
}

function newsPreviewSrc(image) {
  if (!image) return null
  if (/^https?:\/\//i.test(image)) return image
  const file = newsImageFiles[image]
  return file ? 'file:///' + file.replace(/\\/g, '/') : null
}

async function loadNews(selectIndex = -1) {
  const r = await window.mgr.newsList()
  if (!r.ok) {
    newsItems = []
    $('#news-list').innerHTML = `<li class="muted">Error: ${esc(r.error)}</li>`
    return
  }
  newsItems = r.items
  newsToday = r.today || ''
  await refreshNewsImages()
  newsSelected = selectIndex
  renderNewsList()
  renderNewsEditor()
}

function newsStatus(text) { $('#news-status').textContent = text }

async function saveNews(selectIndex = newsSelected) {
  // Prune untouched "Add entry" drafts (no title/body/image) except the one
  // being saved right now, so a forgotten draft can't block another entry's save.
  const keep = []
  let sel = -1
  newsItems.forEach((item, i) => {
    const empty = !(String(item.title || '').trim() || String(item.body || '').trim() || item.image)
    if (empty && i !== selectIndex) return
    if (i === selectIndex) sel = keep.length
    keep.push(item)
  })
  newsItems = keep
  newsSelected = sel
  newsStatus('saving…')
  const r = await window.mgr.newsSave(newsItems)
  if (!r.ok) { newsStatus('Error: ' + r.error); renderNewsList(); return false }
  newsItems = r.items
  newsStatus('Saved - live in the launcher on its next refresh.')
  renderNewsList()
  renderNewsEditor()
  return true
}

function renderNewsList() {
  const ul = $('#news-list')
  ul.innerHTML = ''
  if (!newsItems.length) {
    ul.appendChild(el('li', { className: 'muted' }, 'No news yet - click “Add entry”.'))
    return
  }
  newsItems.forEach((item, i) => {
    const li = el('li', { className: 'news-item' + (i === newsSelected ? ' selected' : '') })
    const thumb = el('div', { className: 'news-thumb' })
    const src = newsPreviewSrc(item.image)
    if (src) thumb.appendChild(el('img', { src, alt: '' }))
    li.appendChild(thumb)
    const main = el('div', { className: 'news-main' })
    const head = el('div', { className: 'pl-main' })
    head.appendChild(el('span', { className: 'news-tag' }, esc(item.tag || 'UPDATE')))
    head.appendChild(el('span', { className: 'pl-name' }, esc(item.title)))
    main.appendChild(head)
    main.appendChild(el('div', { className: 'pl-sub' }, esc(item.date || '')))
    li.appendChild(main)
    const ctrls = el('div', { className: 'news-ctrls' })
    const up = el('button', { className: 'action small', title: 'Move up' }, '↑')
    const down = el('button', { className: 'action small', title: 'Move down' }, '↓')
    up.disabled = i === 0
    down.disabled = i === newsItems.length - 1
    up.addEventListener('click', e => { e.stopPropagation(); moveNews(i, -1) })
    down.addEventListener('click', e => { e.stopPropagation(); moveNews(i, +1) })
    ctrls.appendChild(up); ctrls.appendChild(down)
    li.appendChild(ctrls)
    li.addEventListener('click', () => { newsSelected = i; renderNewsList(); renderNewsEditor() })
    ul.appendChild(li)
  })
}

function moveNews(i, dir) {
  const j = i + dir
  if (j < 0 || j >= newsItems.length) return
  const [it] = newsItems.splice(i, 1)
  newsItems.splice(j, 0, it)
  saveNews(newsSelected === i ? j : newsSelected === j ? i : newsSelected)
}

function renderNewsEditor() {
  const box = $('#news-editor')
  if (newsSelected < 0 || newsSelected >= newsItems.length) {
    box.innerHTML = '<p class="muted">Select an entry to edit it, or click “Add entry”. Entries appear in the launcher top to bottom.</p>'
    return
  }
  const item = newsItems[newsSelected]
  box.innerHTML = ''
  box.appendChild(el('h3', {}, newsSelected === 0 ? 'Entry 1 (shown first)' : `Entry ${newsSelected + 1}`))

  const field = (label, node) => {
    const w = el('div', { className: 'field' })
    w.appendChild(el('label', {}, esc(label)))
    w.appendChild(node)
    return w
  }
  const title = el('input', { id: 'ne-title', type: 'text', value: item.title || '' })
  const tag   = el('input', { id: 'ne-tag',   type: 'text', value: item.tag || 'UPDATE', placeholder: 'UPDATE' })
  const date  = el('input', { id: 'ne-date',  type: 'text', value: item.date || newsToday, placeholder: newsToday })
  const body  = el('textarea', { id: 'ne-body', rows: 5 })
  body.value = item.body || ''
  box.appendChild(field('Title', title))
  const row2 = el('div', { className: 'row' })
  const tagW = field('Tag', tag); tagW.classList.add('grow')
  const dateW = field('Date (shown verbatim)', date); dateW.classList.add('grow')
  row2.appendChild(tagW); row2.appendChild(dateW)
  box.appendChild(row2)
  box.appendChild(field('Body', body))

  // Image: preview + picker
  const imgWrap = el('div', { className: 'field' })
  imgWrap.appendChild(el('label', {}, 'Image (.gif from the images folder)'))
  const preview = el('div', { className: 'news-preview' })
  const paint = () => {
    preview.innerHTML = ''
    const src = newsPreviewSrc(item.image)
    if (src) preview.appendChild(el('img', { src, alt: '' }))
    else preview.appendChild(el('span', { className: 'muted' }, item.image ? esc(item.image) + ' (preview unavailable)' : 'No image'))
    preview.appendChild(el('div', { className: 'muted small-text' }, esc(item.image || '')))
  }
  paint()
  imgWrap.appendChild(preview)
  const imgRow = el('div', { className: 'row' })
  const choose = el('button', { className: 'action small' }, 'Choose image…')
  choose.addEventListener('click', () => openImagePicker(url => { item.image = url; paint() }))
  const clear = el('button', { className: 'action small' }, 'No image')
  clear.addEventListener('click', () => { delete item.image; paint() })
  imgRow.appendChild(choose); imgRow.appendChild(clear)
  imgWrap.appendChild(imgRow)
  box.appendChild(imgWrap)

  const saveRow = el('div', { className: 'row' })
  const save = el('button', { className: 'action go' }, 'Save entry')
  save.addEventListener('click', () => {
    item.title = title.value
    item.tag = tag.value
    item.date = date.value
    item.body = body.value
    saveNews()
  })
  const del = el('button', { className: 'action small stop' }, 'Delete entry')
  armConfirm(del, 'Delete entry', async () => {
    newsItems.splice(newsSelected, 1)
    await saveNews(-1)
  })
  saveRow.appendChild(save)
  saveRow.appendChild(del)
  box.appendChild(saveRow)
  box.appendChild(el('small', {}, 'The launcher shows: tag badge, title, body, date, image. Gifs animate in the launcher; images live in skymp5-backend/public/images and are served at /images/… by the backend.'))
}

$('#news-add').addEventListener('click', () => {
  newsItems.unshift({ title: '', body: '', date: newsToday, tag: 'UPDATE' })
  newsSelected = 0
  renderNewsList()
  renderNewsEditor()
  newsStatus('New entry - fill it in and click “Save entry”.')
  $('#ne-title')?.focus()
})
$('#news-refresh').addEventListener('click', () => { loadNews(newsSelected); newsStatus('') })

// Image picker modal: grid of the images folder, gifs first.
let imPickCb = null
async function openImagePicker(cb) {
  imPickCb = cb
  $('#im-status').textContent = ''
  $('#img-modal').hidden = false
  await paintImageGrid()
}

async function paintImageGrid(highlightUrl) {
  const grid = $('#im-grid')
  grid.innerHTML = '<p class="muted">Loading…</p>'
  const r = await refreshNewsImages()
  grid.innerHTML = ''
  if (!r.ok) { grid.appendChild(el('p', {}, 'Error: ' + esc(r.error))); return }
  $('#im-dir').textContent = r.dir
  if (!r.images.length) {
    grid.appendChild(el('p', { className: 'muted' }, 'No images in the folder yet - use “Import from disk…”.'))
    return
  }
  for (const img of r.images) {
    const card = el('div', { className: 'img-card' + (img.url === highlightUrl ? ' selected' : '') })
    const th = el('div', { className: 'img-card-thumb' })
    th.appendChild(el('img', { src: 'file:///' + img.file.replace(/\\/g, '/'), alt: esc(img.name) }))
    card.appendChild(th)
    const cap = el('div', { className: 'img-card-name' })
    cap.appendChild(el('span', {}, esc(img.name)))
    if (img.gif) cap.appendChild(el('span', { className: 'badge' }, 'gif'))
    card.appendChild(cap)
    card.addEventListener('click', () => {
      if (imPickCb) imPickCb(img.url)
      closeImagePicker()
    })
    grid.appendChild(card)
  }
}

function closeImagePicker() { $('#img-modal').hidden = true; imPickCb = null }
$('#im-close').addEventListener('click', closeImagePicker)
$('#im-import').addEventListener('click', async () => {
  $('#im-status').textContent = 'importing…'
  const r = await window.mgr.newsImportImage()
  if (r.canceled) { $('#im-status').textContent = ''; return }
  if (!r.ok) { $('#im-status').textContent = 'Error: ' + r.error; return }
  $('#im-status').textContent = `Imported ${r.image.name}`
  await paintImageGrid(r.image.url)
})
let imDownOnBackdrop = false
$('#img-modal').addEventListener('mousedown', e => { imDownOnBackdrop = e.target === $('#img-modal') })
$('#img-modal').addEventListener('click', e => { if (imDownOnBackdrop && e.target === $('#img-modal')) closeImagePicker() })

loadNews()

// ── Players tab ────────────────────────────────────────────────────────────────

let allPlayers = []
let selectedDiscordId = null
let onlineProfileIds = new Set()

async function loadPlayers() {
  const r = await window.mgr.playersList()
  if (!r.ok) { allPlayers = []; $('#players-list').innerHTML = `<li>Error: ${esc(r.error)}</li>`; return }
  allPlayers = r.players
  renderPlayerList()
  refreshOnline()
}

// Poll the gamemode for the currently-online profiles (drives the filter and badge).
async function refreshOnline() {
  const r = await window.mgr.playersOnline()
  onlineProfileIds = r.ok ? new Set(r.profileIds) : new Set()
  renderPlayerList()
}

function renderPlayerList() {
  const ul = $('#players-list')
  const q = $('#player-search').value.trim().toLowerCase()
  let filtered = !q ? allPlayers : allPlayers.filter(p =>
    String(p.name).toLowerCase().includes(q) ||
    String(p.discordId).toLowerCase().includes(q) ||
    (p.characters || []).some(c => String(c).toLowerCase().includes(q)) ||
    String(p.rpCharacter || '').toLowerCase().includes(q))
  const anyOnline = p => (p.profileIds && p.profileIds.length ? p.profileIds : [p.profileId])
    .some(id => onlineProfileIds.has(Number(id)))
  if ($('#players-online-only').checked) filtered = filtered.filter(anyOnline)

  ul.innerHTML = ''
  $('#players-count').textContent = `${filtered.length} / ${allPlayers.length}`
  if (filtered.length === 0) { ul.appendChild(el('li', { className: 'muted' }, q ? 'No matches.' : 'No players yet.')); return }

  for (const p of filtered) {
    const li = el('li')
    if (p.discordId === selectedDiscordId) li.classList.add('selected')
    const main = el('div', { className: 'pl-main' })
    main.appendChild(el('span', { className: 'pl-name' }, esc(p.name)))
    if (anyOnline(p)) main.appendChild(el('span', { className: 'badge online' }, 'online'))
    if (p.whitelisted) main.appendChild(el('span', { className: 'badge' }, 'whitelist'))
    li.appendChild(main)
    const charNames = (p.characters && p.characters.length) ? p.characters : (p.rpCharacter ? [p.rpCharacter] : [])
    const sub = charNames.length
      ? `${charNames.length} char${charNames.length > 1 ? 's' : ''}: ${esc(charNames.join(', '))}`
      : 'no characters'
    li.appendChild(el('div', { className: 'pl-sub' }, sub))
    li.addEventListener('click', () => selectPlayer(p.discordId))
    ul.appendChild(li)
  }
}

async function selectPlayer(discordId) {
  selectedDiscordId = discordId
  renderPlayerList()
  const box = $('#player-detail')
  box.innerHTML = '<p class="muted">Loading…</p>'
  const r = await window.mgr.playersDetail(discordId)
  if (!r.ok) { box.innerHTML = `<p>Error: ${esc(r.error)}</p>`; return }
  const p = r.player

  const factions = r.factions.length
    ? '<ul class="mini">' + r.factions.map(f => `<li>${esc(f.requirement ? `${f.requirement.group || f.requirement.faction || ''} — ${f.requirement.rank ?? ''}` : (f.requirementId || ''))}</li>`).join('') + '</ul>'
    : '<p class="muted">None</p>'
  const charRow = (c, idx) => {
    const badges =
      (onlineProfileIds.has(Number(c.profileId)) ? ' <span class="badge online">online</span>' : '') +
      (c.dead ? ' <span class="badge">dead</span>' : '') +
      (c.disabled ? ' <span class="muted">(disabled)</span>' : '')
    return `<li data-idx="${idx}"><span class="cid">${esc(fmtFormDesc(c.formDesc))}</span><span class="cname">${esc(c.name)}</span>${badges}</li>`
  }
  const charWarn = r.charError ? `<p class="muted">character data unavailable: ${esc(r.charError)}</p>` : ''
  const chars = r.characters.length
    ? '<ul class="char-list">' + r.characters.map(charRow).join('') + '</ul>'
    : '<p class="muted">No characters found in the save store.</p>'

  box.innerHTML =
    `<h3>${esc(p.displayName || p.username || 'Player')}` +
      `${p.whitelisted ? ' <span class="badge">whitelist</span>' : ''}</h3>` +
    `<div class="kv"><b>Discord ID</b><span>${esc(p.discordId)}</span></div>` +
    `<div class="kv"><b>Profile ID</b><span>${esc(p.profileId)}</span></div>` +
    `<div class="kv"><b>Last seen</b><span>${esc(p.lastSeenAt || '—')}</span></div>` +
    `<div class="kv"><b>Created</b><span>${esc(p.createdAt || '—')}</span></div>` +
    `<div class="field"><label>Username</label><input id="pd-username" type="text" value="${esc(p.username)}" /></div>` +
    `<div class="field"><label>Display name</label><input id="pd-displayName" type="text" value="${esc(p.displayName)}" /></div>` +
    `<div class="field"><label>Notes</label><textarea id="pd-notes" rows="3">${esc(p.notes)}</textarea></div>` +
    `<div class="row"><button id="pd-save" class="action go">Save changes</button><span id="pd-status" class="status"></span></div>` +
    `<h4>Factions</h4>${factions}` +
    `<h4>Characters</h4>${charWarn}${chars}` +
    `<small>Player deletion is managed by the backend's own character-deletion flow, not this manager.</small>`

  $('#pd-save').addEventListener('click', async () => {
    const patch = {
      username: $('#pd-username').value,
      displayName: $('#pd-displayName').value,
      notes: $('#pd-notes').value,
    }
    $('#pd-status').textContent = 'saving…'
    const res = await window.mgr.playersUpdate(p.profileId, patch)
    if (!res.ok) { $('#pd-status').textContent = 'Error: ' + res.error; return }
    $('#pd-status').textContent = 'Saved.'
    // Reflect the new name in the list.
    const row = allPlayers.find(x => x.discordId === p.discordId)
    if (row) row.name = patch.displayName || patch.username || row.name
    renderPlayerList()
  })

  $$('#player-detail .char-list li').forEach(li =>
    li.addEventListener('click', () => openCharModal(r.characters[Number(li.dataset.idx)])))
}

// ── Character modal: appearance + inventory editing straight in the store ──────

let cmChar = null      // the character record being edited
let cmEntries = []     // working copy of inventory entries
let cmItemNames = {}   // baseId hex -> display name (resolved by the gamemode)

const cmHex = id => '0x' + Number(id >>> 0).toString(16).toUpperCase()
const fmtFormDesc = fd => String(fd || '').includes(':') ? String(fd) : '0x' + String(fd || '').toUpperCase()
const fmtPct = x => (x === undefined || x === null) ? '—' : Math.round(x * 100) + '%'

function parseHex(text, label) {
  const n = parseInt(String(text).trim().replace(/^0x/i, ''), 16)
  if (!Number.isFinite(n) || n < 0) throw new Error(label + ': bad hex id')
  return n >>> 0
}

// Strict decimal: a typo or emptied field must error, not silently become 0.
function parseNum(text, label) {
  const s = String(text).trim()
  const n = Number(s)
  if (!s || !Number.isFinite(n)) throw new Error(label + ': not a number')
  return n
}

function entryHasExtras(e) {
  for (const k of Object.keys(e)) {
    if (k !== 'baseId' && k !== 'count' && e[k] !== undefined && e[k] !== null && e[k] !== false) return true
  }
  return false
}

function openCharModal(c) {
  if (!c) return
  cmChar = c
  cmEntries = (c.inventory || []).map(e => ({ ...e }))
  cmItemNames = {}
  disarmConfirm($('#cm-delete')) // an armed delete must never carry over to another character
  $('#cm-title').textContent = `${c.name} — ${fmtFormDesc(c.formDesc)}`
  $('#cm-status').textContent = ''
  const pos = c.position ? c.position.map(n => Math.round(n)).join(', ') : '—'
  $('#cm-meta').textContent =
    `${c.worldOrCell || '—'} (${pos}) · HP ${fmtPct(c.health)} · MP ${fmtPct(c.magicka)} · SP ${fmtPct(c.stamina)} · ${c.spellCount} spells`
  renderCmAppearance()
  renderCmInventory()
  $('#char-modal').hidden = false
  fetchItemNames()
}

async function fetchItemNames() {
  const ids = cmEntries.map(e => e.baseId)
  if (!ids.length) return
  const r = await window.mgr.charsItemNames(ids)
  if (!r.ok) { $('#cm-status').textContent = `item names unavailable (${r.error})`; return }
  cmItemNames = r.names || {}
  renderCmInventory()
}

// key, label, kind (text | bool | hex | number | int | hexlist)
const CM_APPEARANCE_FIELDS = [
  ['name', 'Name', 'text'],
  ['isFemale', 'Female', 'bool'],
  ['raceId', 'Race ID', 'hex'],
  ['weight', 'Weight (0-100)', 'number'],
  ['skinColor', 'Skin color (ARGB int)', 'int'],
  ['hairColor', 'Hair color (ARGB int)', 'int'],
  ['headTextureSetId', 'Head texture set', 'hex'],
  ['headpartIds', 'Headparts (hex ids, one per line)', 'hexlist'],
]

function renderCmAppearance() {
  const box = $('#cm-appearance')
  box.innerHTML = ''
  box.appendChild(el('h4', {}, 'Appearance'))
  const a = cmChar.appearance
  if (!a) {
    box.appendChild(el('p', { className: 'muted' }, 'No appearance data on this character.'))
    return
  }
  for (const [key, label, kind] of CM_APPEARANCE_FIELDS) {
    const wrap = el('div', { className: 'sfield' })
    wrap.appendChild(el('label', {}, esc(label)))
    if (kind === 'bool') {
      const sel = el('select', { id: 'cma-' + key, className: 'sinput' })
      for (const [t, v] of [['No', 'false'], ['Yes', 'true']]) {
        const op = el('option', { value: v }, t)
        if (String(!!a[key]) === v) op.selected = true
        sel.appendChild(op)
      }
      wrap.appendChild(sel)
    } else if (kind === 'hexlist') {
      const ta = el('textarea', { id: 'cma-' + key, rows: 5, spellcheck: false })
      ta.value = (Array.isArray(a[key]) ? a[key] : []).map(cmHex).join('\n')
      wrap.appendChild(ta)
    } else {
      const inp = el('input', { id: 'cma-' + key, type: 'text', className: 'sinput' })
      inp.value = kind === 'hex' ? cmHex(a[key] || 0) : String(a[key] ?? '')
      wrap.appendChild(inp)
    }
    box.appendChild(wrap)
  }
  // Full-object escape hatch for options/presets/tints
  const adv = el('details')
  adv.appendChild(el('summary', {}, 'Raw appearance JSON (overrides the fields above when edited)'))
  const ta = el('textarea', { id: 'cma-raw', rows: 10, spellcheck: false })
  ta.value = JSON.stringify(a, null, 2)
  ta.dataset.initial = ta.value
  adv.appendChild(ta)
  box.appendChild(adv)
  const row = el('div', { className: 'row' })
  const save = el('button', { className: 'action go' }, 'Save appearance')
  save.addEventListener('click', saveCmAppearance)
  row.appendChild(save)
  box.appendChild(row)
}

async function saveCmAppearance() {
  try {
    const rawTa = $('#cma-raw')
    let appearance
    if (rawTa && rawTa.value !== rawTa.dataset.initial) {
      appearance = JSON.parse(rawTa.value)
    } else {
      appearance = JSON.parse(JSON.stringify(cmChar.appearance))
      appearance.name = $('#cma-name').value
      appearance.isFemale = $('#cma-isFemale').value === 'true'
      appearance.raceId = parseHex($('#cma-raceId').value, 'Race ID')
      appearance.weight = parseNum($('#cma-weight').value, 'Weight')
      appearance.skinColor = parseNum($('#cma-skinColor').value, 'Skin color') | 0
      appearance.hairColor = parseNum($('#cma-hairColor').value, 'Hair color') | 0
      appearance.headTextureSetId = parseHex($('#cma-headTextureSetId').value, 'Head texture set')
      appearance.headpartIds = $('#cma-headpartIds').value.split(/[\s,]+/).filter(Boolean).map(x => parseHex(x, 'Headparts'))
    }
    $('#cm-status').textContent = 'saving appearance…'
    const r = await window.mgr.charsSave(cmChar.formDesc, { appearance })
    $('#cm-status').textContent = r.ok ? 'Appearance saved.' : `Error: ${r.error}`
    if (r.ok) {
      cmChar.appearance = appearance
      renderCmAppearance() // re-seed the fields and the raw-JSON baseline from the saved state
      if (selectedDiscordId) selectPlayer(selectedDiscordId)
    }
  } catch (err) {
    $('#cm-status').textContent = `Error: ${err.message}`
  }
}

function renderCmInventory() {
  const box = $('#cm-inventory')
  box.innerHTML = ''
  box.appendChild(el('h4', {}, `Inventory (${cmEntries.length} stack${cmEntries.length === 1 ? '' : 's'})`))

  const add = el('div', { className: 'inv-add' })
  const idInp = el('input', { id: 'cmi-id', type: 'text', placeholder: 'form id, e.g. 0xF' })
  const cntInp = el('input', { id: 'cmi-count', type: 'number', value: '1', min: '1' })
  const addBtn = el('button', { className: 'action small' }, 'Add')
  addBtn.addEventListener('click', () => {
    try {
      const baseId = parseHex(idInp.value, 'Form id')
      if (!baseId) throw new Error('Form id: bad hex id')
      const count = Math.max(1, Math.floor(Number(cntInp.value) || 1))
      const stack = cmEntries.find(e => e.baseId === baseId && !entryHasExtras(e))
      if (stack) stack.count += count
      else cmEntries.push({ baseId, count })
      $('#cm-status').textContent = ''
      renderCmInventory()
      fetchItemNames()
    } catch (err) { $('#cm-status').textContent = `Error: ${err.message}` }
  })
  add.appendChild(idInp); add.appendChild(cntInp); add.appendChild(addBtn)
  box.appendChild(add)

  cmEntries.forEach((e, i) => {
    const row = el('div', { className: 'inv-row' })
    row.appendChild(el('span', { className: 'iid' }, esc(cmHex(e.baseId))))
    const name = cmItemNames[(e.baseId >>> 0).toString(16)] || ''
    const extras = entryHasExtras(e) ? ` <span class="badge" title="${esc(JSON.stringify(e))}">extras</span>` : ''
    row.appendChild(el('span', { className: 'iname' }, esc(name) + extras))
    const cnt = el('input', { type: 'number', className: 'icount', value: String(e.count), min: '0' })
    cnt.addEventListener('change', () => { e.count = Math.max(0, Math.floor(Number(cnt.value) || 0)) })
    row.appendChild(cnt)
    const rm = el('button', { className: 'action small stop', title: 'Remove' }, '✕')
    rm.addEventListener('click', () => { cmEntries.splice(i, 1); renderCmInventory() })
    row.appendChild(rm)
    box.appendChild(row)
  })

  const rowB = el('div', { className: 'row' })
  const save = el('button', { className: 'action go' }, 'Save inventory')
  save.addEventListener('click', saveCmInventory)
  rowB.appendChild(save)
  box.appendChild(rowB)
}

async function saveCmInventory() {
  $('#cm-status').textContent = 'saving inventory…'
  const entries = cmEntries.filter(e => e.count > 0)
  const r = await window.mgr.charsSave(cmChar.formDesc, { invEntries: entries })
  $('#cm-status').textContent = r.ok ? 'Inventory saved.' : `Error: ${r.error}`
  if (r.ok) {
    cmEntries = entries.map(e => ({ ...e }))
    renderCmInventory()
    if (selectedDiscordId) selectPlayer(selectedDiscordId)
  }
}

function closeCharModal() { $('#char-modal').hidden = true; cmChar = null }
$('#cm-close').addEventListener('click', closeCharModal)
armConfirm($('#cm-delete'), 'Delete character', async () => {
  if (!cmChar) return
  $('#cm-status').textContent = 'deleting…'
  const r = await window.mgr.charsDelete(cmChar.formDesc)
  if (!r.ok) { $('#cm-status').textContent = `Error: ${r.error}`; return }
  closeCharModal()
  loadPlayers()
  if (selectedDiscordId) selectPlayer(selectedDiscordId)
})
// Close only on a true backdrop click: a drag that starts in an input and ends
// on the backdrop fires click on the overlay too, and must not eat edits.
let cmDownOnBackdrop = false
$('#char-modal').addEventListener('mousedown', e => { cmDownOnBackdrop = e.target === $('#char-modal') })
$('#char-modal').addEventListener('click', e => { if (cmDownOnBackdrop && e.target === $('#char-modal')) closeCharModal() })

$('#players-refresh').addEventListener('click', loadPlayers)
$('#player-search').addEventListener('input', renderPlayerList)
$('#players-online-only').addEventListener('change', renderPlayerList)
loadPlayers()
setInterval(refreshOnline, 10000)

// ── Build tab ──────────────────────────────────────────────────────────────────

function refreshLauncherVersion() {
  window.mgr.launcherGetVersion().then(r => {
    if (r.version) $('#launcher-version').value = r.version
    if (r.mismatch) appendLog($('#build-log'), `\nNote: launcher version mismatch - ${r.mismatch}. Saving the field re-aligns all three.\n`)
  })
}
refreshLauncherVersion()

function refreshFilesVersion() {
  window.mgr.filesGetVersion().then(r => {
    const box = $('#files-version')
    if (!r.ok) { box.textContent = 'files-version.json unavailable: ' + r.error; return }
    const built = r.builtAt ? new Date(r.builtAt).toLocaleString() : '—'
    const size = r.zipSize ? (r.zipSize / 1048576).toFixed(0) + ' MB' : '—'
    box.textContent = `version ${r.version} · built ${built} · ${r.fileCount ?? '?'} files · ${size}`
  })
}
refreshFilesVersion()

async function refreshGamemodeStatus() {
  const box = $('#gm-status')
  const st = await window.mgr.gamemodeStatus()
  if (!st.ok) { box.textContent = 'status unavailable: ' + st.error; return }
  const bits = [`${st.same.length} in sync`]
  if (st.differs.length) bits.push(`${st.differs.length} differ`)
  if (st.repoOnly.length) bits.push(`${st.repoOnly.length} repo-only`)
  if (st.serverOnly.length) bits.push(`${st.serverOnly.length} server-only (kept)`)
  box.textContent = bits.join(' · ')
  box.title = [
    st.differs.length ? 'differs: ' + st.differs.join(', ') : '',
    st.repoOnly.length ? 'repo-only: ' + st.repoOnly.join(', ') : '',
    st.serverOnly.length ? 'server-only: ' + st.serverOnly.join(', ') : '',
  ].filter(Boolean).join('\n')
}
refreshGamemodeStatus()
$('#gm-refresh').addEventListener('click', refreshGamemodeStatus)

$('#launcher-save').addEventListener('click', async () => {
  const r = await window.mgr.launcherSetVersion($('#launcher-version').value)
  appendLog($('#build-log'), r.ok ? `\nLauncher version saved. ${r.note || ''}\n` : '\nError: ' + r.error + '\n')
})

// Build buttons disable together while one runs (main enforces one at a time too).
function wireBuild(btnId, fn, label, after) {
  $(btnId).addEventListener('click', async () => {
    const buttons = $$('#build .action.go')
    buttons.forEach(b => b.disabled = true)
    appendLog($('#build-log'), `\n######## ${label} ########\n`)
    const r = await fn()
    appendLog($('#build-log'), r.ok ? `\n✓ ${label} complete.\n` : `\n✗ ${label} failed: ${r.error}\n`)
    buttons.forEach(b => b.disabled = false)
    if (after) after(r)
  })
}
wireBuild('#build-server',   () => window.mgr.buildServer(),   'Game server build & deploy')
wireBuild('#build-launcher', () => window.mgr.buildLauncher(), 'Launcher build')
wireBuild('#build-client',   () => window.mgr.buildClient(),   'Client files build', refreshFilesVersion)

// Sync is semi-destructive (overwrites live gamemode files) - armed confirm.
armConfirm($('#gm-sync'), 'Sync to server', async () => {
  const buttons = $$('#build .action.go')
  buttons.forEach(b => b.disabled = true)
  appendLog($('#build-log'), '\n######## Gamemode sync ########\n')
  const r = await window.mgr.gamemodeSync()
  appendLog($('#build-log'), r.ok ? '\n✓ Gamemode sync complete.\n' : `\n✗ Gamemode sync failed: ${r.error}\n`)
  buttons.forEach(b => b.disabled = false)
  refreshGamemodeStatus()
})

// ── Modlist tab ────────────────────────────────────────────────────────────────

$('#modlist-refresh').addEventListener('click', async () => {
  const r = await window.mgr.modlistRead()
  const box = $('#modlist-summary')
  box.innerHTML = ''
  if (!r.ok) { box.appendChild(el('div', { className: 'card' }, esc(r.error))); return }
  const card = (n, l) => { const c = el('div', { className: 'card' }); c.appendChild(el('div', { className: 'n' }, String(n))); c.appendChild(el('div', { className: 'l' }, l)); return c }
  box.appendChild(card(r.mods.length, 'mods'))
  box.appendChild(card(r.separators.length, 'separators'))
  box.appendChild(card(r.plugins.length, 'plugins'))
  const list = el('div', { className: 'card' })
  list.appendChild(el('div', { className: 'l' }, 'Enabled mods'))
  const ul = el('ul')
  r.mods.slice(0, 400).forEach(m => ul.appendChild(el('li', {}, esc(m))))
  list.appendChild(ul)
  box.appendChild(list)
})
$('#modlist-update').addEventListener('click', async e => {
  e.target.disabled = true
  $('#modlist-log').textContent = ''
  const r = await window.mgr.modlistUpdateManifest()
  appendLog($('#modlist-log'), r.ok ? '\nManifest updated. Restart the backend to serve it.\n' : `\nFailed: ${r.error}\n`)
  e.target.disabled = false
})

// ── Settings tab ───────────────────────────────────────────────────────────────

let SCHEMA = { serverSettings: [], backendEnv: [] }
let settingsKey = 'serverSettings'
let currentValues = {}

window.mgr.settingsSchema().then(s => { SCHEMA = s; loadSettings() })

$$('.subtab').forEach(sub => {
  sub.addEventListener('click', () => {
    $$('.subtab').forEach(s => s.classList.remove('active'))
    sub.classList.add('active')
    settingsKey = sub.dataset.cfg
    loadSettings()
  })
})

async function loadSettings() {
  const form = $('#settings-form')
  const st = $('#settings-status')
  st.textContent = 'loading…'
  form.innerHTML = ''
  const r = await window.mgr.settingsRead(settingsKey)
  if (!r.ok) { st.textContent = `Error: ${r.error}` + (r.path ? ` (${r.path})` : ''); return }
  currentValues = r.values || {}
  st.textContent = r.path + (r.seeded ? '  (new — seeded from .env.example)' : '')
  renderSettingsForm(r.extra)
}

function renderSettingsForm(extra) {
  const form = $('#settings-form')
  form.innerHTML = ''
  const fields = SCHEMA[settingsKey] || []
  const groups = []
  const byGroup = {}
  for (const f of fields) {
    if (!byGroup[f.group]) { byGroup[f.group] = []; groups.push(f.group) }
    byGroup[f.group].push(f)
  }

  for (const group of groups) {
    const fs = el('fieldset', { className: 'sgroup' })
    fs.appendChild(el('legend', {}, esc(group)))
    for (const f of byGroup[group]) fs.appendChild(renderField(f))
    form.appendChild(fs)
  }

  // server-settings.json
  if (settingsKey === 'serverSettings') {
    const fs = el('fieldset', { className: 'sgroup' })
    fs.appendChild(el('legend', {}, 'Other (raw JSON)'))
    const wrap = el('div', { className: 'sfield wide' })
    wrap.appendChild(el('label', {}, 'Keys without a dedicated field'))
    const ta = el('textarea', { id: 'settings-extra', rows: 6, spellcheck: false })
    ta.value = extra && Object.keys(extra).length ? JSON.stringify(extra, null, 2) : '{}'
    wrap.appendChild(ta)
    fs.appendChild(wrap)
    form.appendChild(fs)
  }
}

function renderField(f) {
  const wrap = el('div', { className: 'sfield' + (f.type === 'json' ? ' wide' : '') })
  const id = 'set-' + f.key
  wrap.appendChild(el('label', { htmlFor: id }, esc(f.label)))
  const val = currentValues[f.key]

  if (f.type === 'bool') {
    const on = (settingsKey === 'backendEnv') ? String(val).toLowerCase() === 'true' : val === true
    const group = el('div', { className: 'radio-group', id })
    for (const opt of [['On', true], ['Off', false]]) {
      const lbl = el('label', { className: 'radio' })
      const radio = el('input', { type: 'radio', name: id, value: String(opt[1]) })
      if (val !== undefined && opt[1] === on) radio.checked = true
      lbl.appendChild(radio)
      lbl.appendChild(document.createTextNode(' ' + opt[0]))
      group.appendChild(lbl)
    }
    wrap.appendChild(group)
  } else if (f.type === 'select') {
    const sel = el('select', { id, className: 'sinput' })
    const cur = val == null ? '' : String(val)
    const opts = f.options.includes(cur) || cur === '' ? f.options : [cur, ...f.options]
    sel.appendChild(el('option', { value: '' }, '—'))
    for (const o of opts) { const op = el('option', { value: o }, esc(o)); if (o === cur) op.selected = true; sel.appendChild(op) }
    wrap.appendChild(sel)
  } else if (f.type === 'json') {
    const ta = el('textarea', { id, className: 'sinput', rows: 4, spellcheck: false })
    ta.value = val === undefined ? '' : JSON.stringify(val, null, 2)
    wrap.appendChild(ta)
  } else if (f.type === 'secret') {
    const row = el('div', { className: 'secret-row' })
    const inp = el('input', { id, type: 'password', className: 'sinput', value: val == null ? '' : String(val) })
    const toggle = el('button', { type: 'button', className: 'action small reveal' }, 'show')
    toggle.addEventListener('click', () => {
      inp.type = inp.type === 'password' ? 'text' : 'password'
      toggle.textContent = inp.type === 'password' ? 'show' : 'hide'
    })
    row.appendChild(inp); row.appendChild(toggle)
    wrap.appendChild(row)
  } else {
    const inp = el('input', { id, type: f.type === 'number' ? 'number' : 'text', className: 'sinput',
      value: val == null ? '' : String(val), placeholder: f.placeholder || '' })
    wrap.appendChild(inp)
  }

  if (f.help) wrap.appendChild(el('small', {}, esc(f.help)))
  return wrap
}

function collectSettings() {
  const values = {}
  for (const f of (SCHEMA[settingsKey] || [])) {
    const id = 'set-' + f.key
    if (f.type === 'bool') {
      const checked = document.querySelector(`input[name="${id}"]:checked`)
      if (checked) values[f.key] = checked.value === 'true'
    } else {
      const node = document.getElementById(id)
      if (node) values[f.key] = node.value
    }
  }
  return values
}

$('#settings-reload').addEventListener('click', loadSettings)
$('#settings-save').addEventListener('click', async () => {
  const values = collectSettings()
  const extra = settingsKey === 'serverSettings' ? ($('#settings-extra')?.value || '') : undefined
  $('#settings-status').textContent = 'saving…'
  const r = await window.mgr.settingsWrite(settingsKey, values, extra)
  $('#settings-status').textContent = r.ok ? `Saved ${r.path}` : `Error: ${r.error}`
})
