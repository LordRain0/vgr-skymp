// ==========================================
// VGR RESPAWN (players)
// ==========================================
// Port of the Alduinak respawn system onto the VGR extension layout.
// On death the engine ragdolls the player and respawns them after spawnDelay
// at spawnPoint, restoring respawnPercentages of each stat. This extension
// points the spawn point at the nearest temple interior at ~1 HP (injured),
// shows the death screen (countdown + choices) through the UI manager, and
// validates every choice server-side.
// Choices: permadeath (engine respawn blocked, body remains), resurrect
// (full health in place, re-death to the same killer within 1h forces
// permadeath), temple (nearest temple at full health).
// Registers through mp.vgrOnDeath (vgr_npcs.js owns the mp.onDeath slot) and
// owns the free mp.onRespawn slot; returning false there blocks the engine
// revive for permadead corpses.

module.exports = (mp) => {
  const LOG = "[VGR respawn]";
  const fs = require("fs");
  const path = require("path");

  let settings = {};
  try {
    settings = mp.getServerSettings ? mp.getServerSettings() : {};
  } catch (e) {
    settings = {};
  }

  // Tuning
  const BLEEDOUT_SECONDS = Math.max(5, Number(settings.respawnSeconds) || 15);
  const WAKE_HEALTH = 0.01;
  const FULL_HEALTH = 1.0;
  const REGEN_INTERVAL_MS = 8 * 60 * 60 * 1000;
  const REGEN_NATURAL = 0.01;
  const REGEN_HEALER = 0.05;
  const ARMED_KILLER_TTL_MS = 60 * 60 * 1000;
  const NEVER_RESPAWN = 1e12;
  const TICK_MS = 30 * 1000;
  const HEALTH_EPSILON = 0.005;

  // Temple interiors (measured in-game, VGR_Locations survey)
  const SOLITUDE  = { cellOrWorldDesc: "16a02:Skyrim.esm", pos: [1676.93, 1571.19, 0],      rot: [0, 0, 15.75] };
  const MARKARTH  = { cellOrWorldDesc: "16df3:Skyrim.esm", pos: [-1870.36, 356.02, 156.24], rot: [0, 0, 279.5] };
  const FALKREATH = { cellOrWorldDesc: "13a71:Skyrim.esm", pos: [-1728, -391, 0],           rot: [0, 0, 180] };
  const WHITERUN  = { cellOrWorldDesc: "165a7:Skyrim.esm", pos: [223.24, 248.85, 54],       rot: [0, 0, 0] };
  const WINDHELM  = { cellOrWorldDesc: "16785:Skyrim.esm", pos: [0, -2800, 64.35],          rot: [0, 0, 0] };
  const RIFTEN    = { cellOrWorldDesc: "16bd7:Skyrim.esm", pos: [-1414.34, 208.64, 64],     rot: [0, 0, 15.75] };

  // Tamriel anchors used to pick the nearest temple. Hold capitals route to
  // their own temple, temple-less holds and settlements to a neighbour.
  const ANCHORS = [
    { name: "Solitude",        x: -68173.96,  y: 103311.75, dest: SOLITUDE },
    { name: "Markarth",        x: -169535.31, y: 5386.96,   dest: MARKARTH },
    { name: "Falkreath",       x: -34020.39,  y: -89435.80, dest: FALKREATH },
    { name: "Whiterun",        x: 16476.68,   y: -9595.68,  dest: WHITERUN },
    { name: "Windhelm",        x: 135019.44,  y: 33731.66,  dest: WINDHELM },
    { name: "Riften",          x: 174274.64,  y: -91459.67, dest: RIFTEN },
    { name: "Winterhold",      x: 114050.01,  y: 94006.28,  dest: WINDHELM },
    { name: "Dawnstar",        x: 26328.23,   y: 101092.58, dest: WINDHELM },
    { name: "Morthal",         x: -39547.51,  y: 70770.92,  dest: SOLITUDE },
    { name: "Riverwood",       x: 19233.25,   y: -46721.73, dest: WHITERUN },
    { name: "Rorikstead",      x: -78931.07,  y: 2789.23,   dest: WHITERUN },
    { name: "Ivarstead",       x: 78291.95,   y: -67062.64, dest: RIFTEN },
    { name: "Dragon's Bridge", x: -100811.45, y: 80907.16,  dest: SOLITUDE },
    { name: "High Hrothgar",   x: 56897.66,   y: -31974.11, dest: WHITERUN },
  ];

  // Deaths outside Tamriel route by where the region connects back to Skyrim.
  const WORLDSPACE_OVERRIDES = [
    { match: (d) => d.endsWith(":Dragonborn.esm"), name: "Windhelm", dest: WINDHELM },
    { match: (d) => d === "bb5:Dawnguard.esm", name: "Markarth", dest: MARKARTH },
    { match: (d) => d === "1408:Dawnguard.esm", name: "Solitude", dest: SOLITUDE },
  ];

  function nearestTemple(pos) {
    const px = Array.isArray(pos) ? pos[0] : 0;
    const py = Array.isArray(pos) ? pos[1] : 0;
    let best = ANCHORS[0];
    let bestSq = Infinity;
    for (const t of ANCHORS) {
      const dx = t.x - px;
      const dy = t.y - py;
      const sq = dx * dx + dy * dy;
      if (sq < bestSq) { bestSq = sq; best = t; }
    }
    return best;
  }

  function pickTemple(worldDesc, pos) {
    if (typeof worldDesc === "string") {
      for (const o of WORLDSPACE_OVERRIDES) {
        if (o.match(worldDesc)) return o;
      }
      // A death inside a temple interior wakes the player in that temple;
      // interior coords are cell-local and would mis-route by distance.
      for (const t of ANCHORS) {
        if (t.dest.cellOrWorldDesc === worldDesc) return t;
      }
    }
    return nearestTemple(pos);
  }

  const safeGet = (id, prop, dflt) => {
    try {
      const v = mp.get(id, prop);
      return v === undefined || v === null ? dflt : v;
    } catch (e) { return dflt; }
  };
  const safeSet = (id, prop, value) => {
    try { mp.set(id, prop, value); }
    catch (e) { console.error(LOG, "set", prop, "failed:", e && e.message ? e.message : e); }
  };

  // NPCs share the death events; only actors with a master-api profile count.
  const isPlayer = (actorId) => Number(safeGet(actorId, "profileId", -1)) > 0;

  // Death/respawn audit lines go to pvp.log (rotated by the server manager).
  const logDir = process.env.VGR_LOG_DIR || settings.logDir || "C:\\logs";
  const audit = (line) => {
    try { fs.appendFile(path.join(logDir, "pvp.log"), new Date().toISOString() + " " + line + "\n", () => {}); }
    catch (e) { }
  };

  // Death screen payload channel; nonce-deduped because updateOwner runs every frame.
  mp.makeProperty("vgrDeathScreen", {
    isVisibleByOwner: true,
    isVisibleByNeighbors: false,
    updateOwner: `
      const value = ctx.value;
      if (!value || !value.nonce) return;
      if (ctx.state.vgrDeathScreenNonce === value.nonce) return;
      ctx.state.vgrDeathScreenNonce = value.nonce;
      ctx.sp.browser.executeJavaScript("window.vgrDeathScreenUpdate && window.vgrDeathScreenUpdate(" + JSON.stringify({ show: value.show === true, seconds: Number(value.seconds) || 0 }) + ")");
    `,
    updateNeighbor: "",
  });

  const showDeathScreen = (actorId, seconds) => {
    safeSet(actorId, "vgrDeathScreen", { nonce: Date.now() + ":" + Math.random(), show: true, seconds });
    mp.vgrOpenUI(actorId, "death_screen");
  };
  const hideDeathScreen = (actorId) => {
    safeSet(actorId, "vgrDeathScreen", { nonce: Date.now() + ":" + Math.random(), show: false, seconds: 0 });
    mp.vgrCloseUI(actorId, "death_screen");
  };

  // Full restore, deliberately refills magicka/stamina too; only for the
  // explicit full-health outcomes.
  const setHealth = (actorId, health) => {
    safeSet(actorId, "percentages", { health, magicka: 1, stamina: 1 });
  };
  // Write health while keeping the player's current magicka/stamina.
  const setHealthPreserving = (actorId, health) => {
    const cur = safeGet(actorId, "percentages", null);
    const magicka = cur && typeof cur.magicka === "number" ? cur.magicka : 1;
    const stamina = cur && typeof cur.stamina === "number" ? cur.stamina : 1;
    safeSet(actorId, "percentages", { health, magicka, stamina });
  };
  const clearArmedKiller = (actorId) => {
    safeSet(actorId, "private.resurrectArmedKiller", 0);
    safeSet(actorId, "private.resurrectArmedUntilMs", 0);
  };

  function onPlayerDeath(dyingActorId, killerId) {
    if (!isPlayer(dyingActorId)) return;

    // A permadead corpse must never re-enter the normal death flow.
    if (safeGet(dyingActorId, "private.permaDead", false) === true) {
      safeSet(dyingActorId, "spawnDelay", NEVER_RESPAWN);
      return;
    }

    // Anti-glitch: a resurrect followed by another death to the same killer
    // within the arming window forces permadeath instead of a new choice.
    const armed = safeGet(dyingActorId, "private.resurrectArmedKiller", 0);
    const armedUntil = safeGet(dyingActorId, "private.resurrectArmedUntilMs", 0);
    if (killerId && armed === killerId && Date.now() < armedUntil) {
      audit("PERMADEATH forced: " + dyingActorId.toString(16) + " died again to armed killer " + killerId.toString(16));
      doPermaDeath(dyingActorId, "died again to the same player after a resurrect");
      return;
    }
    if (armed) clearArmedKiller(dyingActorId);

    const pos = safeGet(dyingActorId, "pos", null);
    const world = safeGet(dyingActorId, "worldOrCellDesc", null);
    const temple = pickTemple(world, pos);

    // Default outcome: wake at the nearest temple interior at 1 HP, injured.
    // These take effect because this handler runs before the engine arms its
    // respawn timer for this death.
    safeSet(dyingActorId, "spawnPoint", temple.dest);
    safeSet(dyingActorId, "spawnDelay", BLEEDOUT_SECONDS);
    safeSet(dyingActorId, "respawnPercentages", { health: WAKE_HEALTH, magicka: 1, stamina: 1 });

    safeSet(dyingActorId, "private.deathKiller", killerId || 0);
    safeSet(dyingActorId, "private.deathPos", Array.isArray(pos) ? pos : [0, 0, 0]);
    safeSet(dyingActorId, "private.deathWorld", typeof world === "string" ? world : "");
    safeSet(dyingActorId, "private.injured", true);
    safeSet(dyingActorId, "private.injuredHealth", WAKE_HEALTH);
    safeSet(dyingActorId, "private.regenLastMs", Date.now());
    safeSet(dyingActorId, "private.regenRate", REGEN_NATURAL);

    // One-shot window: choices are only honoured while this is set.
    safeSet(dyingActorId, "private.deathChoicePending", true);

    showDeathScreen(dyingActorId, BLEEDOUT_SECONDS);
    audit("DEATH " + dyingActorId.toString(16) + (killerId ? " killed by " + killerId.toString(16) : "") + " -> " + temple.name);
    console.log(LOG, dyingActorId.toString(16), "down; will wake at", temple.name);
  }

  // Returning false blocks the engine respawn; the corpse stays where it fell.
  function onPlayerRespawn(actorId) {
    if (!isPlayer(actorId)) return;
    if (safeGet(actorId, "private.permaDead", false) === true) {
      safeSet(actorId, "spawnDelay", NEVER_RESPAWN);
      return false;
    }
    safeSet(actorId, "private.deathChoicePending", false);
    hideDeathScreen(actorId);
  }

  // Choices come from the browser; only honour them while the sender is
  // actually dead and still holds the unconsumed window for this death.
  function onDeathChoice(actorId, choiceRaw) {
    const choice = String(choiceRaw || "");
    if (!isPlayer(actorId)) return;
    if (choice !== "permadeath" && choice !== "resurrect" && choice !== "temple") return;
    if (safeGet(actorId, "isDead", false) !== true) return;
    if (safeGet(actorId, "private.deathChoicePending", false) !== true) return;
    safeSet(actorId, "private.deathChoicePending", false);

    if (choice === "permadeath") doPermaDeath(actorId, "chose permanent death");
    else if (choice === "resurrect") doResurrectHere(actorId);
    else doTempleFullHealth(actorId);
  }

  // Permadeath holds through onPlayerRespawn returning false plus an inert
  // spawnDelay so the restart re-arm path never schedules a revive either.
  function doPermaDeath(actorId, reason) {
    safeSet(actorId, "private.permaDead", true);
    safeSet(actorId, "private.injured", false);
    safeSet(actorId, "private.deathChoicePending", false);
    clearArmedKiller(actorId);
    safeSet(actorId, "spawnDelay", NEVER_RESPAWN);
    safeSet(actorId, "isDead", true);
    hideDeathScreen(actorId);
    audit("PERMADEATH " + actorId.toString(16) + ": " + reason);
    console.log(LOG, "PERMADEATH", actorId.toString(16), reason);
  }

  function doResurrectHere(actorId) {
    const killer = safeGet(actorId, "private.deathKiller", 0);
    const count = safeGet(actorId, "private.resurrectCount", 0) + 1;
    safeSet(actorId, "isDead", false);
    setHealth(actorId, FULL_HEALTH);
    safeSet(actorId, "private.injured", false);
    safeSet(actorId, "respawnPercentages", { health: FULL_HEALTH, magicka: 1, stamina: 1 });
    safeSet(actorId, "private.resurrectCount", count);
    safeSet(actorId, "private.resurrectArmedKiller", killer);
    safeSet(actorId, "private.resurrectArmedUntilMs", Date.now() + ARMED_KILLER_TTL_MS);
    hideDeathScreen(actorId);
    audit("RESURRECT-HERE " + actorId.toString(16) + " use #" + count + " armed vs " + (killer ? killer.toString(16) : "none"));
  }

  function doTempleFullHealth(actorId) {
    const deathPos = safeGet(actorId, "private.deathPos", null);
    const deathWorld = safeGet(actorId, "private.deathWorld", null);
    const temple = pickTemple(deathWorld, deathPos);
    safeSet(actorId, "isDead", false);
    safeSet(actorId, "locationalData", temple.dest);
    setHealth(actorId, FULL_HEALTH);
    safeSet(actorId, "private.injured", false);
    safeSet(actorId, "respawnPercentages", { health: FULL_HEALTH, magicka: 1, stamina: 1 });
    hideDeathScreen(actorId);
    audit("TEMPLE-RESPAWN " + actorId.toString(16) + " -> " + temple.name);
  }

  // Periodic tick: pin injured players' health to the slow recovery curve.
  // The engine's respawn message tells the client "full health" and natural
  // regen cropping would accept the client's full bar within minutes.
  function tick() {
    const now = Date.now();
    const players = safeGet(0, "onlinePlayers", []) || [];
    for (const actorId of players) {
      if (!actorId || !isPlayer(actorId)) continue;
      if (safeGet(actorId, "private.injured", false) !== true) continue;

      const last = safeGet(actorId, "private.regenLastMs", now);
      const rate = safeGet(actorId, "private.regenRate", REGEN_NATURAL);
      let ceiling = safeGet(actorId, "private.injuredHealth", WAKE_HEALTH);
      const intervals = Math.floor((now - last) / REGEN_INTERVAL_MS);
      if (intervals > 0) {
        ceiling = Math.min(FULL_HEALTH, ceiling + intervals * rate);
        safeSet(actorId, "private.injuredHealth", ceiling);
        safeSet(actorId, "private.regenLastMs", last + intervals * REGEN_INTERVAL_MS);
      }
      if (ceiling >= FULL_HEALTH) {
        safeSet(actorId, "private.injured", false);
        safeSet(actorId, "respawnPercentages", { health: FULL_HEALTH, magicka: 1, stamina: 1 });
      } else {
        const cur = safeGet(actorId, "percentages", null);
        const curHealth = cur && typeof cur.health === "number" ? cur.health : ceiling;
        if (Math.abs(curHealth - ceiling) > HEALTH_EPSILON) {
          setHealthPreserving(actorId, ceiling);
        }
      }
    }
  }

  // Call when a healer tends an injured player to bump recovery to 5 HP / 8h.
  mp.vgrRespawnHealerBoost = (actorId) => {
    if (safeGet(actorId, "private.injured", false) === true) {
      safeSet(actorId, "private.regenRate", REGEN_HEALER);
    }
  };

  // Browser -> server choice relay.
  mp.makeEventSource("_vgrRespawn", `
    ctx.sp.on("browserMessage", (e) => {
      const msg = e.arguments && e.arguments[0];
      if (msg !== "vgr:respawn:choice") return;
      const choice = e.arguments && e.arguments[1];
      ctx.sendEvent({ choice: String(choice || "") });
    });
  `);

  mp._vgrRespawn = (pcFormId, payload) => {
    try { onDeathChoice(pcFormId, payload && payload.choice); }
    catch (e) { console.error(LOG, "deathChoice failed:", e && e.message ? e.message : e); }
  };

  mp.vgrOnDeath((actorId, killerId) => {
    try { onPlayerDeath(actorId, killerId || 0); }
    catch (e) { console.error(LOG, "onDeath failed:", e && e.message ? e.message : e); }
  });

  mp.onRespawn = (actorId) => {
    try { return onPlayerRespawn(actorId); }
    catch (e) { console.error(LOG, "onRespawn failed:", e && e.message ? e.message : e); }
  };

  const loop = () => {
    setTimeout(() => {
      try { tick(); } catch (e) { console.error(LOG, "tick failed:", e && e.message ? e.message : e); }
      loop();
    }, TICK_MS);
  };
  loop();

  console.log(LOG, "started; bleedout", BLEEDOUT_SECONDS, "s,", ANCHORS.length, "anchors");
};
