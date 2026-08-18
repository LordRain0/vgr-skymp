// Window controls
document.getElementById('btn-minimize').addEventListener('click', () => window.electronAPI.minimize())
document.getElementById('btn-maximize').addEventListener('click', () => window.electronAPI.maximize())
document.getElementById('btn-close').addEventListener('click',    () => window.electronAPI.close())

// External nav links
const EXTERNAL_URLS = {
  patreon: 'https://www.patreon.com/cw/VengefulRealmsRP/membership',
  discord: 'https://discord.gg/Rj82XPsTuB',
}

document.querySelectorAll('[data-href]').forEach(link => {
  link.addEventListener('click', () => {
    const url = EXTERNAL_URLS[link.dataset.href]
    if (url) window.electronAPI.openExternal(url)
  })
})

// Sidebar section navigation (Play / Realms / Mod Pack / Notices)
const navItems = document.querySelectorAll('.nav-item[data-section]')
navItems.forEach(item => {
  item.addEventListener('click', () => {
    navItems.forEach(n => n.classList.toggle('active', n === item))
    document.querySelectorAll('.section-panel').forEach(p => {
      p.classList.toggle('active', p.id === `section-${item.dataset.section}`)
    })
  })
})

// Settings modal
const modalOverlay = document.getElementById('modal-settings')

function openModal() { modalOverlay.hidden = false; loadGameSettingsTab() }
function closeModal() { endCapture(true); modalOverlay.hidden = true }

document.getElementById('btn-gear').addEventListener('click', openModal)
document.getElementById('modal-close').addEventListener('click', closeModal)
modalOverlay.addEventListener('click', e => { if (e.target === modalOverlay) closeModal() })

// Settings tabs
document.querySelectorAll('.modal-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.modal-tab').forEach(t => t.classList.remove('active'))
    document.querySelectorAll('.tab-panel').forEach(p => { p.hidden = true })
    tab.classList.add('active')
    document.getElementById(`tab-${tab.dataset.tab}`).hidden = false
  })
})

// Settings tab: graphics + server hotkeys
// KeyboardEvent.code -> [DirectInput scan code, label].
// DIK codes must match DxScanCode in the Skyrim Platform client.
const KEY_TABLE = {
  Enter: [28, 'Enter'], Space: [57, 'Space'], Tab: [15, 'Tab'],
  ShiftLeft: [42, 'Left Shift'], ControlLeft: [29, 'Left Ctrl'], AltLeft: [56, 'Left Alt'],
  ShiftRight: [54, 'Right Shift'], ControlRight: [157, 'Right Ctrl'], AltRight: [184, 'Right Alt'],
  CapsLock: [58, 'Caps Lock'], Backquote: [41, 'Grave (~)'], Backspace: [14, 'Backspace'],
  KeyA: [30, 'A'], KeyB: [48, 'B'], KeyC: [46, 'C'], KeyD: [32, 'D'],
  KeyE: [18, 'E'], KeyF: [33, 'F'], KeyG: [34, 'G'], KeyH: [35, 'H'],
  KeyI: [23, 'I'], KeyJ: [36, 'J'], KeyK: [37, 'K'], KeyL: [38, 'L'],
  KeyM: [50, 'M'], KeyN: [49, 'N'], KeyO: [24, 'O'], KeyP: [25, 'P'],
  KeyQ: [16, 'Q'], KeyR: [19, 'R'], KeyS: [31, 'S'], KeyT: [20, 'T'],
  KeyU: [22, 'U'], KeyV: [47, 'V'], KeyW: [17, 'W'], KeyX: [45, 'X'],
  KeyY: [21, 'Y'], KeyZ: [44, 'Z'],
  Digit1: [2, '1'], Digit2: [3, '2'], Digit3: [4, '3'], Digit4: [5, '4'], Digit5: [6, '5'],
  Digit6: [7, '6'], Digit7: [8, '7'], Digit8: [9, '8'], Digit9: [10, '9'], Digit0: [11, '0'],
  Minus: [12, '-'], Equal: [13, '='],
  BracketLeft: [26, '['], BracketRight: [27, ']'],
  Semicolon: [39, ';'], Quote: [40, "'"], Backslash: [43, '\\'],
  Comma: [51, ','], Period: [52, '.'], Slash: [53, '/'],
  F1: [59, 'F1'], F2: [60, 'F2'], F3: [61, 'F3'], F4: [62, 'F4'],
  F5: [63, 'F5'], F6: [64, 'F6'], F7: [65, 'F7'], F8: [66, 'F8'],
  F9: [67, 'F9'], F10: [68, 'F10'], F11: [87, 'F11'], F12: [88, 'F12'],
  Numpad0: [82, 'Numpad 0'], Numpad1: [79, 'Numpad 1'], Numpad2: [80, 'Numpad 2'],
  Numpad3: [81, 'Numpad 3'], Numpad4: [75, 'Numpad 4'], Numpad5: [76, 'Numpad 5'],
  Numpad6: [77, 'Numpad 6'], Numpad7: [71, 'Numpad 7'], Numpad8: [72, 'Numpad 8'],
  Numpad9: [73, 'Numpad 9'],
  NumpadMultiply: [55, 'Numpad *'], NumpadSubtract: [74, 'Numpad -'], NumpadAdd: [78, 'Numpad +'],
  NumpadDecimal: [83, 'Numpad .'], NumpadDivide: [181, 'Numpad /'], NumpadEnter: [156, 'Numpad Enter'],
  NumLock: [69, 'Num Lock'], ScrollLock: [70, 'Scroll Lock'], Pause: [197, 'Pause'], PrintScreen: [183, 'Print Screen'],
  ArrowUp: [200, 'Up'], ArrowDown: [208, 'Down'], ArrowLeft: [203, 'Left'], ArrowRight: [205, 'Right'],
  PageUp: [201, 'Page Up'], PageDown: [209, 'Page Down'],
  Insert: [210, 'Insert'], Delete: [211, 'Delete'], Home: [199, 'Home'], End: [207, 'End'],
  MetaLeft: [219, 'Left Win'], MetaRight: [220, 'Right Win'], ContextMenu: [221, 'Menu'],
}
const DIK_LABELS = {}
for (const [dik, label] of Object.values(KEY_TABLE)) DIK_LABELS[dik] = label

const RESOLUTIONS = ['1280x720', '1366x768', '1600x900', '1920x1080', '2560x1080', '2560x1440', '3440x1440', '3840x2160']

function labelForCode(code) {
  if (!code) return '— none —'
  if (code === 0xff) return 'Not bound' // controlmap sentinel for an unmapped key
  return DIK_LABELS[code] || `0x${code.toString(16)}`
}
function setKey(id, code) {
  const el = document.getElementById(id)
  if (!el) return
  const c = typeof code === 'number' ? code : 0
  el.dataset.code = String(c)
  el.textContent = labelForCode(c)
}
function getKey(id) { const el = document.getElementById(id); return el ? (parseInt(el.dataset.code, 10) || 0) : 0 }

// Per-row defaults; the Reset button restores these, and load falls back to them.
// Backspace-unbind is not allowed: every server hotkey keeps a binding.
const HK_DEFAULTS = {
  'hk-voice-ptt': 47,  // V
  'hk-voice-mode': 58, // Caps Lock
  'hk-admin': 61,      // F3
  'hk-social': 34,     // G
  'hk-emote': 48,      // B
  'hk-skills': 37,     // K
  'hk-interact': 45,   // X
}

// Game hotkey button ids -> controlmap event names
const GHK_MAP = {
  'ghk-activate': 'Activate', 'ghk-jump': 'Jump', 'ghk-sprint': 'Sprint',
  'ghk-sneak': 'Sneak', 'ghk-shout': 'Shout', 'ghk-pov': 'Toggle POV',
}
const GFX_INPUT_IDS = [
  'gfx-windowmode', 'gfx-resolution', 'gfx-texquality', 'gfx-aa', 'gfx-shadowquality',
  'gfx-decals', 'gfx-reflections', 'gfx-godrays', 'gfx-lensflare', 'gfx-ao', 'gfx-precip',
]

function setInputsDisabled(ids, disabled) {
  for (const id of ids) { const el = document.getElementById(id); if (el) el.disabled = !!disabled }
}

