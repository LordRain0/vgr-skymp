// ============================================================================
// VGR crafting data generator (alchemy + enchanting)
// ============================================================================
// Emits the data the profession-crafting systems need, all as STATIC runtime
// formIds from the server load order (the escape hatch from vanilla's
// dynamic-form crafting):
//   - ingredients: every INGR with its 4 effect MGEFs (traits UI + server-side
//     vanilla-style effect matching)
//   - potionFamilies: canonical tiered ALCH records grouped by primary effect
//     (crafted potion = pick family by matched effect, tier by profession)
//   - enchantRecipes: pre-enchanted WEAP/ARMO variants linked to their base
//     item by display-name prefix and to their ENCH via EITM
//   - stations: FURN formIds for alchemy labs / enchanting tables (activation
//     gate) plus SLGM soul gems
//
// Usage: node tools/build_crafting_catalogs.js
//   [--settings build/dist/server/server-settings.json]
//   [--data build/dist/server/data]
//   [--strings "W:/VengefulRealms/skyrim/Data/Skyrim - Interface.bsa"]
// Outputs:
//   vgr-gamemode/gamemode_extensions/vgr_crafting_data.json  (server)
//   vgr-frontend/js/data/crafting_catalog.js                 (UI global)
'use strict';
const fs = require('fs');
const path = require('path');
const { readBsa } = require('./lib/bsa');
const { parseStrings } = require('./lib/strings');
const { loadPlugin, walkRecords } = require('./lib/plugin');

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) {
    const next = process.argv[i + 1];
    if (next && !next.startsWith('--')) { args[a.slice(2)] = next; i++; }
    else args[a.slice(2)] = true;
  }
}
const SETTINGS = args.settings || 'build/dist/server/server-settings.json';
const DATA_DIR = args.data || 'build/dist/server/data';
const STRINGS_BSA = args.strings || 'W:/VengefulRealms/skyrim/Data/Skyrim - Interface.bsa';
const LANG = (args.lang || 'english').toLowerCase();
const OUT_SERVER = args.outServer || 'vgr-gamemode/gamemode_extensions/vgr_crafting_data.json';
const OUT_UI = args.outUi || 'vgr-frontend/js/data/crafting_catalog.js';

// ---------- load order / slot map / strings (same model as build_catalogs) ----------
const settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
const orderNames = settings.loadOrder.map((p) => path.basename(String(p)));

const bsaStrings = new Map();
if (fs.existsSync(STRINGS_BSA)) {
  const bsa = readBsa(STRINGS_BSA);
  for (const f of bsa.files) {
    if (!/^strings$/i.test(f.folderName)) continue;
    if (!f.name.toLowerCase().endsWith('.strings')) continue;
    if (!f.name.toLowerCase().includes('_' + LANG + '.')) continue;
    try { bsaStrings.set(f.name.toLowerCase(), parseStrings(bsa.extract(f), false)); } catch (e) { }
  }
}
function stringsFor(pluginBase) {
  const key = pluginBase.toLowerCase().replace(/\.(esm|esp|esl)$/, '') + '_' + LANG + '.strings';
  return bsaStrings.get(key) || null;
}

