// ============================================================================
// VGR catalog generator
// ============================================================================
// Produces searchable catalogs of every item / ability / NPC base record in the
// server's load order, for the admin-panel spawner + gift pickers. Runtime
// formIds match what the game server sees (mp.lookupEspmRecordById). Names are
// resolved through .strings tables (extracted from the vanilla BSA for
// localized masters; inline for most mod plugins).
//
// Usage:
//   node tools/build_catalogs.js \
//     --settings build/dist/server/server-settings.json \
//     --data     W:/VengefulRealms/skyrim/Data \
//     --strings  "W:/VengefulRealms/skyrim/Data/Skyrim - Interface.bsa" \
//     --out      vgr-frontend/js/data
//   (add --validate to print known-formId checks; --lang english is default)
//
// Output: <out>/item_catalog.json, ability_catalog.json, npc_catalog.json
//   each { generatedFrom, count, entries: [{ id:"0x...", t:"WEAP", n:"Name", e:"EditorId" }] }
'use strict';
const fs = require('fs');
const path = require('path');
const { readBsa } = require('./lib/bsa');
const { parseStrings } = require('./lib/strings');
const { loadPlugin, walkRecords } = require('./lib/plugin');

// ----- args -----
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) {
    const key = a.slice(2);
    const next = process.argv[i + 1];
    if (next && !next.startsWith('--')) { args[key] = next; i++; }
    else args[key] = true;
  }
}
const SETTINGS = args.settings || 'build/dist/server/server-settings.json';
const DATA_DIR = args.data || 'W:/VengefulRealms/skyrim/Data';
const STRINGS_BSA = args.strings || path.join(DATA_DIR, 'Skyrim - Interface.bsa');
const OUT_DIR = args.out || 'vgr-frontend/js/data';
const LANG = (args.lang || 'english').toLowerCase();
const VALIDATE = !!args.validate;

const ITEM_TYPES = ['WEAP', 'ARMO', 'AMMO', 'ALCH', 'INGR', 'BOOK', 'MISC', 'SCRL', 'SLGM', 'KEYM', 'LIGH'];
const ABILITY_TYPES = ['SPEL', 'PERK', 'SHOU'];
const NPC_TYPES = ['NPC_'];
const ALL_TYPES = [...ITEM_TYPES, ...ABILITY_TYPES, ...NPC_TYPES];

// ----- load order from server settings -----
const settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
const loadOrder = settings.loadOrder;
if (!Array.isArray(loadOrder)) { console.error('server-settings.json has no loadOrder array'); process.exit(1); }
// loadOrder entries may be absolute paths; reduce to basenames
const orderNames = loadOrder.map((p) => path.basename(String(p)));

// ----- strings tables (lazy per plugin base name) -----
// Pull every *_<lang>.strings out of the vanilla BSA up front.
const bsaStrings = new Map(); // "skyrim_english.strings" -> Map(id->name)
(function loadBsaStrings() {
  if (!fs.existsSync(STRINGS_BSA)) { console.warn('strings BSA not found:', STRINGS_BSA); return; }
  const bsa = readBsa(STRINGS_BSA);
  for (const f of bsa.files) {
    if (!/^strings$/i.test(f.folderName)) continue;
    if (!f.name.toLowerCase().endsWith('.strings')) continue; // FULL uses .STRINGS only
    if (!f.name.toLowerCase().includes('_' + LANG + '.')) continue;
    try {
      bsaStrings.set(f.name.toLowerCase(), parseStrings(bsa.extract(f), false));
    } catch (e) { console.warn('strings parse failed:', f.name, e.message); }
  }
  console.log('loaded', bsaStrings.size, LANG, '.strings tables from BSA');
})();

const looseStringsCache = new Map();
function stringsFor(pluginBase) {
  const key = pluginBase.toLowerCase().replace(/\.(esm|esp|esl)$/, '') + '_' + LANG + '.strings';
  if (bsaStrings.has(key)) return bsaStrings.get(key);
  if (looseStringsCache.has(key)) return looseStringsCache.get(key);
  const loose = path.join(DATA_DIR, 'Strings', key);
  let table = null;
  if (fs.existsSync(loose)) {
    try { table = parseStrings(fs.readFileSync(loose), false); } catch (e) { /* ignore */ }
  }
  looseStringsCache.set(key, table);
  return table;
}

// ----- load-order slot map (full/light index per plugin) -----
const slotMap = new Map(); // lower name -> {kind:'full'|'light', index}
{
  let fullIdx = 0, lightIdx = 0;
  for (const name of orderNames) {
    const full = path.join(DATA_DIR, name);
    if (!fs.existsSync(full)) { console.warn('load-order plugin missing on disk:', name); continue; }
    let light = /\.esl$/i.test(name);
    if (!light) {
      // peek the TES4 light flag without a full parse
      try { light = loadPlugin(full).header.light; } catch (e) { /* treat as full */ }
    }
    if (light) slotMap.set(name.toLowerCase(), { kind: 'light', index: lightIdx++ });
    else slotMap.set(name.toLowerCase(), { kind: 'full', index: fullIdx++ });
  }
}

