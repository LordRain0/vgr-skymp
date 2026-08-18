
const KEY_TO_DIK = {
  // ========== LETTERS (A-Z) ==========
  'KeyA': 30,
  'KeyB': 48,
  'KeyC': 46,
  'KeyD': 32,
  'KeyE': 18,
  'KeyF': 33,
  'KeyG': 34,
  'KeyH': 35,
  'KeyI': 23,
  'KeyJ': 36,
  'KeyK': 37,
  'KeyL': 38,
  'KeyM': 50,
  'KeyN': 49,
  'KeyO': 24,
  'KeyP': 25,
  'KeyQ': 16,
  'KeyR': 19,
  'KeyS': 31,
  'KeyT': 20,
  'KeyU': 22,
  'KeyV': 47,
  'KeyW': 17,
  'KeyX': 45,
  'KeyY': 21,
  'KeyZ': 44,

  // ========== NUMBERS (Top Row) ==========
  'Digit0': 11,
  'Digit1': 2,
  'Digit2': 3,
  'Digit3': 4,
  'Digit4': 5,
  'Digit5': 6,
  'Digit6': 7,
  'Digit7': 8,
  'Digit8': 9,
  'Digit9': 10,

  // ========== FUNCTION KEYS ==========
  'F1': 59,
  'F2': 60,
  'F3': 61,
  'F4': 62,
  'F5': 63,
  'F6': 64,
  'F7': 65,
  'F8': 66,
  'F9': 67,
  'F10': 68,
  'F11': 87,
  'F12': 88,
  'F13': 100,   // Usually Shift+F1
  'F14': 101,   // Usually Shift+F2
  'F15': 102,   // Usually Shift+F3

  // ========== MODIFIERS ==========
  'ShiftLeft': 42,
  'ShiftRight': 54,
  'ControlLeft': 29,
  'ControlRight': 29,    // DirectInput doesn't distinguish right Ctrl
  'AltLeft': 56,
  'AltRight': 56,        // DirectInput doesn't distinguish right Alt
  'MetaLeft': 91,        // Windows key (left)
  'MetaRight': 92,       // Windows key (right)
  
  // ========== NAVIGATION / EDITING ==========
  'ArrowUp': 72,
  'ArrowDown': 80,
  'ArrowLeft': 75,
  'ArrowRight': 77,
  'Home': 71,
  'End': 79,
  'PageUp': 73,
  'PageDown': 81,
  'Insert': 82,
  'Delete': 83,
  'Backspace': 14,
  'Enter': 28,
  'Tab': 15,
  'Space': 57,
  'Escape': 1,
  'CapsLock': 58,
  
  // ========== NUMPAD (NumLock ON) ==========
  'Numpad0': 82,
  'Numpad1': 79,
  'Numpad2': 80,
  'Numpad3': 81,
  'Numpad4': 75,
  'Numpad5': 76,
  'Numpad6': 77,
  'Numpad7': 71,
  'Numpad8': 72,
  'Numpad9': 73,
  'NumpadDecimal': 83,
  'NumpadDivide': 53,
  'NumpadMultiply': 55,
  'NumpadSubtract': 74,
  'NumpadAdd': 78,
  'NumpadEnter': 28,     // Same as regular Enter
  'NumpadEqual': 13,     // Some keyboards have '=' on numpad
  
  // ========== PUNCTUATION / SYMBOLS (US Layout) ==========
  'Backquote': 41,       // ` ~
  'Minus': 12,           // - _
  'Equal': 13,           // = +
  'BracketLeft': 26,     // [ {
  'BracketRight': 27,    // ] }
  'Backslash': 43,       // \ |
  'Semicolon': 39,       // ; :
  'Quote': 40,           // ' "
  'Comma': 51,           // , <
  'Period': 52,          // . >
  'Slash': 53,           // / ?
  'IntlBackslash': 86,   // \ | (ISO keyboards)
  'IntlRo': 89,          // International characters
  'IntlYen': 90,         // Yen key (Japanese)
  
  // ========== MEDIA KEYS ==========
  'AudioVolumeMute': 128,
  'AudioVolumeUp': 129,
  'AudioVolumeDown': 130,
  'MediaTrackNext': 131,
  'MediaTrackPrevious': 132,
  'MediaStop': 133,
  'MediaPlayPause': 134,
  'LaunchMail': 180,     // Email key
  'LaunchMediaPlayer': 177, // Media player key
  'LaunchApp1': 181,     // My Computer key
  'LaunchApp2': 182,     // Calculator key
  
  // ========== BROWSER KEYS ==========
  'BrowserSearch': 166,
  'BrowserFavorites': 167,
  'BrowserRefresh': 168,
  'BrowserStop': 169,
  'BrowserForward': 170,
  'BrowserBack': 171,
  'BrowserHome': 172,
  
  // ========== LOCK KEYS ==========
  'NumLock': 69,
  'ScrollLock': 70,
  'Pause': 68,           // Pause/Break key
  
  // ========== PRINTING ==========
  'PrintScreen': 55,     // May require special handling
  
  // ========== EXTRA KEYS ==========
  'ContextMenu': 93,     // Right-click menu key
  'Sleep': 95,           // Sleep key
  'WakeUp': 96,          // Wake key
  'Help': 97,            // Help key (old keyboards)
  
  // ========== OEM SPECIFIC ==========
  'OEMClear': 55,        // Clear key (some keyboards)
  'Abort': 99,           // Abort key
  'Process': 101,        // IME Process key
  'Convert': 102,        // IME Convert key
  'NonConvert': 103,     // IME NonConvert key
  'KanaMode': 104,       // Kana mode (Japanese)
  'Lang1': 105,          // Language 1 (Hangul/English)
  'Lang2': 106,          // Language 2 (Hanja)
  'Lang3': 107,          // Language 3
  'Lang4': 108,          // Language 4
  'Lang5': 109           // Language 5
};