// Press-to-bind capture
let activeCapture = null

function endCapture(restorePrev) {
  if (!activeCapture) return
  const { btn, prevCode, onKey, timer } = activeCapture
  activeCapture = null
  if (timer) clearTimeout(timer)
  window.removeEventListener('keydown', onKey, { capture: true })
  btn.classList.remove('hotkey-btn--capturing')
  if (restorePrev) setKey(btn.id, prevCode)
  btn.blur()
}

function startCapture(btn, canUnbind) {
  endCapture(true)
  const prompt = canUnbind ? 'Press a key… (Esc cancels, Backspace unbinds)' : 'Press a key… (Esc cancels)'
  const onKey = (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.code === 'Escape') { endCapture(true); return }
    if (canUnbind && e.code === 'Backspace') { endCapture(false); setKey(btn.id, 0); return }
    const entry = KEY_TABLE[e.code]
    if (!entry) {
      if (activeCapture.timer) clearTimeout(activeCapture.timer)
      btn.textContent = 'Unsupported key'
      activeCapture.timer = setTimeout(() => { if (activeCapture) btn.textContent = prompt }, 1000)
      return
    }
    endCapture(false)
    setKey(btn.id, entry[0])
  }
  btn.classList.add('hotkey-btn--capturing')
  btn.textContent = prompt
  window.addEventListener('keydown', onKey, { capture: true })
  activeCapture = { btn, prevCode: getKey(btn.id), onKey, timer: null }
}

Object.keys(HK_DEFAULTS).forEach(id => {
  const btn = document.getElementById(id)
  if (!btn) return
  setKey(id, HK_DEFAULTS[id])
  btn.addEventListener('click', () => startCapture(btn, false))
})
// Game hotkey rows: no unbind either; gameHotkeys:save drops code 0, so an
// unbound game key would silently keep its old binding.
Object.keys(GHK_MAP).forEach(id => {
  const btn = document.getElementById(id)
  if (!btn) return
  setKey(id, 0)
  btn.addEventListener('click', () => startCapture(btn, false))
})
document.querySelectorAll('.hotkey-reset').forEach(btn => {
  btn.addEventListener('click', () => {
    const id = btn.dataset.reset
    if (activeCapture && activeCapture.btn.id === id) endCapture(false)
    if (id in HK_DEFAULTS) setKey(id, HK_DEFAULTS[id])
  })
})
window.addEventListener('blur', () => endCapture(true))

async function loadGameSettingsTab() {
  try {
    const g = await window.electronAPI.graphicsLoad()
    if (g && g.ok) {
      const wm = document.getElementById('gfx-windowmode'); if (wm) wm.value = g.windowMode || 'windowed'
      const resSel = document.getElementById('gfx-resolution')
      if (resSel) {
        const cur = (g.width && g.height) ? `${g.width}x${g.height}` : ''
        const list = RESOLUTIONS.slice()
        if (cur && !list.includes(cur)) list.unshift(cur)
        resSel.innerHTML = ''
        for (const r of list) { const o = document.createElement('option'); o.value = r; o.textContent = r; resSel.appendChild(o) }
        if (cur) resSel.value = cur
      }
      const iy = document.getElementById('gfx-invert-y'); if (iy) iy.checked = !!g.invertY
      const setVal = (id, v) => { const el = document.getElementById(id); if (el && v) el.value = v }
      const setChk = (id, v) => { const el = document.getElementById(id); if (el) el.checked = !!v }
      setVal('gfx-texquality', g.texQuality)
      setVal('gfx-aa', g.aa)
      setVal('gfx-shadowquality', g.shadowQuality)
      setVal('gfx-decals', g.decals)
      setVal('gfx-reflections', g.reflections)
      setChk('gfx-godrays', g.godrays)
      setChk('gfx-lensflare', g.lensFlare)
      setChk('gfx-ao', g.ao)
      setChk('gfx-precip', g.precip)
      // Rows stay greyed until the profile ini exists (seeded on install).
      setInputsDisabled(GFX_INPUT_IDS, !g.exists)
      const hint = document.getElementById('gfx-path-hint')
      if (hint) hint.textContent = g.exists ? `Editing: ${g.path}` : `Will be created on save: ${g.path}`
    }
    const gh = await window.electronAPI.gameHotkeysLoad()
    const ghkEditable = !!(gh && gh.ok && gh.hasGamePath)
    setInputsDisabled(Object.keys(GHK_MAP), !ghkEditable)
    if (gh && gh.ok) {
      for (const [id, ev] of Object.entries(GHK_MAP)) {
        const code = gh.keys ? gh.keys[ev] : null
        // 0xff (unmapped) passes the guard and renders as "Not bound".
        if (typeof code === 'number' && code > 0 && code <= 0xff) setKey(id, code)
      }
    }
    const h = await window.electronAPI.hotkeysLoad()
    if (h && h.ok) {
      setKey('hk-voice-ptt', h.voicePtt != null ? h.voicePtt : HK_DEFAULTS['hk-voice-ptt'])
      setKey('hk-voice-mode', h.voiceModeCycle != null ? h.voiceModeCycle : HK_DEFAULTS['hk-voice-mode'])
      setKey('hk-admin', h.adminMenu != null ? h.adminMenu : HK_DEFAULTS['hk-admin'])
      setKey('hk-social', h.social != null ? h.social : HK_DEFAULTS['hk-social'])
      setKey('hk-emote', h.emote != null ? h.emote : HK_DEFAULTS['hk-emote'])
      setKey('hk-skills', h.skills != null ? h.skills : HK_DEFAULTS['hk-skills'])
      setKey('hk-interact', h.interact != null ? h.interact : HK_DEFAULTS['hk-interact'])
    }
  } catch (err) { /* settings tab is best-effort */ }
}

async function saveGameSettingsTab() {
  try {
    const wm = document.getElementById('gfx-windowmode')
    const resSel = document.getElementById('gfx-resolution')
    let width = '', height = ''
    if (resSel && /^\d+x\d+$/.test(resSel.value)) { const p = resSel.value.split('x'); width = p[0]; height = p[1] }
    const iy = document.getElementById('gfx-invert-y')
    const invertY = !!(iy && iy.checked)
    if (wm && !wm.disabled) {
      const val = (id) => { const el = document.getElementById(id); return el ? el.value : '' }
      const chk = (id) => { const el = document.getElementById(id); return !!(el && el.checked) }
      await window.electronAPI.graphicsSave({
        windowMode: wm ? wm.value : 'windowed',
        width, height,
        invertY,
        texQuality:    val('gfx-texquality'),
        aa:            val('gfx-aa'),
        shadowQuality: val('gfx-shadowquality'),
        decals:        val('gfx-decals'),
        reflections:   val('gfx-reflections'),
        godrays:       chk('gfx-godrays'),
        lensFlare:     chk('gfx-lensflare'),
        ao:            chk('gfx-ao'),
        precip:        chk('gfx-precip'),
      })
    } else {
      // Invert-Y lives in the always-enabled Game Hotkeys block: save it even
      // while the graphics rows are locked, without touching graphics keys.
      await window.electronAPI.graphicsSave({ invertY })
    }
    const ghkFirst = document.getElementById('ghk-activate')
    if (ghkFirst && !ghkFirst.disabled) {
      const keys = {}
      for (const [id, ev] of Object.entries(GHK_MAP)) {
        const code = getKey(id)
        if (code > 0) keys[ev] = code
      }
      await window.electronAPI.gameHotkeysSave(keys)
    }
    await window.electronAPI.hotkeysSave({
      voicePtt:       getKey('hk-voice-ptt') || HK_DEFAULTS['hk-voice-ptt'],
      voiceModeCycle: getKey('hk-voice-mode') || HK_DEFAULTS['hk-voice-mode'],
      adminMenu:      getKey('hk-admin') || HK_DEFAULTS['hk-admin'],
      social:         getKey('hk-social') || HK_DEFAULTS['hk-social'],
      emote:          getKey('hk-emote') || HK_DEFAULTS['hk-emote'],
      skills:         getKey('hk-skills') || HK_DEFAULTS['hk-skills'],
      interact:       getKey('hk-interact') || HK_DEFAULTS['hk-interact'],
    })
  } catch (err) { /* best-effort */ }
}

