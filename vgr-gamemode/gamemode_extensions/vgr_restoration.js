// ==========================================
// VGR RESTORATION (server-authoritative heals)
// ==========================================
// The frozen native (Aug-11) relays SpellCast to neighbours and fires the
// OnSpellCast papyrus event, but applies NOTHING server-side (the old TODO at
// ActionListener.cpp:1224) while CropRegeneration actively crops any client
// reported health gain. This extension is the gamemode-layer equivalent of
// Alduinak commits 86cc1b04a + f4d5ac35d: it validates restorative spells
// against the espm load order and applies them through the Papyrus
// Actor.RestoreActorValue bridge, which the native turns into
// ModifyActorValuePercentage + NetSetPercentages (authoritative broadcast,
// regen-crop baseline follows the new values).
//
// Detection paths (both feed the same validator, 1s dedupe between them):
//   A. mp["onPapyrusEvent:OnSpellCast"] - native fires it for every accepted
//      cast (equipment-gated) with (casterFormId, {type:"espm", desc}).
//      Carries no target, so it can only settle self-delivery heals.
//   B. "_vgrHealCast" client event source - hooks ctx.sp.on("spellCast")
//      (SpellCastEvent: caster/target/spell/castingSource in the frozen SP)
//      for aimed heals, plus a casting-anim poll (IsCastingRight/Left/Dual,
//      the exact vars the Alduinak client checked) that drives concentration
//      channel ticks and the stop signal.
//
// Server config (server-settings.json / settings):
//   "vgrRestoration": {
//     "enabled": true,        // master switch, default true
//     "maxRange": 4096,       // max units for aimed heals, same cell required
//     "tickIntervalMs": 1000, // concentration tick period (client + server)
//     "maxChannelTicks": 30,  // hard cap per channel (30s at 1s ticks)
//     "debug": false          // per-heal logging, default off
//   }
//
// Wire-up (done by the orchestrator, NOT by this file):
//   require(path.join(extensionsDir, 'vgr_restoration.js'))(mp);