let VGR_REGISTERED_UI = {
  "social": {
	active: false,
    keyCode: 'KeyG',
	persistent: false,
    need_focus: true,   // grabs focus
    interactionType: 'press', // 'hold' vs 'press' (full release of key)
    blocking: false,     // Whether it blocks other UI interactions
    z_index: 1         // Z-index or focus priority (higher = more important)
  },
  
  "emote": {
	active: false,
    keyCode: 'KeyB',
	persistent: false,
    need_focus: true,   // grabs focus
    interactionType: 'hold',
    blocking: false,
    z_index: 2
  },
  
  
  "woodcutting": {
	active: false,
    keyCode: null,			// No key assigned, event based
	persistent: false,
    need_focus: true,   // grabs focus
    interactionType: 'event', // gets called outside of keyevents
    blocking: true,      // Blocks gameplay input when open
    z_index: 10
  },
  
  "mining": {
	active: false,
    keyCode: null,			// No key assigned, event based
	persistent: false,
    need_focus: true,   // grabs focus
    interactionType: 'event', // gets called outside of keyevents
    blocking: true,      // Blocks gameplay input when open
    z_index: 10
  },
  "admin_menu": {
	active: false,
    keyCode: 'F3',
	persistent: false,
    need_focus: true,
    interactionType: 'press',
    blocking: false,
    z_index: 11,
    server_gated: true  // key press asks the server; only permitted players get the open
  },
  
  "player_search": {
	active: false,
    keyCode: null,
	persistent: true, //skips closing of active_ui if opened, doesnt set active_ui but sets active flag in UI registry if opened: same for closing behavior
    need_focus: true,
    interactionType: 'event',
    blocking: false,
    z_index: 11
  },

  "trading": {
    active: false,
    keyCode: null,
    persistent: false,
    need_focus: true,
    interactionType: 'event',
    blocking: true,
    z_index: 10
  },

  "enchanting": {
    active: false,
    keyCode: null,          // opened by the server when activating a station
    persistent: false,
    need_focus: true,
    interactionType: 'event',
    blocking: true,
    z_index: 10
  },

  "locks": {
    active: false,
    keyCode: null,
    persistent: false,
    need_focus: true,
    interactionType: 'event',
    blocking: true,
    z_index: 10
  },

  "access_control": {
    active: false,
    keyCode: null,
    persistent: false,
    need_focus: true,
    interactionType: 'event',
    blocking: true,
    z_index: 12
  },

  "player_interaction": {
    active: false,
    keyCode: null,
    persistent: false,
    need_focus: true,
    interactionType: 'event',
    blocking: true,
    z_index: 13
  },

  "trade_request": {
    active: false,
    keyCode: null,
    persistent: false,
    need_focus: true,
    interactionType: 'event',
    blocking: true,
    z_index: 13
  },
  
  "debugview": {
    active: false,
    keyCode: "F5",
    persistent: true,
    need_focus: false,
    interactionType: 'press',
    blocking: true,
    z_index: 10
  },

  "skills": {
    active: false,
    keyCode: 'KeyK',
    persistent: false,
    need_focus: true,   // grabs focus
    interactionType: 'press',
    blocking: false,
    z_index: 11
  }

};