const slotMap = new Map();
{
  let fullIdx = 0, lightIdx = 0;
  for (const name of orderNames) {
    const full = path.join(DATA_DIR, name);
    if (!fs.existsSync(full)) continue;
    let light = /\.esl$/i.test(name);
    if (!light) { try { light = loadPlugin(full).header.light; } catch (e) { } }
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
function hex(id) { return '0x' + id.toString(16).toUpperCase().padStart(8, '0'); }

// ---------- scan ----------
// keyed by runtime formId, last plugin wins
const mgef = new Map();   // id -> {n, e}
const ingr = new Map();   // id -> {n, e, effects: [mgefRuntimeId x4]}
const alch = new Map();   // id -> {n, e, effects: [{mgef, mag, dur}], flags}
const ench = new Map();   // id -> {n, e}
const items = new Map();  // id -> {t, n, e, eitm}  (WEAP/ARMO)
const furn = new Map();   // id -> {n, e}
const slgm = new Map();   // id -> {n, e}

const COLLECT = {
  INGR: new Set(['EFID', 'EFIT']),
  ALCH: new Set(['EFID', 'EFIT', 'ENIT']),
  WEAP: new Set(['EITM']),
  ARMO: new Set(['EITM']),
};

for (const name of orderNames) {
  const full = path.join(DATA_DIR, name);
  if (!fs.existsSync(full)) continue;
  let plugin;
  try { plugin = loadPlugin(full); } catch (e) { continue; }
  const masters = plugin.header.masters;
  const localized = plugin.header.localized;

  // resolve a formId REFERENCE inside this plugin (same master-table remap as
  // the record's own id)
  const resolveRef = (rawId) => {
    const hi = (rawId >>> 24) & 0xFF;
    const owner = (hi < masters.length) ? masters[hi] : name;
    return runtimeFormId(owner.toLowerCase(), rawId & 0xFFFFFF);
  };
  const resolveName = (rec) => {
    if (!rec.full || !rec.full.length) return null;
    if (localized) {
      if (rec.full.length < 4) return null;
      const table = stringsFor(name);
      const sid = rec.full.readUInt32LE(0);
      return (table && table.get(sid)) || null;
    }
    let e = 0; while (e < rec.full.length && rec.full[e] !== 0) e++;
    return rec.full.toString('latin1', 0, e);
  };

  walkRecords(plugin.buf, ['MGEF', 'INGR', 'ALCH', 'ENCH', 'WEAP', 'ARMO', 'FURN', 'SLGM'], (rec) => {
    const rtId = resolveRef(rec.formId);
    if (rtId === null) return;
    const n = resolveName(rec);
    const e = rec.editorId;

    if (rec.type === 'MGEF') {
      const prev = mgef.get(rtId) || {};
      mgef.set(rtId, { n: n || prev.n || null, e: e || prev.e || null });
    } else if (rec.type === 'INGR') {
      const effects = [];
      for (const f of rec.fields || []) {
        if (f.type === 'EFID' && f.data.length >= 4) {
          const ref = resolveRef(f.data.readUInt32LE(0));
          if (ref !== null) effects.push(ref);
        }
      }
      const prev = ingr.get(rtId) || {};
      ingr.set(rtId, { n: n || prev.n || null, e: e || prev.e || null, effects: effects.length ? effects : (prev.effects || []) });
    } else if (rec.type === 'ALCH') {
      const effects = [];
      let flags = 0;
      let pendingMgef = null;
      for (const f of rec.fields || []) {
        if (f.type === 'ENIT' && f.data.length >= 8) flags = f.data.readUInt32LE(4);
        else if (f.type === 'EFID' && f.data.length >= 4) pendingMgef = resolveRef(f.data.readUInt32LE(0));
        else if (f.type === 'EFIT' && f.data.length >= 12 && pendingMgef !== null) {
          effects.push({ mgef: pendingMgef, mag: f.data.readFloatLE(0), dur: f.data.readUInt32LE(8) });
          pendingMgef = null;
        }
      }
      const prev = alch.get(rtId) || {};
      alch.set(rtId, { n: n || prev.n || null, e: e || prev.e || null, effects: effects.length ? effects : (prev.effects || []), flags: flags || prev.flags || 0 });
    } else if (rec.type === 'ENCH') {
      const prev = ench.get(rtId) || {};
      ench.set(rtId, { n: n || prev.n || null, e: e || prev.e || null });
    } else if (rec.type === 'WEAP' || rec.type === 'ARMO') {
      let eitm = null;
      for (const f of rec.fields || []) {
        if (f.type === 'EITM' && f.data.length >= 4) eitm = resolveRef(f.data.readUInt32LE(0));
      }
      const prev = items.get(rtId) || {};
      items.set(rtId, { t: rec.type, n: n || prev.n || null, e: e || prev.e || null, eitm: eitm !== null ? eitm : (prev.eitm !== undefined ? prev.eitm : null) });
    } else if (rec.type === 'FURN') {
      const prev = furn.get(rtId) || {};
      furn.set(rtId, { n: n || prev.n || null, e: e || prev.e || null });
    } else if (rec.type === 'SLGM') {
      const prev = slgm.get(rtId) || {};
      slgm.set(rtId, { n: n || prev.n || null, e: e || prev.e || null });
    }
  }, { collectFields: COLLECT });
}

console.log('scanned:', mgef.size, 'MGEF |', ingr.size, 'INGR |', alch.size, 'ALCH |',
  ench.size, 'ENCH |', items.size, 'WEAP/ARMO |', furn.size, 'FURN |', slgm.size, 'SLGM');

// ---------- post-process ----------
const ALCH_FLAG_POISON = 0x20000;
const ALCH_FLAG_FOOD = 0x2;

// 1) potion families: standard tiered potions/poisons grouped by primary MGEF.
//    "Standard" = the auto-tiered vanilla families (editorId ends in a digit
//    pair/tier marker and record has >= 1 effect and a display name).
const STANDARD_RX = /^(Restore(Health|Magicka|Stamina)\d+|Fortify\w*?\d+|Resist(Fire|Frost|Shock|Magic)\d+|Regenerate\w*?\d+|Damage\w*?\d+|Lingering\w*?\d+|Weakness\w*?\d+|Paralyze\d+|Fear\d+|Frenzy\d+|Invisibility\d*|Waterbreathing\d*|CureDisease|CurePoison|Silence\d*|MarksmanFear\d+)$/i;
const families = {};
for (const [id, rec] of alch) {
  if (!rec.n || !rec.effects.length || !rec.e) continue;
  if (!STANDARD_RX.test(rec.e)) continue;
  const primary = rec.effects[0].mgef;
  const key = hex(primary);
  if (!families[key]) {
    const m = mgef.get(primary);
    families[key] = { effectName: (m && (m.n || m.e)) || key, isPoison: !!(rec.flags & ALCH_FLAG_POISON), potions: [] };
  }
  families[key].potions.push({ id: hex(id), e: rec.e, n: rec.n, mag: rec.effects[0].mag, dur: rec.effects[0].dur });
}
// Vanilla splits some ladders across MGEF variants with identical display
// names (RestoreHealth01-05 use 0x3EB15, RestoreHealth06 uses 0xFFA03).
// Merge families sharing (name, poison flag) into ONE tier ladder and alias
// the merged ladder under every member MGEF id, so server-side ingredient
// matching resolves no matter which variant the ingredient references.
{
  const byName = new Map();
  for (const [key, fam] of Object.entries(families)) {
    const nameKey = fam.effectName.toLowerCase() + '|' + (fam.isPoison ? 1 : 0);
    if (!byName.has(nameKey)) byName.set(nameKey, []);
    byName.get(nameKey).push(key);
  }
  for (const keys of byName.values()) {
    if (keys.length < 2) continue;
    const merged = { effectName: families[keys[0]].effectName, isPoison: families[keys[0]].isPoison, potions: [] };
    for (const k of keys) merged.potions.push(...families[k].potions);
    for (const k of keys) families[k] = merged; // same object under each alias
  }
}
const tiered = new Set();
for (const fam of Object.values(families)) {
  if (tiered.has(fam)) continue;
  tiered.add(fam);
  fam.potions.sort((a, b) => (a.mag - b.mag) || (a.dur - b.dur));
  fam.potions.forEach((p, i) => { p.tier = i + 1; });
}
const famCount = tiered.size;
const famPotions = Array.from(tiered).reduce((s, f) => s + f.potions.length, 0);

// 2) ingredients with effect names (traits UI + matching)
const ingredients = {};
for (const [id, rec] of ingr) {
  if (!rec.effects.length) continue;
  ingredients[hex(id)] = {
    n: rec.n || rec.e || hex(id),
    effects: rec.effects.map((mid) => {
      const m = mgef.get(mid);
      return { id: hex(mid), n: (m && (m.n || m.e)) || hex(mid) };
    })
  };
}

// 3) enchant recipes: pre-enchanted item -> base item by display-name prefix
//    ("Iron Sword of Burning" -> base "Iron Sword"), enchantment via EITM.
const basesByName = new Map(); // display name -> [{id, t}] (unenchanted only)
for (const [id, rec] of items) {
  if (rec.eitm !== null || !rec.n) continue;
  if (!basesByName.has(rec.n)) basesByName.set(rec.n, []);
  basesByName.get(rec.n).push({ id, t: rec.t });
}
const enchantRecipes = [];
let unmatchedEnchanted = 0;
for (const [id, rec] of items) {
  if (rec.eitm === null || !rec.n) continue;
  // find the longest unenchanted base name that prefixes "<base> of <suffix>"
  const ofIdx = rec.n.indexOf(' of ');
  if (ofIdx <= 0) { unmatchedEnchanted++; continue; }
  const baseName = rec.n.slice(0, ofIdx);
  const candidates = (basesByName.get(baseName) || []).filter((b) => b.t === rec.t);
  if (!candidates.length) { unmatchedEnchanted++; continue; }
  const enchRec = ench.get(rec.eitm);
  enchantRecipes.push({
    result: hex(id), resultName: rec.n, t: rec.t,
    base: hex(candidates[0].id), baseName: baseName,
    ench: hex(rec.eitm), enchName: (enchRec && (enchRec.n || enchRec.e)) || hex(rec.eitm),
    tier: (rec.e && (rec.e.match(/(\d+)$/) || [])[1]) ? parseInt(rec.e.match(/(\d+)$/)[1], 10) : 1
  });
}

// 4) stations + soul gems
const stations = { alchemy: [], enchanting: [] };
for (const [id, rec] of furn) {
  const label = (rec.e || '') + ' ' + (rec.n || '');
  if (/alchemy/i.test(label)) stations.alchemy.push({ id: hex(id), e: rec.e, n: rec.n });
  else if (/enchant|arcane/i.test(label)) stations.enchanting.push({ id: hex(id), e: rec.e, n: rec.n });
}
const soulGems = [];
for (const [id, rec] of slgm) soulGems.push({ id: hex(id), e: rec.e, n: rec.n });

// ---------- emit ----------
const serverData = {
  generatedFrom: path.basename(SETTINGS), lang: LANG,
  ingredients, potionFamilies: families, enchantRecipes, stations, soulGems
};
fs.writeFileSync(OUT_SERVER, JSON.stringify(serverData));
console.log('server data:', OUT_SERVER, '-', (fs.statSync(OUT_SERVER).size / 1024).toFixed(0), 'KB');
console.log('  ingredients:', Object.keys(ingredients).length,
  '| potion families:', famCount, '(' + famPotions + ' potions)',
  '| enchant recipes:', enchantRecipes.length, '(' + unmatchedEnchanted + ' unmatched)',
  '| stations: alch', stations.alchemy.length, 'ench', stations.enchanting.length,
  '| soul gems:', soulGems.length);

const uiData = {
  ingredients,
  enchantRecipes: enchantRecipes.map((r) => ({ result: r.result, resultName: r.resultName, base: r.base, baseName: r.baseName, enchName: r.enchName, tier: r.tier, t: r.t }))
};
fs.writeFileSync(OUT_UI, 'window.VGR_CRAFTING_CATALOG=' + JSON.stringify(uiData) + ';\n');
console.log('ui data:', OUT_UI, '-', (fs.statSync(OUT_UI).size / 1024).toFixed(0), 'KB');

// ---------- validation ----------
const checks = [
  ['ingredient Wheat has RestoreHealth', () => {
    const w = Object.values(ingredients).find((i) => i.n === 'Wheat');
    return w && w.effects.some((ef) => /restore health/i.test(ef.n));
  }],
  ['RestoreHealth family has >= 4 tiers', () => {
    const fam = Object.values(families).find((f) => /restore health/i.test(f.effectName) && !f.isPoison);
    return fam && fam.potions.length >= 4;
  }],
  ['some Iron Sword enchant recipe exists', () => enchantRecipes.some((r) => r.baseName === 'Iron Sword')],
  ['alchemy stations found', () => stations.alchemy.length > 0],
  ['enchanting stations found', () => stations.enchanting.length > 0],
];
console.log('--- validation ---');
let failed = 0;
for (const [label, fn] of checks) {
  let ok = false; try { ok = !!fn(); } catch (e) { }
  if (!ok) failed++;
  console.log(ok ? 'PASS' : 'FAIL', label);
}
process.exitCode = failed ? 1 : 0;