// Form fields
const fieldSkyrimPath   = document.getElementById('setting-skyrim-path')

// Realm selector - topbar title/dropdown + the Realms section cards
const footerServerName   = document.getElementById('footer-server-name')
const footerServerSelect = document.getElementById('footer-server-select')
const serverGrid         = document.getElementById('server-grid')

let knownServers = []

footerServerSelect.addEventListener('change', () => {
  selectServer(parseInt(footerServerSelect.value, 10))
})

// Persist the selection and sync every widget that shows it, then re-pull
// the info panels for the newly selected realm.
async function selectServer(idx) {
  await window.electronAPI.saveSettings({ activeServerIndex: idx })

  serverGrid.querySelectorAll('.server-card').forEach((c, i) => {
    c.classList.toggle('selected', i === idx)
  })
  if (!footerServerSelect.hidden) footerServerSelect.value = String(idx)
  if (knownServers[idx]) footerServerName.textContent = knownServers[idx].name || `Realm ${idx + 1}`

  loadServerInfo()
  checkServerStatus()
  refreshPlayState()
}

// Realm cards (Realms section) - built from the backend server list
const SERVER_CARD_ICONS = ['world.svg', 'world-rune.svg', 'shield.svg', 'forge.svg']

function renderServerCards(servers, activeIndex) {
  knownServers = servers || []
  serverGrid.innerHTML = ''

  if (knownServers.length === 0) {
    const empty = document.createElement('div')
    empty.className   = 'panel-empty'
    empty.textContent = 'No realms available - check your connection.'
    serverGrid.appendChild(empty)
    return
  }

  knownServers.forEach((srv, i) => {
    const card = document.createElement('article')
    card.className = 'server-card' + (i === activeIndex ? ' selected' : '')

    const icon = document.createElement('div')
    icon.className = 'server-card-icon'
    const img = document.createElement('img')
    img.src = `../../assets/icons/${SERVER_CARD_ICONS[i % SERVER_CARD_ICONS.length]}`
    img.alt = ''
    icon.appendChild(img)

    const meta = document.createElement('div')
    meta.className = 'server-meta'
    const title = document.createElement('h4')
    title.textContent = srv.name || `Realm ${i + 1}`
    const sub = document.createElement('span')
    sub.textContent = srv.address
      ? `${srv.address}${srv.port ? ':' + srv.port : ''}`
      : 'Vengeful Realms server'
    meta.appendChild(title)
    meta.appendChild(sub)

    const status = document.createElement('div')
    if (srv.online != null) {
      status.className   = 'server-status online'
      status.textContent = 'Online'
    } else {
      status.className   = 'server-status'
      status.textContent = 'Unknown'
    }

    const details = document.createElement('div')
    details.className = 'server-details'
    const players = document.createElement('span')
    players.textContent = srv.online != null
      ? `Players ${srv.online} / ${srv.maxPlayers ?? '?'}`
      : (srv.maxPlayers ? `Max ${srv.maxPlayers} players` : 'No data yet')
    const portEl = document.createElement('span')
    portEl.textContent = srv.port ? `Port ${srv.port}` : ''
    details.appendChild(players)
    details.appendChild(portEl)

    card.appendChild(icon)
    card.appendChild(meta)
    card.appendChild(status)
    card.appendChild(details)
    card.addEventListener('click', () => selectServer(i))
    serverGrid.appendChild(card)
  })
}

// MO2 fields
const fieldMo2Enabled = document.getElementById('setting-mo2-enabled')
const mo2StatusDot    = document.getElementById('mo2-status-dot')
const mo2StatusText   = document.getElementById('mo2-status-text')

// Discord auth state (kept in module scope for PLAY check)
let discordUser         = null
let serverLocked        = false
// Whether the current user is allowed to join (session-aware: set after login
// by re-fetching /api/serverinfo with X-Session).  Defaults true so unauthed
// users are not blocked before they have a chance to log in.
let serverAllowed       = true

// Launch-card ready check (title + description above the Play button)
function setReadyState(title, desc) {
  const t = document.getElementById('ready-state-title')
  const d = document.getElementById('ready-state-desc')
  if (t) t.textContent = title
  if (d) d.textContent = desc
}

// Re-evaluates Play button state whenever lock/whitelist state changes.
// Call this after login, logout, and initial serverinfo load.
function updateLockState() {
  // While the game runs (or a play sequence is in flight) the button is
  // managed by updatePlayButton() - don't fight over it here.
  if (gameRunning || playBusy) return

  if (serverLocked && discordUser && !serverAllowed) {
    // Logged in but not on the server lock allow-list
    btnConnect.disabled = true
    btnConnect.title    = 'The server is currently locked.'
    connectWarning.textContent = 'Server is currently locked - you are not on the allow list.'
    connectWarning.classList.add('visible')
    setReadyState('Access restricted', 'The server is locked and you are not on the allow list.')
  } else if (!serverLocked && discordUser && !serverAllowed) {
    // Logged in but not on the whitelist
    btnConnect.disabled = true
    btnConnect.title    = 'You are not on the server whitelist.'
    connectWarning.textContent = 'You are not on the server whitelist.'
    connectWarning.classList.add('visible')
    setReadyState('Access restricted', 'You are not on the server whitelist.')
  } else {
    btnConnect.disabled = false
    btnConnect.title    = ''
    if (!discordUser) {
      setReadyState('Login required', 'Sign in with Discord from the Account panel.')
    } else {
      setReadyState('Ready to launch', 'All checks passed - press Play to enter the realm.')
    }
    // Fix instantly disappearing
    const lockMessages = [
      'You are not on the server whitelist.',
    ]
    if (lockMessages.includes(connectWarning.textContent)) {
      connectWarning.classList.remove('visible')
      connectWarning.textContent = ''
    }
  }
}

// Load / save settings
async function loadSettings() {
  const s = await window.electronAPI.loadSettings()
  fieldSkyrimPath.value = s.skyrimPath || ''

  // Footer server selector - dropdown when >1 server, plain text otherwise
  if (s.servers && s.servers.length > 1) {
    footerServerName.hidden   = true
    footerServerSelect.hidden = false
    footerServerSelect.innerHTML = ''
    s.servers.forEach((srv, i) => {
      const opt = document.createElement('option')
      opt.value       = i
      opt.textContent = srv.name
      opt.selected    = i === (s.activeServerIndex || 0)
      footerServerSelect.appendChild(opt)
    })
  } else {
    footerServerName.hidden   = false
    footerServerSelect.hidden = true
    if (s.servers && s.servers.length === 1) {
      footerServerName.textContent = s.servers[0].name
    }
  }

  renderServerCards(s.servers || [], s.activeServerIndex || 0)

  // Restore Discord user from persisted store
  if (s.discordUser) {
    discordUser = s.discordUser
    renderTopbarDiscord()
  }

  // Restore MO2 settings
  fieldMo2Enabled.checked = !!s.mo2Enabled
  refreshMo2Status()

  // Restore isolated-game setting
  fieldIsolated.checked = !!s.isolatedGame
  refreshIsolatedStatus()

  return s
}

// Discord topbar widget
const discordTopbarSlot = document.getElementById('discord-topbar-slot')