const VGR_KEY_SPECIAL = {
  "focus_key": {keyCodes: []},
  "cancel_idle_anim_key": {keyCodes: ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space']},
  "force_ui_close_key": {keyCodes: ['Escape']}
};


//extra properties to determine UI behavior:

//default: closes active ui, opens new one on change
//persistent: only closes ui when explicitly told to, opens new ui regardless and marks it as active // Stays open even when unfocused
//keypress_hold: defines wether key needs to be hold to keep ui open or only pressed once, then pressed again to close, new ui can only be opened once registered key for active ui has been released


let active_ui = null;

let browser_keyStates = new Map();

let vgr_closeKeys = null;

//let browser_focused = false;
//let browser_keyStates = new Map();


// Called by gamemode via browser.executeJavaScript()
function vgrGameplayUiAvailable() {
  return !window.VGRUI || window.VGRUI.mode === "gameplay";
}

function vgrShowUI(name) {
	if (!vgrGameplayUiAvailable()) return false;

	window.skyrimPlatform?.sendMessage?.("vgr:ui:on_open", name); //fires browser message to track if UI element got opened or closed
	
	if (VGR_REGISTERED_UI[name].persistent == false) { //only register nonpersistent UI
		active_ui = name;
	}
	
	window.dispatchEvent(new CustomEvent('vgr:ui_manager:open:' + name));
	
	VGR_REGISTERED_UI[name].active = true;
}

function vgrHideUI(name) {
	window.skyrimPlatform?.sendMessage?.("vgr:ui:on_close", name); //fires browser message to track if UI element got opened or closed
	
	window.dispatchEvent(new CustomEvent('vgr:ui_manager:close:' + name));
	
	VGR_REGISTERED_UI[name].active = false;
}

function vgrHideActiveUI() {
	vgrHideUI(active_ui);
}


function vgrConsumeKeyEvent(e) {
  if (!e) return;

  e.preventDefault();

  if (typeof e.stopImmediatePropagation === "function") {
    e.stopImmediatePropagation();
  } else {
    e.stopPropagation();
  }
}

function initCloseKeys() {
	
	const vgr_close_keys = Object.values(VGR_REGISTERED_UI)
	  .filter(ui => //ui.interactionType === 'press' && 
					ui.blocking === false &&
					ui.keyCode !== null)
	  .map(ui => ui.keyCode)
	  .filter(keyCode => keyCode !== null); // Exclude null values
	
	// Output: ['KeyG'] (only "social" matches the criteria)
	
	vgr_closeKeys = new Set([...VGR_KEY_SPECIAL["force_ui_close_key"].keyCodes, ...VGR_KEY_SPECIAL["focus_key"].keyCodes, ...VGR_KEY_SPECIAL["cancel_idle_anim_key"].keyCodes, ...vgr_close_keys]);
	
}


// When the browser has focus, the game engine never sees key presses â€” the
// browser absorbs them. So we handle the close keys here and send a message
// back to the server, which then calls closeUI() and releases focus.
window.addEventListener('keydown', (e) => {
    if (!vgrGameplayUiAvailable()) return;
    if (e.repeat) return; // ignore key-held repeats â€” only fire once per physical press
	
	if (!vgr_closeKeys || !vgr_closeKeys.has(e.code)) return;
	const tag = document.activeElement && document.activeElement.tagName;
	if (tag === 'INPUT' || tag === 'TEXTAREA') return;
	
	const dikCode = KEY_TO_DIK[e.code];
	if (dikCode === undefined) return;
	
	vgrConsumeKeyEvent(e);
	
	const isRepeat = browser_keyStates.get(dikCode);
	if (isRepeat) return;
	
	//console.log("Key: " + e.code + " was pressed");
	
	browser_keyStates.set(dikCode, true);
	window.skyrimPlatform?.sendMessage?.('vgr:ui:keydown', KEY_TO_DIK[e.code]);
	
});

window.addEventListener('keyup', (e) => {
    if (!vgrGameplayUiAvailable()) return;
    if (e.repeat) return; // ignore key-release repeats â€” only fire once per physical release
	
	if (!vgr_closeKeys || !vgr_closeKeys.has(e.code)) return;
	const tag = document.activeElement && document.activeElement.tagName;
	if (tag === 'INPUT' || tag === 'TEXTAREA') return;
	
	const dikCode = KEY_TO_DIK[e.code];
	if (dikCode === undefined) return;
	
	vgrConsumeKeyEvent(e);
	
	browser_keyStates.set(dikCode, false);
	window.skyrimPlatform?.sendMessage?.('vgr:ui:keyup', KEY_TO_DIK[e.code]);
	
});



function vgrReleaseBrowserInput() {
  if (document.activeElement && document.activeElement.blur) {
    document.activeElement.blur();
  }

  if (window.getSelection) {
    const selection = window.getSelection();
    if (selection) selection.removeAllRanges();
  }
}



function vgrInitRegistryUI() {
	// Add DIK codes dynamically after object creation
	for (const [key, ui] of Object.entries(VGR_REGISTERED_UI)) {
		if (ui.keyCode) {
			ui.dikCode = KEY_TO_DIK[ui.keyCode];
		} else {
			ui.dikCode = null;
		}
	}
	
	// Add DIK codes dynamically after object creation
	for (const [key, special] of Object.entries(VGR_KEY_SPECIAL)) {
	  if (Array.isArray(special.keyCodes)) {
		special.dikCodes = special.keyCodes
		  .map((keyCode) => KEY_TO_DIK[keyCode])
		  .filter((dikCode) => dikCode !== undefined);
	  } else {
		special.dikCodes = [];
	  }
	}
	
	initCloseKeys();
	
	window.skyrimPlatform?.sendMessage?.('vgr:ui:init', VGR_REGISTERED_UI, VGR_KEY_SPECIAL);
}



window.vgrShowUI = vgrShowUI;
window.vgrHideUI = vgrHideUI;
window.vgrHideActiveUI = vgrHideActiveUI;
window.browser_keyStates = browser_keyStates;
window.vgrReleaseBrowserInput = vgrReleaseBrowserInput;
window.vgrInitRegistryUI = vgrInitRegistryUI;
window.vgrGameplayUiAvailable = vgrGameplayUiAvailable;

//vgrInitRegistryUI();