function runtimeFormId(ownerNameLower, objectId) {
  const slot = slotMap.get(ownerNameLower);
  if (!slot) return null;
  if (slot.kind === 'light') return (0xFE000000 | ((slot.index & 0xFFF) << 12) | (objectId & 0xFFF)) >>> 0;
  return (((slot.index & 0xFF) << 24) | (objectId & 0xFFFFFF)) >>> 0;
}

// ----- scan -----
// catalog key = runtime formId; last plugin in load order wins (override semantics)
const catalog = new Map(); // formId -> { t, n, e }
let scanned = 0;

for (const name of orderNames) {
  const full = path.join(DATA_DIR, name);
  if (!fs.existsSync(full)) continue;
  let plugin;
  try { plugin = loadPlugin(full); } catch (e) { console.warn('skip', name, '-', e.message); continue; }
  const masters = plugin.header.masters;
  const localized = plugin.header.localized;
  const selfIndex = masters.length; // this plugin's own high byte

  walkRecords(plugin.buf, ALL_TYPES, (rec) => {
    scanned++;
    const highByte = (rec.formId >>> 24) & 0xFF;
    const objectId = rec.formId & 0xFFFFFF;
    // which plugin owns this record?
    const ownerName = (highByte < masters.length) ? masters[highByte] : name;
    const rtId = runtimeFormId(ownerName.toLowerCase(), objectId);
    if (rtId === null) return;

    // resolve name
    let displayName = null;
    if (rec.full && rec.full.length) {
      if (localized) {
        if (rec.full.length >= 4) {
          const stringId = rec.full.readUInt32LE(0);
          const table = stringsFor(name);
          if (table && table.has(stringId)) displayName = table.get(stringId);
        }
      } else {
        let e = 0; while (e < rec.full.length && rec.full[e] !== 0) e++;
        displayName = rec.full.toString('latin1', 0, e);
      }
    }

    const prev = catalog.get(rtId) || {};
    catalog.set(rtId, {
      t: rec.type,
      n: displayName || prev.n || null,
      e: rec.editorId || prev.e || null
    });
  });
}

console.log('scanned', scanned, 'records ->', catalog.size, 'distinct runtime forms');

// ----- split + write -----
function hex(id) { return '0x' + id.toString(16).toUpperCase().padStart(8, '0'); }

const buckets = {
  item: { types: new Set(ITEM_TYPES), entries: [] },
  ability: { types: new Set(ABILITY_TYPES), entries: [] },
  npc: { types: new Set(NPC_TYPES), entries: [] }
};

for (const [id, rec] of catalog) {
  // drop nameless non-NPC records (not player-facing); keep NPCs even if only editorId
  const name = rec.n || rec.e;
  if (!name) continue;
  const entry = { id: hex(id), t: rec.t, n: rec.n || rec.e, e: rec.e || '' };
  for (const b of Object.values(buckets)) {
    if (b.types.has(rec.t)) { b.entries.push(entry); break; }
  }
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const stamp = { generatedFrom: path.basename(SETTINGS), plugins: orderNames.length, lang: LANG };
const GLOBALS = { item: 'VGR_ITEM_CATALOG', ability: 'VGR_ABILITY_CATALOG', npc: 'VGR_NPC_CATALOG' };
for (const [key, b] of Object.entries(buckets)) {
  b.entries.sort((a, z) => a.n.localeCompare(z.n));
  const data = { ...stamp, count: b.entries.length, entries: b.entries };
  // Emit .js (window global) for CEF <script> loading - CEF blocks fetch() of
  // local files, so the admin UI loads catalogs as scripts, not JSON fetches.
  const outPath = path.join(OUT_DIR, key + '_catalog.js');
  fs.writeFileSync(outPath, 'window.' + GLOBALS[key] + '=' + JSON.stringify(data) + ';\n');
  const bytes = fs.statSync(outPath).size;
  console.log(key + '_catalog.js:', b.entries.length, 'entries,', (bytes / 1024).toFixed(0), 'KB');
}

// ----- validation -----
if (VALIDATE) {
  // known-good formIds from the professions proposal spawn-kit table
  const checks = [
    [0x0001397E, 'Iron Dagger', 'WEAP'],
    [0x0002F2F4, "Woodcutter's Axe", 'WEAP'],
    [0x000E3C16, 'Pickaxe', 'WEAP'],
    [0x000209A5, 'Farm Boots', 'ARMO'],
    [0x000722C2, 'Rabbit Haunch', 'ALCH'],
    [0x0000000F, 'Gold', 'MISC'],
  ];
  console.log('\n--- validation ---');
  for (const [id, expectName, expectType] of checks) {
    const rec = catalog.get(id >>> 0);
    const ok = rec && (!expectName || rec.n === expectName) && (!expectType || rec.t === expectType);
    console.log(ok ? 'PASS' : 'FAIL', hex(id), '->', rec ? (rec.t + ' "' + rec.n + '"') : 'NOT FOUND',
      expectName ? '(expected "' + expectName + '")' : '');
  }
}