function renderTopbarDiscord() {
  discordTopbarSlot.innerHTML = ''

  if (discordUser) {
    const wrap = document.createElement('div')
    wrap.className = 'discord-topbar-user'

    if (discordUser.avatar) {
      const img = document.createElement('img')
      img.className = 'discord-topbar-avatar'
      img.src = discordUser.avatar
      img.alt = discordUser.username
      wrap.appendChild(img)
    } else {
      const ph = document.createElement('div')
      ph.className   = 'discord-topbar-avatar-placeholder'
      ph.textContent = '✦'
      wrap.appendChild(ph)
    }

    const name = document.createElement('span')
    name.className   = 'discord-topbar-name'
    name.textContent = `Discord: ${discordUser.tag || discordUser.username}`
    wrap.appendChild(name)

    const logoutBtn = document.createElement('button')
    logoutBtn.className   = 'discord-topbar-logout'
    logoutBtn.title       = 'Logout'
    logoutBtn.textContent = '✕'
    logoutBtn.addEventListener('click', async () => {
      await window.electronAPI.discordLogout()
      discordUser   = null
      serverAllowed = true  // reset: access unknown until next login
      renderTopbarDiscord()
      updateLockState()
    })
    wrap.appendChild(logoutBtn)

    discordTopbarSlot.appendChild(wrap)
  } else {
    const loginBtn = document.createElement('button')
    loginBtn.className   = 'btn-discord-topbar'
    loginBtn.textContent = 'Discord Login'
    loginBtn.addEventListener('click', async () => {
      loginBtn.disabled    = true
      loginBtn.textContent = 'Waiting for Discord…'
      loginBtn.title       = 'Finish logging in from the browser window that just opened.'
      if (connectWarning.textContent.startsWith('Discord login failed:')) {
        connectWarning.classList.remove('visible')
        connectWarning.textContent = ''
      }
      const result = await window.electronAPI.discordLogin()
      if (result.success) {
        discordUser = result.user
        // Re-fetch serverinfo now that we have a session - the backend will
        // evaluate whitelist / lock access and return the correct `allowed` flag.
        const freshInfo = await window.electronAPI.fetchServerInfo()
        serverAllowed = freshInfo ? freshInfo.allowed !== false : true
        renderTopbarDiscord()
        updateLockState()
      } else {
        loginBtn.disabled    = false
        loginBtn.textContent = 'Discord Login'
        loginBtn.title       = ''
        // Stays visible until the next attempt - the user is usually still
        // alt-tabbed in the browser when the failure lands.
        connectWarning.textContent = `Discord login failed: ${result.error}`
        connectWarning.classList.add('visible')
      }
    })
    discordTopbarSlot.appendChild(loginBtn)
  }
}

renderTopbarDiscord()


// Nexus topbar widget
// Login is the one-click SSO flow (registered application slug): the button
// opens nexusmods.com in the browser and the key arrives over the SSO
// websocket. The old paste-your-API-key modal is gone.
const nexusTopbarSlot = document.getElementById('nexus-topbar-slot')

let nexusUser = null

function renderTopbarNexus() {
  nexusTopbarSlot.innerHTML = ''

  if (nexusUser) {
    const wrap = document.createElement('div')
    wrap.className = 'discord-topbar-user nexus-topbar-user'

    if (nexusUser.profileUrl) {
      const img = document.createElement('img')
      img.className = 'discord-topbar-avatar'
      img.src = nexusUser.profileUrl
      img.alt = nexusUser.name
      wrap.appendChild(img)
    }

    const name = document.createElement('span')
    name.className   = 'discord-topbar-name'
    name.textContent = `Nexus: ${nexusUser.name}${nexusUser.isPremium ? ' \u2605' : ''}`
    name.title       = nexusUser.isPremium
      ? 'Nexus Premium - automatic mod downloads enabled'
      : 'Nexus free account - downloads open in the browser'
    wrap.appendChild(name)

    const logoutBtn = document.createElement('button')
    logoutBtn.className   = 'discord-topbar-logout'
    logoutBtn.title       = 'Logout from Nexus'
    logoutBtn.textContent = '\u2715'
    logoutBtn.addEventListener('click', async () => {
      await window.electronAPI.nexusLogout()
      nexusUser = null
      renderTopbarNexus()
    })
    wrap.appendChild(logoutBtn)

    nexusTopbarSlot.appendChild(wrap)
  } else {
    const loginBtn = document.createElement('button')
    loginBtn.className   = 'btn-nexus-topbar'
    loginBtn.textContent = 'Nexus Login'
    loginBtn.addEventListener('click', async () => {
      loginBtn.disabled    = true
      loginBtn.textContent = 'Waiting for Nexus…'
      loginBtn.title       = 'Click Authorise on the Nexus page that just opened.'
      if (connectWarning.textContent.startsWith('Nexus login failed:')) {
        connectWarning.classList.remove('visible')
        connectWarning.textContent = ''
      }
      const result = await window.electronAPI.nexusSsoLogin()
      if (result.success) {
        nexusUser = result.user
        renderTopbarNexus()
      } else {
        loginBtn.disabled    = false
        loginBtn.textContent = 'Nexus Login'
        loginBtn.title       = ''
        connectWarning.textContent = `Nexus login failed: ${result.error}`
        connectWarning.classList.add('visible')
      }
    })
    nexusTopbarSlot.appendChild(loginBtn)
  }
}

window.electronAPI.nexusGetUser().then(user => {
  nexusUser = user
  renderTopbarNexus()
})

// Isolated game copy UI
const isolatedDot       = document.getElementById('isolated-status-dot')
const isolatedText      = document.getElementById('isolated-status-text')
const fieldIsolated     = document.getElementById('setting-isolated-game')
const btnCreateIsolated = document.getElementById('btn-create-isolated')
const btnInstallMo2     = document.getElementById('btn-install-mo2')
const isolatedGroup     = document.getElementById('isolated-install-group')

// locks install via mo2 until there's a game to manage
function refreshDownloadModsState(st) {
  if (mo2InstallRunning) return  // button is in Cancel mode; don't fight it
  const ready = !fieldIsolated.checked || st.ready
  btnInstallMo2.disabled = !ready
  btnInstallMo2.title = ready
    ? ''
    : 'Install the game files first, or turn off Portable Skyrim Mode in the Troubleshooting tab.'
}

async function refreshIsolatedStatus() {
  const st = await window.electronAPI.isolatedStatus()
  // Portable mode off: the whole "choose install location" section is
  // irrelevant, so hide it instead of explaining it.
  isolatedGroup.hidden = !fieldIsolated.checked
  if (!st.ready) {
    isolatedDot.className    = 'status-dot'
    isolatedText.textContent = 'Not installed yet - choose a location to set up Vengeful Realms'
  } else if (!fieldIsolated.checked) {
    isolatedDot.className    = 'status-dot dot-warn'
    isolatedText.textContent = 'Vengeful Realms install exists - playing from the original Skyrim'
  } else {
    isolatedDot.className    = 'status-dot dot-ok'
    isolatedText.textContent = `Vengeful Realms installed at ${st.base || st.dir}`
  }
  refreshDownloadModsState(st)
}

// Isolated-install progress renders next to the button in the settings
// modal; the modpack install that follows reports in the Mod Pack section.
const installStatusIso = document.getElementById('install-status-iso')

btnCreateIsolated.addEventListener('click', async () => {
  // Same flow as the Play button's INSTALL state: Nexus login first, then
  // the themed install-location dialog (which runs the actual install).
  btnCreateIsolated.disabled = true
  btnCreateIsolated.textContent = 'Waiting for Nexus…'
  let loggedIn = false
  try { loggedIn = await ensureNexusLoginUI() }
  finally {
    btnCreateIsolated.disabled = false
    btnCreateIsolated.textContent = 'Choose Install Location'
  }
  if (!loggedIn) {
    // The Play-card warning strip is hidden behind the settings modal, so
    // mirror the feedback where this button lives.
    installStatusIso.textContent = 'Nexus login required - finish the login in your browser, then try again.'
    return
  }
  installStatusIso.textContent = ''
  openInstallLocationModal()
})

fieldIsolated.addEventListener('change', refreshIsolatedStatus)

document.getElementById('btn-save').addEventListener('click', async () => {
  const data = {
    skyrimPath:   fieldSkyrimPath.value.trim(),
    mo2Enabled:   fieldMo2Enabled.checked,
    isolatedGame: fieldIsolated.checked,
  }

  await window.electronAPI.saveSettings(data)
  await saveGameSettingsTab()
  refreshMo2Status()

  const btn = document.getElementById('btn-save')
  btn.textContent = 'Saved!'
  setTimeout(() => { btn.textContent = 'Save Settings' }, 1400)
})

// Browse folder
document.getElementById('btn-browse').addEventListener('click', async () => {
  const folder = await window.electronAPI.openFolder()
  if (folder) fieldSkyrimPath.value = folder
})

// MO2 UI

const mo2EnableText = document.getElementById('mo2-enable-text')