module.exports = (mp) => {

  const LOG = "[VGR restoration]";

  let settings = {};
  try { settings = mp.getServerSettings ? (mp.getServerSettings() || {}) : {}; } catch (e) { settings = {}; }
  const raw = (settings && typeof settings.vgrRestoration === "object" && settings.vgrRestoration) || {};
  const CFG = {
    enabled: raw.enabled !== false,
    maxRange: Number(raw.maxRange) > 0 ? Number(raw.maxRange) : 4096,
    tickIntervalMs: Number(raw.tickIntervalMs) > 0 ? Number(raw.tickIntervalMs) : 1000,
    maxChannelTicks: Number(raw.maxChannelTicks) > 0 ? Number(raw.maxChannelTicks) : 30,
    debug: raw.debug === true,
  };

  const dbg = (...args) => { if (CFG.debug) console.log(LOG, ...args); };

  if (!CFG.enabled) {
    console.log(LOG, "disabled via settings.vgrRestoration.enabled");
    return;
  }

  // Same two Papyrus arg shapes as vgr_npcs: "form" resolves a world
  // reference (the heal target actor), "espm" a base record.
  const asForm = (formId) => ({ type: "form", desc: mp.getDescFromId(formId) });

  const safeGet = (id, prop) => { try { return mp.get(id, prop); } catch (e) { return undefined; } };

  // ----- espm byte readers (lookupEspmRecordById returns raw fields:
  // [{type: "SPIT", data: Uint8Array}, ...], little-endian record bytes) -----

  const toBytes = (data) => {
    if (!data) return null;
    if (data instanceof Uint8Array) return data;
    if (Array.isArray(data)) return Uint8Array.from(data);
    if (data.buffer) return new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength);
    return null;
  };
  const readU32 = (b, off) => (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0;
  const readI32 = (b, off) => (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) | 0;
  const readF32 = (b, off) => new DataView(b.buffer, b.byteOffset + off, 4).getFloat32(0, true);

  // SPEL SPIT layout (36 bytes, libespm/SPEL.h SPITData):
  //   0x00 u32 spellCost, 0x04 u32 flags, 0x08 u32 type, 0x0C f32 chargeTime,
  //   0x10 u32 castType (0 ConstantEffect, 1 FireAndForget, 2 Concentration),
  //   0x14 u32 delivery (0 Self, 1 Contact, 2 Aimed, 3 TargetActor, 4 TargetLocation),
  //   0x18 f32 castDuration, 0x1C f32 range, 0x20 u32 perkFormId
  const CAST_TYPE_FIRE_AND_FORGET = 1;
  const CAST_TYPE_CONCENTRATION = 2;
  const DELIVERY_SELF = 0;

  // SPEL EFID: u32 MGEF formId at 0x00, file-LOCAL, must go through
  // lookup.toGlobalRecordId before the MGEF lookup.
  // SPEL EFIT (12 bytes): 0x00 f32 magnitude, 0x04 u32 areaOfEffect, 0x08 u32 duration.

  // MGEF DATA layout (libespm/MGEF.cpp GetData reads exactly these offsets):
  //   0x00 u32 flags, 0x40 u32 effectType, 0x44 i32 primaryAV
  // Flag bits (libespm/MGEF.h Flags): 0x00000001 Hostile, 0x00000004 Detrimental.
  // primaryAV (libespm/ActorValue.h): 24 Health, 25 Magicka, 26 Stamina.
  const MGEF_FLAG_HOSTILE = 0x00000001;
  const MGEF_FLAG_DETRIMENTAL = 0x00000004;
  const AV_NAMES = { 24: "Health", 25: "Magicka", 26: "Stamina" };

  // ----- MGEF filter, mirrors Alduinak 86cc1b04a: reject Hostile or
  // Detrimental, accept only primaryAV Health/Magicka/Stamina -----

  const mgefCache = new Map(); // globalMgefId -> "Health"|"Magicka"|"Stamina"|null

  const classifyMgef = (globalMgefId) => {
    if (mgefCache.has(globalMgefId)) return mgefCache.get(globalMgefId);
    let avName = null;
    try {
      const lookup = mp.lookupEspmRecordById(globalMgefId);
      const rec = lookup && lookup.record;
      if (rec && rec.type === "MGEF" && Array.isArray(rec.fields)) {
        for (const field of rec.fields) {
          if (!field || String(field.type) !== "DATA") continue;
          const b = toBytes(field.data);
          if (!b || b.length < 0x48) break;
          const flags = readU32(b, 0x00);
          if ((flags & MGEF_FLAG_HOSTILE) || (flags & MGEF_FLAG_DETRIMENTAL)) break;
          const primaryAV = readI32(b, 0x44);
          avName = AV_NAMES[primaryAV] || null;
          break;
        }
      }
    } catch (e) {
      avName = null;
    }
    mgefCache.set(globalMgefId, avName);
    return avName;
  };

  // ----- SPEL parser (cached; espm is static for the process lifetime) -----

  const spellCache = new Map(); // spellId -> {castType, delivery, effects:[{av,magnitude}]} | null

  const parseSpell = (spellId) => {
    if (spellCache.has(spellId)) return spellCache.get(spellId);
    let parsed = null;
    try {
      const lookup = mp.lookupEspmRecordById(spellId);
      const rec = lookup && lookup.record;
      if (rec && rec.type === "SPEL" && Array.isArray(rec.fields)) {
        let castType = 0;
        let delivery = 0;
        let haveSpit = false;
        const effects = [];
        let pendingMgef = 0; // global MGEF id of the last EFID, waiting for its EFIT
        for (const field of rec.fields) {
          const type = field ? String(field.type) : "";
          const b = toBytes(field && field.data);
          if (!b) continue;
          if (type === "SPIT" && b.length >= 36) {
            castType = readU32(b, 0x10);
            delivery = readU32(b, 0x14);
            haveSpit = true;
          } else if (type === "EFID" && b.length >= 4) {
            const rawMgefId = readU32(b, 0x00);
            pendingMgef = 0;
            if (rawMgefId && typeof lookup.toGlobalRecordId === "function") {
              pendingMgef = lookup.toGlobalRecordId(rawMgefId) >>> 0;
            }
          } else if (type === "EFIT" && b.length >= 12) {
            if (pendingMgef) {
              const magnitude = readF32(b, 0x00);
              const av = classifyMgef(pendingMgef);
              if (av && Number.isFinite(magnitude) && magnitude > 0) {
                effects.push({ av: av, magnitude: magnitude });
              }
            }
            pendingMgef = 0;
          }
        }
        if (haveSpit && effects.length) {
          parsed = { castType: castType, delivery: delivery, effects: effects };
        }
      }
    } catch (e) {
      parsed = null;
    }
    spellCache.set(spellId, parsed);
    return parsed;
  };

  // ----- validation gates (never trust the client) -----

  const hasSpellEquipped = (casterId, spellId) => {
    // Equipment JSON (Equipment.h Serialize): { inv, leftSpell, rightSpell,
    // voiceSpell, equippedShout, instantSpell, numChanges }; spell slots are
    // plain numeric formIds and absent when nothing is equipped there.
    const eq = safeGet(casterId, "equipment");
    if (!eq || typeof eq !== "object") return false;
    return Number(eq.leftSpell) === spellId || Number(eq.rightSpell) === spellId ||
      Number(eq.voiceSpell) === spellId || Number(eq.instantSpell) === spellId;
  };

  const isAlive = (id) => {
    // isDead throws for unknown forms and non-actors; treat that as invalid.
    try { return mp.get(id, "isDead") !== true; } catch (e) { return false; }
  };

  const validateTarget = (casterId, targetId) => {
    if (targetId === casterId) return isAlive(targetId);
    if (!isAlive(targetId)) return false;
    const casterCell = String(safeGet(casterId, "worldOrCellDesc") || "");
    const targetCell = String(safeGet(targetId, "worldOrCellDesc") || "");
    if (!casterCell || casterCell !== targetCell) return false;
    const a = safeGet(casterId, "pos");
    const b = safeGet(targetId, "pos");
    if (!Array.isArray(a) || !Array.isArray(b) || a.length < 3 || b.length < 3) return false;
    const dx = Number(a[0]) - Number(b[0]);
    const dy = Number(a[1]) - Number(b[1]);
    const dz = Number(a[2]) - Number(b[2]);
    return (dx * dx + dy * dy + dz * dz) <= CFG.maxRange * CFG.maxRange;
  };

  // ----- application: the same Papyrus bridge vgr_npcs uses; self is the
  // TARGET actor as {type:"form"}, args are [avName, magnitude]. The native
  // maps this to MpActor::RestoreActorValue -> ModifyActorValuePercentage,
  // which broadcasts NetSetPercentages -----

  const applyEffects = (targetId, parsed, casterId, why) => {
    let applied = 0;
    for (const eff of parsed.effects) {
      try {
        mp.callPapyrusFunction("method", "Actor", "RestoreActorValue", asForm(targetId), [eff.av, eff.magnitude]);
        applied++;
      } catch (e) {
        dbg("RestoreActorValue failed:", eff.av, e && e.message ? e.message : e);
      }
    }
    if (applied) {
      dbg(why, "->", applied, "effect(s) on", targetId.toString(16), "from caster", casterId.toString(16));
    }
    return applied > 0;
  };

  // ----- dedupe between the two detection paths -----

  const DEDUPE_MS = 1000;
  const lastApply = new Map(); // "casterId:spellId" -> ms timestamp

  const dedupePassed = (casterId, spellId) => {
    const key = casterId + ":" + spellId;
    const now = Date.now();
    const prev = lastApply.get(key);
    if (prev !== undefined && now - prev < DEDUPE_MS) return false;
    lastApply.set(key, now);
    if (lastApply.size > 512) {
      for (const [k, t] of lastApply) { if (now - t > 10000) lastApply.delete(k); }
    }
    return true;
  };

  // ----- concentration channels (Alduinak f4d5ac35d equivalent, but ticks
  // are driven by the injected client poll instead of a server timer) -----

  const CHANNEL_IDLE_MS = 8000; // matches the Alduinak observer timeout
  const channels = new Map(); // casterId -> {spellId, targetId, ticks, lastTickMs, lastSeenMs}

  const stopChannel = (casterId, why) => {
    if (channels.delete(casterId)) dbg("channel stopped for", casterId.toString(16), "-", why);
  };

  const minTickGapMs = Math.max(1, Math.floor(CFG.tickIntervalMs * 0.9));

  const onChannelTick = (casterId) => {
    const ch = channels.get(casterId);
    if (!ch) return;
    const now = Date.now();
    ch.lastSeenMs = now;
    if (now - ch.lastTickMs < minTickGapMs) return; // rate cap: 1 tick / 0.9s at defaults
    if (ch.ticks >= CFG.maxChannelTicks) return stopChannel(casterId, "tick cap");
    if (!isAlive(casterId)) return stopChannel(casterId, "caster dead");
    if (!hasSpellEquipped(casterId, ch.spellId)) return stopChannel(casterId, "spell unequipped");
    if (!validateTarget(casterId, ch.targetId)) return stopChannel(casterId, "target invalid");
    const parsed = parseSpell(ch.spellId);
    if (!parsed) return stopChannel(casterId, "spell unparsed");
    ch.ticks++;
    ch.lastTickMs = now;
    applyEffects(ch.targetId, parsed, casterId, "channel tick " + ch.ticks);
  };

  // Lost stop packets: sweep idle channels so a crashed client cannot leave
  // a channel armed forever (it cannot heal without ticks either way).
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [casterId, ch] of channels) {
      if (now - ch.lastSeenMs > CHANNEL_IDLE_MS) channels.delete(casterId);
    }
  }, 15000);
  if (sweep && typeof sweep.unref === "function") sweep.unref();

  // ----- shared validator for both detection paths -----

  const onSpellCastDetected = (casterId, spellId, reportedTargetId, source) => {
    casterId = Number(casterId) >>> 0;
    spellId = Number(spellId) >>> 0;
    if (!casterId || !spellId) return;

    const parsed = parseSpell(spellId);
    if (!parsed) return; // not a SPEL, or no non-hostile Health/Magicka/Stamina effects

    // Gate: the caster must actually have the spell in hand (server data).
    if (!hasSpellEquipped(casterId, spellId)) return;

    // Self-delivery ignores whatever target the client claims; anything else
    // needs a real, alive, same-cell target within range.
    const targetId = parsed.delivery === DELIVERY_SELF ? casterId : (Number(reportedTargetId) >>> 0);
    if (!targetId) return; // aimed cast with no target (detection A never has one)
    if (!validateTarget(casterId, targetId)) return;

    if (parsed.castType === CAST_TYPE_CONCENTRATION) {
      const existing = channels.get(casterId);
      if (existing && existing.spellId === spellId && existing.targetId === targetId) {
        existing.lastSeenMs = Date.now(); // duplicate/keep-alive cast: refresh, never re-apply
        return;
      }
      if (!dedupePassed(casterId, spellId)) return;
      const now = Date.now();
      channels.set(casterId, { spellId: spellId, targetId: targetId, ticks: 1, lastTickMs: now, lastSeenMs: now });
      applyEffects(targetId, parsed, casterId, "channel start (" + source + ")");
      return;
    }

    if (parsed.castType === CAST_TYPE_FIRE_AND_FORGET) {
      if (!dedupePassed(casterId, spellId)) return;
      applyEffects(targetId, parsed, casterId, "instant (" + source + ")");
    }
    // ConstantEffect/abilities: nothing to apply on cast.
  };

  // ----- detection A: native papyrus event (self instant heals) -----
  // Fired by ActionListener::OnSpellCast for every accepted cast as
  // (casterFormId:number, spell:{type:"espm", desc}). Chain rather than
  // clobber, mirroring how vgr_npcs guards the single onDeath slot.

  const PAPYRUS_KEY = "onPapyrusEvent:OnSpellCast";
  const papyrusHandler = (casterFormId, spellInfo) => {
    try {
      if (!spellInfo || spellInfo.type !== "espm" || !spellInfo.desc) return;
      onSpellCastDetected(Number(casterFormId), mp.getIdFromDesc(String(spellInfo.desc)), 0, "papyrus");
    } catch (e) {
      dbg("papyrus OnSpellCast handler failed:", e && e.message ? e.message : e);
    }
  };
  const prevPapyrus = mp[PAPYRUS_KEY];
  if (typeof prevPapyrus === "function") {
    mp[PAPYRUS_KEY] = (...args) => {
      try { prevPapyrus(...args); } catch (e) { console.error(LOG, "chained OnSpellCast handler failed:", e); }
      papyrusHandler(...args);
    };
  } else {
    mp[PAPYRUS_KEY] = papyrusHandler;
  }

  // ----- detection B: injected client code (aimed heals + channel lifecycle) -----
  // ctx.sp.on("spellCast") gives SpellCastEvent {caster, target, spell,
  // isDualCasting, castingSource, aimAngle, aimHeading} in the frozen SP.
  // Only local-player casts are reported; ids go through
  // ctx.getFormIdInServerFormat. The update poll mirrors the Alduinak
  // client's detectCastStop: IsCastingRight/IsCastingLeft/IsCastingDual.

  if (typeof mp.makeEventSource === "function") {
    mp.makeEventSource("_vgrHealCast", `
      (function () {
        if (!ctx.state.vgrHealCast) {
          ctx.state.vgrHealCast = { casting: false, lastTickMs: 0 };
        }
        ctx.sp.on("spellCast", (e) => {
          try {
            if (!e || !e.caster || e.caster.getFormID() !== 0x14) return;
            const spellId = e.spell ? e.spell.getFormID() : 0;
            if (!spellId) return;
            ctx.sendEvent({
              kind: "cast",
              spell: ctx.getFormIdInServerFormat(spellId),
              target: e.target ? ctx.getFormIdInServerFormat(e.target.getFormID()) : 0,
              source: e.castingSource
            });
          } catch (err) {}
        });
        ctx.sp.on("update", () => {
          try {
            const st = ctx.state.vgrHealCast;
            const player = ctx.sp.Game.getPlayer();
            if (!player) return;
            const casting = player.getAnimationVariableBool("IsCastingRight")
              || player.getAnimationVariableBool("IsCastingLeft")
              || player.getAnimationVariableBool("IsCastingDual");
            const now = Date.now();
            if (casting) {
              if (!st.casting) {
                st.casting = true;
                st.lastTickMs = now;
              } else if (now - st.lastTickMs >= ${CFG.tickIntervalMs}) {
                st.lastTickMs = now;
                ctx.sendEvent({ kind: "tick" });
              }
            } else if (st.casting) {
              st.casting = false;
              ctx.sendEvent({ kind: "stop" });
            }
          } catch (err) {}
        });
      })();
    `);
  } else {
    console.warn(LOG, "mp.makeEventSource unavailable; aimed/concentration detection disabled");
  }

  mp._vgrHealCast = (pcFormId, payload) => {
    try {
      const kind = payload && payload.kind;
      if (kind === "cast") {
        onSpellCastDetected(Number(pcFormId), Number(payload.spell) || 0, Number(payload.target) || 0, "client");
      } else if (kind === "tick") {
        onChannelTick(Number(pcFormId) >>> 0);
      } else if (kind === "stop") {
        stopChannel(Number(pcFormId) >>> 0, "cast released");
      }
    } catch (e) {
      dbg("_vgrHealCast failed:", e && e.message ? e.message : e);
    }
  };

  console.log(LOG, "active: maxRange=" + CFG.maxRange + " tickIntervalMs=" + CFG.tickIntervalMs +
    " maxChannelTicks=" + CFG.maxChannelTicks + (CFG.debug ? " debug=on" : ""));
};