async function refreshMo2Status() {
  const status  = await window.electronAPI.mo2Status()
  const enabled = fieldMo2Enabled.checked

  // Checkbox caption reflects what disabling MO2 means.
  mo2EnableText.textContent = enabled
    ? 'Launch the game through MO2 - mods stay out of your Skyrim folder'
    : 'You will need to install mods manually.'

  if (!status.installed) {
    mo2StatusDot.className    = 'status-dot'
    mo2StatusText.textContent = 'MO2 not installed yet - run "Install Modpack via MO2" in the Mod Pack section'
  } else if (!enabled) {
    mo2StatusDot.className    = 'status-dot dot-warn'
    mo2StatusText.textContent = `MO2 ${status.version} ready (${status.modCount} mods) - launching without it`
  } else {
    mo2StatusDot.className    = 'status-dot dot-ok'
    mo2StatusText.textContent = `MO2 ${status.version} active (${status.modCount} mods)`
  }
}

const btnOpenMo2  = document.getElementById('btn-open-mo2')
const mo2OpenWarn = document.getElementById('mo2-open-warning')
btnOpenMo2.addEventListener('click', async () => {
  btnOpenMo2.disabled    = true
  btnOpenMo2.textContent = 'MO2 is running'
  if (mo2OpenWarn) mo2OpenWarn.hidden = false

  const result = await window.electronAPI.mo2Open()
  if (!result.success) {
    alert(`Could not open MO2: ${result.error}`)
    btnOpenMo2.disabled    = false
    btnOpenMo2.textContent = 'Open & Configure MO2'
    if (mo2OpenWarn) mo2OpenWarn.hidden = true
  }
})

fieldMo2Enabled.addEventListener('change', refreshMo2Status)

document.getElementById('btn-open-install').addEventListener('click', async () => {
  const r = await window.electronAPI.openInstallFolder()
  if (!r.success) alert(`Could not open the install folder: ${r.error}`)
})

// Troubleshooting: manual launch buttons
const troubleLaunchStatus = document.getElementById('trouble-launch-status')

document.getElementById('btn-launch-mo2').addEventListener('click', async () => {
  troubleLaunchStatus.textContent = 'Launching via MO2…'
  const r = await window.electronAPI.launchViaMO2()
  troubleLaunchStatus.textContent = r.success ? 'Launched via MO2 ✓' : `Error: ${r.error}`
})

document.getElementById('btn-launch-direct').addEventListener('click', async () => {
  troubleLaunchStatus.textContent = 'Launching SKSE…'
  const r = await window.electronAPI.launchDirect()
  troubleLaunchStatus.textContent = r.success ? 'Launched ✓' : `Error: ${r.error}`
})

// Install / Update Client Files
const installStatusClient = document.getElementById('install-status-client')

document.getElementById('btn-install-client').addEventListener('click', () => {
  installStatusClient.textContent = 'Starting install…'
  window.electronAPI.removeInstallListeners()

  window.electronAPI.onInstallProgress(({ phase, file, index, total, skipped }) => {
    if (phase === 'download') {
      installStatusClient.textContent = file
    } else {
      const prefix = skipped ? '[skip]' : `[${index}/${total}]`
      installStatusClient.textContent = `${prefix} ${file}`
    }
  })

  window.electronAPI.onInstallComplete(({ success, error, upToDate }) => {
    if (!success) {
      installStatusClient.textContent = `Error: ${error}`
      return
    }
    installStatusClient.textContent = upToDate ? 'Client files up to date ✓' : 'Client files installed ✓'
  })

  window.electronAPI.startInstall('client')
})

// Install Modpack via MO2
const installStatusMo2 = document.getElementById('install-status-mo2')

let mo2InstallRunning = false

function startModpackInstall() {
  // While an install runs the same button cancels it, so a wedged install
  // can always be stopped and retried without restarting the launcher.
  if (mo2InstallRunning) {
    installStatusMo2.textContent = 'Cancelling…'
    window.electronAPI.cancelInstall()
    return
  }
  mo2InstallRunning = true
  btnInstallMo2.textContent = 'Cancel Install'
  installStatusMo2.textContent = 'Starting MO2 install…'
  window.electronAPI.removeInstallListeners()

  window.electronAPI.onInstallProgress(({ phase, file, index, total, skipped }) => {
    if (phase === 'download') {
      installStatusMo2.textContent = file
    } else if (phase === 'mods') {
      installStatusMo2.textContent = total > 0 ? `[mods ${index}/${total}] ${file}` : file
    } else {
      const prefix = skipped ? '[skip]' : `[${index}/${total}]`
      installStatusMo2.textContent = `${prefix} ${file}`
    }
  })

  window.electronAPI.onInstallComplete(({ success, error, upToDate, warning, modsTotal }) => {
    mo2InstallRunning = false
    btnInstallMo2.textContent = 'Install Modpack via MO2'
    if (!success) {
      installStatusMo2.textContent = `Error: ${error}`
      return
    }
    if (warning) {
      installStatusMo2.textContent = `⚠ ${warning}`
      refreshMo2Status()
      return
    }
    const files = upToDate ? 'client files up to date' : 'client files installed'
    installStatusMo2.textContent = `Modpack ready ✓ - ${modsTotal ?? 0} mods, ${files}`
    refreshMo2Status()
  })

  window.electronAPI.startInstall('mo2')
}
btnInstallMo2.addEventListener('click', startModpackInstall)

// PLAY button
// One click does everything: verify/refresh client files, sync the load
// order, then launch. While the game runs the button reflects that state.
const btnConnect     = document.getElementById('btn-connect')
const connectWarning = document.getElementById('connect-warning')

let gameRunning     = false
let playBusy        = false
let isoReady        = true   // isolation disabled, or the game copy exists
let updateAvailable = false  // server has newer client files than installed
let filesInstalled  = true   // client files were installed at least once

const PLAY_LABEL = '\u25BA PLAY'
const updatePill = document.getElementById('update-pill')

function updatePlayButton() {
  updatePill.hidden = !(updateAvailable && isoReady && !gameRunning)

  if (gameRunning) {
    btnConnect.disabled    = true
    btnConnect.textContent = '\u23F3 GAME RUNNING'
    btnConnect.title       = 'Skyrim is currently running.'
    setReadyState('Game running', 'Skyrim is currently running.')
    return
  }
  if (playBusy) return  // label managed by the play/update sequence

  // The launcher must be current before anything else - client-file updates
  // and playing both wait behind the launcher's own update.
  if (launcherUpdateReady) {
    btnConnect.disabled    = false
    btnConnect.textContent = '\u2913 UPDATE LAUNCHER'
    btnConnect.title       = 'A launcher update is required before playing.'
    setReadyState('Launcher update', 'A new launcher version is required - press Update Launcher.')
    return
  }

  if (!isoReady) {
    btnConnect.disabled    = false
    btnConnect.textContent = '\u2699 INSTALL'
    btnConnect.title       = 'Install Vengeful Realms.'
    setReadyState('Install required', 'Press Install to set up Vengeful Realms.')
    return
  }

  if (updateAvailable) {
    const install = !filesInstalled
    btnConnect.disabled    = false
    btnConnect.textContent = install ? '\u2699 INSTALL' : '\u2913 UPDATE'
    btnConnect.title       = install ? 'Client files are not installed yet.' : 'A client files update is available.'
    setReadyState(install ? 'Install required' : 'Update available',
      install ? 'Client files are missing - press Install.' : 'New client files are ready - press Update.')
    return
  }

  btnConnect.textContent = PLAY_LABEL
  btnConnect.title       = ''
  btnConnect.disabled    = false
  updateLockState()
}

// Re-evaluate the install/update state (called at startup, after installs,
// after the game copy is created, and on a slow poll).
async function refreshPlayState() {
  const iso = await window.electronAPI.isolatedStatus()
  isoReady = !iso.enabled || iso.ready

  const uc = await window.electronAPI.filesUpdateCheck()
  updateAvailable = !!uc.updateAvailable
  if (uc.ok) filesInstalled = uc.installed !== false
  if (uc.serverVersion) clientVersionEl.textContent = `v${uc.serverVersion}`

  updatePlayButton()
}
setInterval(refreshPlayState, 5_000)

async function pollGameRunning() {
  const running = await window.electronAPI.gameIsRunning()
  if (running !== gameRunning) {
    gameRunning = running
    updatePlayButton()
  }
}
setInterval(pollGameRunning, 10_000)
pollGameRunning()

function showWarning(text) {
  connectWarning.textContent = text
  connectWarning.classList.add('visible')
}

function clearWarning() {
  connectWarning.classList.remove('visible')
  connectWarning.textContent = ''
}

// Run the installer (auto mode) and resolve with its completion result,
// mirroring progress onto the Play button / warning strip.
function runInstallForPlay() {
  return new Promise(resolve => {
    window.electronAPI.removeInstallListeners()
    window.electronAPI.onInstallProgress(({ phase, file }) => {
      btnConnect.textContent = phase === 'download' ? '\u2913 DOWNLOADING\u2026'
        : phase === 'verify' ? '\u2699 VERIFYING\u2026'
        : '\u2699 INSTALLING\u2026'
      showWarning(file)
    })
    window.electronAPI.onInstallComplete(result => resolve(result))
    window.electronAPI.startInstall('auto')
  })
}

btnConnect.addEventListener('click', async () => {
  if (gameRunning || playBusy) return

  // Launcher update comes first: neither client-file updates nor playing
  // proceed on an outdated launcher.
  if (launcherUpdateReady) {
    startLauncherUpdate()
    return
  }

  // No game copy yet: Nexus login, then the install-location dialog.
  if (!isoReady) {
    playBusy            = true
    btnConnect.disabled = true
    btnConnect.textContent = '⏳ WAITING FOR NEXUS…'
    let loggedIn = false
    try { loggedIn = await ensureNexusLoginUI() }
    finally {
      playBusy            = false
      btnConnect.disabled = false
      updatePlayButton()
    }
    if (loggedIn) openInstallLocationModal()
    return
  }

  // A modpack install started from the Mod Pack tab (or the install-location
  // dialog) owns the install listeners - starting a second run would strip
  // its completion handler and wedge that tab's button.
  if (mo2InstallRunning) {
    showWarning('Modpack install already in progress - see the Mod Pack section in Settings.')
    return
  }

  // Update mode: refresh the client files, don't launch.
  if (updateAvailable) {
    playBusy            = true
    btnConnect.disabled = true
    clearWarning()
    try {
      btnConnect.textContent = '\u2913 UPDATING\u2026'
      const result = await runInstallForPlay()
      if (!result.success) {
        showWarning(result.error || 'Update failed.')
        return
      }
      showWarning('Client files updated \u2713')
      setTimeout(clearWarning, 4000)
    } finally {
      playBusy = false
      await refreshPlayState()
    }
    return
  }

  const s = await window.electronAPI.loadSettings()
  if (!s.skyrimPath) {
    showWarning('Set Skyrim path in Settings first.')
    return
  }

  // Discord login is automatic on Play: open the OAuth flow and wait for it.
  // playBusy stays held through the whole block (including the serverinfo
  // re-fetch) so a double-click cannot start a second play pipeline.
  if (!discordUser) {
    playBusy            = true
    btnConnect.disabled = true
    btnConnect.textContent = '⏳ WAITING FOR DISCORD…'
    showWarning('Finish logging in with Discord in the browser window that just opened…')
    const result = await window.electronAPI.discordLogin()
    if (!result.success) {
      playBusy            = false
      btnConnect.disabled = false
      showWarning(`Discord login failed: ${result.error}`)
      updatePlayButton()
      return
    }
    discordUser = result.user
    const freshInfo = await window.electronAPI.fetchServerInfo()
    serverAllowed = freshInfo ? freshInfo.allowed !== false : true
    renderTopbarDiscord()
    updateLockState()
    clearWarning()
    playBusy            = false
    btnConnect.disabled = false
  }

  if (!serverAllowed) {
    showWarning(serverLocked
      ? 'Server is currently locked - you are not on the allow list.'
      : 'You are not on the server whitelist.')
    updatePlayButton()
    return
  }

  playBusy            = true
  btnConnect.disabled = true
  clearWarning()

  try {
    // 1. Make sure client files are present and current (fast no-op when up to date)
    btnConnect.textContent = '\u2699 CHECKING FILES\u2026'
    const install = await runInstallForPlay()
    if (!install.success) {
      showWarning(install.error || 'Install failed.')
      return
    }

    // 2. Launch - main also re-syncs plugins.txt against the server load order
    btnConnect.textContent = '\u25BA LAUNCHING\u2026'
    clearWarning()
    const result = await window.electronAPI.launchSkse()

    if (!result.success) {
      showWarning(result.error)
      return
    }

    clearWarning()
    gameRunning = true  // optimistic; the 10s poll keeps it honest
  } finally {
    playBusy = false
    await refreshPlayState()
  }
})

// Server status
// The badge follows the GAME SERVER's state as reported by /api/status
// (heartbeat, falling back to a metrics-port probe) - a reachable backend
// with a dead game server reads OFFLINE.
const badgeStatus  = document.getElementById('badge-status')
const badgeLabel   = document.getElementById('badge-label')
const badgePlayers = document.getElementById('badge-players')
// Footer player count hidden for now - the topbar badge already shows it.
// const footerPlayers = document.getElementById('footer-players')

// track reachability so we can resync the one-shot panels when the backend returns
let backendWasReachable = null

async function checkServerStatus() {
  const data = await window.electronAPI.fetchStatus()
  const backendUp = !!(data && data.ok)   // drives the reconnect resync below
  if (!data || !data.ok || data.status !== 'online') {
    badgeStatus.classList.remove('online')
    badgeLabel.textContent = 'OFFLINE'
    badgePlayers.hidden = true
    // footerPlayers.textContent = '—'
  } else {
    badgeStatus.classList.add('online')
    badgeLabel.textContent = 'ONLINE'
    if (data.players != null) {
      badgePlayers.textContent = `${data.players} PLAYERS`
      badgePlayers.hidden = false
      // footerPlayers.textContent = `${data.players}`
    } else {
      badgePlayers.hidden = true
      // footerPlayers.textContent = '—'
    }
  }

  // resync only when the backend goes offline then back online; skip the first poll
  if (backendUp && backendWasReachable === false) {
    refreshServerData()
  }
  backendWasReachable = backendUp
}

// re-pull panels that only load at startup; player count already polls itself
function refreshServerData() {
  loadNews()
  loadModlist()
  loadServerInfo()
  refreshPlayState()   // client version + update availability
}

// Server info strip
async function loadServerInfo() {
  const info = await window.electronAPI.fetchServerInfo()
  if (!info || info.error) return

  const strip      = document.getElementById('server-info-strip')
  const nameEl     = document.getElementById('sinfo-name')
  const capEl      = document.getElementById('sinfo-capacity')
  const modeEl     = document.getElementById('sinfo-mode')
  const modeSep    = document.getElementById('sinfo-mode-sep')
  const discEl     = document.getElementById('sinfo-discord')
  const discSep    = document.getElementById('sinfo-discord-sep')
  const lockEl     = document.getElementById('sinfo-locked')
  const lockSep    = document.getElementById('sinfo-locked-sep')
  const footerName = document.getElementById('footer-server-name')

  nameEl.textContent = info.name
  capEl.textContent  = `Max ${info.maxPlayers} players`
  footerName.textContent = info.name

  if (info.gamemode) {
    modeEl.textContent = info.gamemode
    modeEl.hidden  = false
    modeSep.hidden = false
  }

  if (info.discordAuthRequired) {
    discEl.hidden  = false
    discSep.hidden = false
  }

  if (info.locked) {
    serverLocked   = true
    lockEl.hidden  = false
    lockSep.hidden = false
  }

  // `allowed` is session-aware: false only when a session was sent and the
  // backend rejected it (locked/not whitelisted).  Without a session it
  // defaults to true - access is re-checked after Discord login.
  // `sessionValid: false` means the stored session expired - treat as logged out.
  if (info.sessionValid === false && discordUser) {
    // Session expired - clear stale auth so the user can log in again cleanly.
    await window.electronAPI.discordLogout()
    discordUser   = null
    serverAllowed = true
    renderTopbarDiscord()
  } else if (info.allowed === false) {
    serverAllowed = false
  }

  updateLockState()

  strip.hidden = false
}

// Launcher update check
const launcherVersionEl = document.getElementById('launcher-version')
const clientVersionEl   = document.getElementById('client-version')

// The check runs every 10s (see the polling block at the bottom), so the
// UPDATE AVAILABLE state appears while the launcher is open - no restart
// needed. Click/progress handlers are registered exactly once here; the
// periodic check only flips the label state.
let launcherUpdateReady = false

window.electronAPI.onUpdateProgress(d => {
  if (!launcherVersionEl.dataset.updating) return
  if (d.phase === 'download' && d.total > 0) {
    launcherVersionEl.textContent = `Downloading update… ${Math.round(d.received / d.total * 100)}%`
  } else if (d.phase === 'install') {
    launcherVersionEl.textContent = 'Installing - the launcher will restart…'
  }
})

// Shared by the footer version label and the Play button's UPDATE LAUNCHER
// state - on success the installer quits and relaunches the app.
async function startLauncherUpdate() {
  if (launcherVersionEl.dataset.updating) return
  launcherVersionEl.dataset.updating = '1'
  // playBusy keeps the 5s refreshPlayState poll from re-enabling the button
  // mid-download; on success the installer quits and relaunches the app, so
  // the busy state is only released on failure.
  playBusy = true
  launcherVersionEl.textContent = 'Downloading update…'
  btnConnect.disabled    = true
  btnConnect.textContent = '⤓ UPDATING LAUNCHER…'
  const r = await window.electronAPI.installUpdate()
  if (!r.ok) {
    launcherVersionEl.textContent = '⬆ UPDATE AVAILABLE'
    delete launcherVersionEl.dataset.updating
    playBusy = false
    btnConnect.disabled = false
    updatePlayButton()
    showWarning(`Update failed: ${r.error}`)
  }
}

launcherVersionEl.addEventListener('click', () => {
  if (launcherUpdateReady) startLauncherUpdate()
})

async function checkLauncherUpdate() {
  const result = await window.electronAPI.checkUpdate()
  if (!result) return
  if (launcherVersionEl.dataset.updating) return  // don't clobber install progress UI

  const hadUpdate = launcherUpdateReady
  if (result.hasUpdate) {
    launcherUpdateReady = true
    launcherVersionEl.textContent = '⬆ UPDATE AVAILABLE'
    launcherVersionEl.classList.add('update-available')
    launcherVersionEl.title = `v${result.latest} is available - click to update`
  } else {
    launcherUpdateReady = false
    launcherVersionEl.textContent = `v${result.current}`
    launcherVersionEl.classList.remove('update-available')
    launcherVersionEl.title = ''
  }
  // The Play button doubles as UPDATE LAUNCHER while an update is pending.
  if (hadUpdate !== launcherUpdateReady && !playBusy && !gameRunning) updatePlayButton()
}

// News
const newsGrid = document.getElementById('news-grid')

// Shared error-state card with a retry button - used by news and modlist
// instead of silently showing fallback content when the backend is unreachable.
function buildErrorState(message, onRetry) {
  const box = document.createElement('div')
  box.className = 'panel-error'

  const text = document.createElement('div')
  text.className   = 'panel-error-text'
  text.textContent = message
  box.appendChild(text)

  const retry = document.createElement('button')
  retry.className   = 'panel-error-retry'
  retry.textContent = 'Retry'
  retry.addEventListener('click', () => {
    retry.disabled    = true
    retry.textContent = 'Retrying…'
    onRetry()
  })
  box.appendChild(retry)

  return box
}

function buildNewsCard(item) {
  const card = document.createElement('div')
  card.className = 'news-card'

  const imgWrap = document.createElement('div')
  imgWrap.className = 'news-card-image'
  if (item.image) {
    const img = document.createElement('img')
    img.src = item.image
    img.alt = item.title
    imgWrap.appendChild(img)
  }

  const body = document.createElement('div')
  body.className = 'news-card-body'

  const tag = document.createElement('div')
  tag.className = 'news-card-tag'
  tag.textContent = item.tag || 'UPDATE'

  const title = document.createElement('div')
  title.className = 'news-card-title'
  title.textContent = item.title

  const date = document.createElement('div')
  date.className = 'news-card-date'
  date.textContent = item.date

  body.appendChild(tag)
  body.appendChild(title)

  if (item.body) {
    const desc = document.createElement('div')
    desc.className = 'news-card-desc'
    desc.textContent = item.body
    body.appendChild(desc)
  }

  body.appendChild(date)

  card.appendChild(imgWrap)
  card.appendChild(body)
  return card
}

async function loadNews() {
  const result = await window.electronAPI.fetchNews()
  newsGrid.innerHTML = ''

  if (!result || !result.ok) {
    newsGrid.appendChild(buildErrorState('Couldn’t reach the server - news unavailable.', loadNews))
    return
  }

  if (result.items.length === 0) {
    const empty = document.createElement('div')
    empty.className   = 'panel-empty'
    empty.textContent = 'No news posted yet.'
    newsGrid.appendChild(empty)
    return
  }

  result.items.forEach((item, i) => {
    const card = buildNewsCard(item)
    if (i === 0) card.classList.add('featured')
    newsGrid.appendChild(card)
  })
}

// Modlist

function nexusGameSlug(gameName) {
  const value = String(gameName || '').trim().toLowerCase()
  if (value === 'skyrim') return 'skyrim'
  if (value === 'skyrimse') return 'skyrimspecialedition'
  return 'skyrimspecialedition'
}

function nexusModUrl(mod) {
  return `https://www.nexusmods.com/${nexusGameSlug(mod.gameName)}/mods/${mod.nexusId}`
}

function buildModItem(mod) {
  const item = document.createElement('div')
  item.className = `modlist-item${mod.enabled ? '' : ' modlist-item--disabled'}`

  const dot = document.createElement('span')
  dot.className = `mod-dot ${mod.enabled ? 'mod-dot--enabled' : 'mod-dot--disabled'}`

  const name = document.createElement('span')
  name.className   = 'mod-name'
  name.textContent = mod.name
  name.title       = mod.name

  item.appendChild(dot)
  item.appendChild(name)

  if (mod.required) {
    const badge = document.createElement('span')
    badge.className   = 'mod-badge mod-badge--required'
    badge.textContent = 'REQ'
    item.appendChild(badge)
  }

  // Backend mods are installed automatically by the launcher.
  // Nexus mods are downloaded from Nexus and installed through MO2.
  if (mod.source === 'backend') {
    const badge = document.createElement('span')
    badge.className   = 'mod-badge mod-badge--auto'
    badge.textContent = 'AUTO'
    badge.title       = 'Installed automatically by the launcher'
    item.appendChild(badge)
  } else if (mod.source === 'nexus' && mod.nexusId) {
    const link = document.createElement('a')
    link.className   = 'mod-nexus-link'
    link.textContent = 'Nexus'
    link.title       = 'Open on Nexus Mods'
    link.href        = '#'
    link.addEventListener('click', e => {
      e.preventDefault()
      window.electronAPI.openExternal(nexusModUrl(mod))
    })
    item.appendChild(link)
  }

  if (mod.version) {
    const ver = document.createElement('span')
    ver.className   = 'mod-version'
    ver.textContent = `v${mod.version}`
    item.appendChild(ver)
  }

  return item
}

// Keep a reference to the last-loaded modlist so the install handler can use it.
let currentModlist = []

async function loadModlist() {
  const panel = document.getElementById('modlist')
  const count = document.getElementById('modlist-count')

  const result = await window.electronAPI.fetchModlist()
  panel.innerHTML = ''

  if (!result || !result.ok) {
    currentModlist    = []
    count.textContent = '—'
    panel.appendChild(buildErrorState('Couldn’t reach the server - modlist unavailable.', loadModlist))
    return
  }

  currentModlist = result.items

  if (currentModlist.length === 0) {
    count.textContent = '0 mods'
    const empty = document.createElement('div')
    empty.className   = 'panel-empty'
    empty.textContent = 'No mods published yet.'
    panel.appendChild(empty)
    return
  }

  currentModlist.forEach(mod => panel.appendChild(buildModItem(mod)))

  const enabled = currentModlist.filter(m => m.enabled).length
  count.textContent = `${enabled} / ${currentModlist.length} enabled`
}

// Metrics modal
const modalMetrics  = document.getElementById('modal-metrics')
const metricsGrid   = document.getElementById('metrics-grid')

document.getElementById('btn-stats').addEventListener('click', () => {
  modalMetrics.hidden = false
  loadMetrics()
})

document.getElementById('metrics-close').addEventListener('click', () => {
  modalMetrics.hidden = true
})

modalMetrics.addEventListener('click', e => {
  if (e.target === modalMetrics) modalMetrics.hidden = true
})

function metricCard(label, value, sub) {
  const card = document.createElement('div')
  card.className = 'metric-card'

  const lEl = document.createElement('div')
  lEl.className   = 'metric-label'
  lEl.textContent = label

  const vEl = document.createElement('div')
  vEl.className   = 'metric-value'
  vEl.textContent = value

  card.appendChild(lEl)
  card.appendChild(vEl)

  if (sub != null) {
    const sEl = document.createElement('div')
    sEl.className   = 'metric-sub'
    sEl.textContent = sub
    card.appendChild(sEl)
  }

  return card
}

async function loadMetrics() {
  metricsGrid.innerHTML = ''
  const loadEl = document.createElement('div')
  loadEl.className   = 'metrics-loading'
  loadEl.textContent = 'Loading…'
  metricsGrid.appendChild(loadEl)

  const result = await window.electronAPI.fetchMetrics()

  metricsGrid.innerHTML = ''

  if (!result || !result.ok) {
    const err = document.createElement('div')
    err.className   = 'metric-card metric-card--error'
    err.textContent = 'Server statistics are currently unavailable.'
    if (result?.error) err.title = result.error
    metricsGrid.appendChild(err)
    return
  }

  const m = result.metrics

  const connects    = m['skymp_connects_total']    ?? null
  const disconnects = m['skymp_disconnects_total'] ?? null
  const online      = (connects !== null && disconnects !== null)
    ? Math.max(0, connects - disconnects)
    : null

  const logins      = m['skymp_logins_total']       ?? null
  const loginErrors = m['skymp_login_errors_total'] ?? null
  const rpcs        = m['skymp_rpc_calls_total']    ?? null
  const tickAvg     = m['skymp_tick_duration_seconds_sum'] != null && m['skymp_tick_duration_seconds_count']
    ? (m['skymp_tick_duration_seconds_sum'] / m['skymp_tick_duration_seconds_count'] * 1000)
    : null

  const fmt = v => v != null ? v.toLocaleString() : '—'
  const fmtMs = v => v != null ? `${v.toFixed(1)} ms` : '—'

  metricsGrid.appendChild(metricCard('Online Now',       fmt(online),      online !== null ? `${fmt(connects)} connects / ${fmt(disconnects)} disconnects` : null))
  metricsGrid.appendChild(metricCard('Total Logins',     fmt(logins),      loginErrors !== null ? `${fmt(loginErrors)} errors` : null))
  metricsGrid.appendChild(metricCard('RPC Calls',        fmt(rpcs),        null))
  metricsGrid.appendChild(metricCard('Avg Tick Duration', fmtMs(tickAvg),  null))
}

// Install location modal
// Themed replacement for the native folder picker: path entry + Browse +
// Confirm, with bold warnings for non-empty folders and low disk space.
const installLocModal   = document.getElementById('modal-install-location')
const installLocPath    = document.getElementById('install-location-path')
const installLocBrowse  = document.getElementById('install-location-browse')
const installLocConfirm = document.getElementById('install-location-confirm')
const installLocWarning = document.getElementById('install-location-warning')
const installLocStatus  = document.getElementById('install-location-status')
const installLocClose   = document.getElementById('install-location-close')

let installLocBusy = false

// Renders warnings for the current path; returns false only when the
// location must be refused outright (someone else's MO2 instance).
async function refreshInstallLocationWarnings() {
  const dir = installLocPath.value.trim()
  installLocWarning.hidden = true
  installLocWarning.textContent = ''
  installLocStatus.textContent = ''
  if (!dir) return true
  const r = await window.electronAPI.checkInstallLocation(dir)
  if (!r.ok) return true

  const warnings = []
  if (r.kind === 'nonEmpty') {
    warnings.push(`The chosen folder is not empty - the install will go into ${dir}\\VengefulRealms instead.`)
  }
  if (r.kind === 'foreignMo2') {
    warnings.push('That folder is an existing Mod Organizer 2 instance that does not belong to Vengeful Realms. Choose a different folder.')
  }
  if (r.lowSpace) {
    const gb = n => (n / 1024 / 1024 / 1024).toFixed(1)
    warnings.push(`Not enough disk space on that drive: ${gb(r.freeBytes)} GB free, about ${gb(r.requiredBytes)} GB needed.`)
  }
  if (r.kind === 'currentBase' || r.kind === 'legacyBase') {
    installLocStatus.textContent = 'Existing Vengeful Realms install detected - it will be reused and updated.'
  } else if (r.kind === 'mo2Subfolder') {
    installLocStatus.textContent = 'This is the MO2 folder of an existing install - its parent folder will be used.'
  }
  if (warnings.length) {
    installLocWarning.textContent = warnings.join('\n')
    installLocWarning.hidden = false
  }
  return r.kind !== 'foreignMo2'
}

async function openInstallLocationModal() {
  const iso = await window.electronAPI.isolatedStatus()
  installLocPath.value = iso.base || ''
  await refreshInstallLocationWarnings()
  installLocModal.hidden = false
}

installLocPath.addEventListener('change', refreshInstallLocationWarnings)
installLocBrowse.addEventListener('click', async () => {
  const dir = await window.electronAPI.pickInstallDir(installLocPath.value.trim())
  if (dir) {
    installLocPath.value = dir
    await refreshInstallLocationWarnings()
  }
})
installLocClose.addEventListener('click', () => {
  if (!installLocBusy) installLocModal.hidden = true
})

installLocConfirm.addEventListener('click', async () => {
  if (installLocBusy) return
  const dir = installLocPath.value.trim()
  if (!dir) {
    installLocWarning.textContent = 'Enter an install location.'
    installLocWarning.hidden = false
    return
  }
  if (!(await refreshInstallLocationWarnings())) return

  installLocBusy = true
  installLocConfirm.disabled = true
  installLocBrowse.disabled  = true
  installLocPath.disabled    = true
  window.electronAPI.removeIsolatedListeners()
  window.electronAPI.onIsolatedProgress(msg => { installLocStatus.textContent = msg })

  const result = await window.electronAPI.createIsolated(dir)

  window.electronAPI.removeIsolatedListeners()
  installLocBusy = false
  installLocConfirm.disabled = false
  installLocBrowse.disabled  = false
  installLocPath.disabled    = false

  if (!result.success) {
    if (!result.canceled) {
      installLocWarning.textContent = result.error
      installLocWarning.hidden = false
    }
    return
  }

  installLocModal.hidden = true
  installStatusIso.textContent = 'Game copy ready ✓ - installing the modpack (see the Mod Pack tab)'
  fieldIsolated.checked = true
  await window.electronAPI.saveSettings({ isolatedGame: true })
  refreshIsolatedStatus()
  refreshPlayState()
  startModpackInstall()
})

// Nexus login gate for the install flow: detect login, open OAuth when
// logged out, and only continue once the login lands.
async function ensureNexusLoginUI() {
  if (nexusUser) return true
  showWarning('Log in with Nexus Mods to continue - finish in the browser window that just opened…')
  const result = await window.electronAPI.nexusSsoLogin()
  if (!result.success) {
    showWarning(`Nexus login failed: ${result.error}`)
    return false
  }
  nexusUser = result.user
  renderTopbarNexus()
  clearWarning()
  return true
}

// Init
loadSettings()
checkServerStatus()
checkLauncherUpdate()
loadNews()
loadServerInfo()
loadModlist()
// Live 5s heartbeat: game-server status + players (topbar badge), client
// files update (Play button flips to INSTALL/UPDATE), launcher self-update
// (Play button flips to UPDATE LAUNCHER) - all without restarting the
// launcher. refreshPlayState polls on its own 5s timer above;
// pollGameRunning stays on a 10s timer (it spawns a tasklist probe).
setInterval(checkServerStatus, 5_000)
setInterval(checkLauncherUpdate, 5_000)
refreshPlayState()
