// ==========================================
// VGR NPCS (foundation)
// ==========================================
// Server-side NPC lifecycle on top of the engine's client-hosted NPC model:
//   - spawn any espm NPC_ base via mp.place, teleported to a target location,
//     with overrides: display name, scale, extra inventory, spells, timers
//   - respawn policies per NPC: "timed" (engine spawnDelay), "never"
//     (block auto-respawn + clean the corpse), "trigger" (stay dead until a
//     player comes within triggerDistance of the spawn point)
//   - despawn timer (lifetime), registry of all spawned NPCs, delete API
// Owns the single mp.onDeath slot and exposes mp.vgrOnDeath(fn) chaining so
// other extensions (e.g. combat XP) can subscribe without clobbering it.
// Engine facts this builds on (see repo mapping):
//   - DeathEvent auto-respawns after changeform spawnDelay (default 25s);
//     an onDeath handler returning false blocks that
//   - dead actors auto-respawn on server restart (ApplyChangeForm) - the
//     boot pass below re-applies policies
//   - permanent removal = Papyrus ObjectReference.Delete (persists isDeleted)
//     + mp.destroyActor (in-memory)
//   - movement/AI is client-hosted; the server cannot animate NPCs

module.exports = (mp) => {

	const LOG = "[VGR npcs]";
	const TAG_PROP = "private.indexed.vgrNpc";
	const CFG_PROP = "private.vgrNpcConfig";
	const NEVER_DELAY_SEC = 3600 * 24 * 3650; // belt+braces vs engine respawn

	// Two distinct Papyrus arg shapes: "form" resolves a WORLD REFERENCE
	// (MpForm - actors, placed objects); "espm" resolves a BASE RECORD from the
	// load order (NPC_ bases, items, spells, factions). Passing type:"form" for
	// a base record makes the server try to load it as a reference and throw
	// "Form with id X doesn't exist".
	const asForm = (formId) => ({ type: "form", desc: mp.getDescFromId(formId) });
	const asEspm = (formId) => ({ type: "espm", desc: mp.getDescFromId(formId) });
	const safeGet = (id, prop) => { try { return mp.get(id, prop); } catch (e) { return null; } };

	// ----- death dispatcher (single mp.onDeath slot, chainable) -----

	const deathChain = [];
	mp.vgrOnDeath = (fn) => { if (typeof fn === "function") deathChain.push(fn); };

	const pendingTrigger = new Map(); // actorId -> earliest respawn ms

	mp.onDeath = (actorId, killerId) => {
		try {
			if (safeGet(actorId, TAG_PROP)) {
				const cfg = safeGet(actorId, CFG_PROP) || {};
				if (cfg.respawnMode === "never") {
					const lingerMs = (Number(cfg.corpseLingerSec) || 30) * 1000;
					setTimeout(() => { try { mp.vgrNpcDelete(actorId); } catch (e) { } }, lingerMs);
					console.log(LOG, "npc", actorId, "died permanently (cleanup in", lingerMs / 1000, "s)");
					return false; // block engine auto-respawn
				}
				if (cfg.respawnMode === "trigger") {
					pendingTrigger.set(actorId, Date.now() + (Number(cfg.respawnDelaySec) || 25) * 1000);
					console.log(LOG, "npc", actorId, "died; respawn armed on player approach");
					return false;
				}
				// "timed": engine spawnDelay (set at spawn) handles the respawn
			}
		} catch (e) {
			console.error(LOG, "onDeath policy failed:", e);
		}
		for (const fn of deathChain) {
			try { if (fn(actorId, killerId) === false) return false; } catch (e) { console.error(LOG, "chained death handler failed:", e); }
		}
	};

	// ----- spawn -----
	// config: { baseId (number|hex string, espm NPC_ record), cellOrWorldDesc,
	//   pos:[x,y,z], rot?:[x,y,z], name?, scale?, respawnMode?:"timed"|"never"|"trigger",
	//   respawnDelaySec?, triggerDistance?, despawnSec?, corpseLingerSec?,
	//   inventory?: [{baseId,count}], spells?: [formId], spawnedBy? }
	// returns the new actor formId, or 0 on failure.
	mp.vgrNpcSpawn = (config) => {
		try {
			const baseId = typeof config.baseId === "string" ? parseInt(config.baseId, 16) : Number(config.baseId);
			if (!baseId) { console.error(LOG, "spawn: missing baseId"); return 0; }

			const rec = mp.lookupEspmRecordById(baseId);
			const recType = rec && rec.record ? rec.record.type : null;
			if (recType !== "NPC_") {
				console.error(LOG, "spawn refused: 0x" + baseId.toString(16), "is", recType || "not found", "- expected NPC_");
				return 0;
			}
			if (!config.cellOrWorldDesc || !Array.isArray(config.pos)) {
				console.error(LOG, "spawn: cellOrWorldDesc + pos are required");
				return 0;
			}

			const locational = {
				cellOrWorldDesc: String(config.cellOrWorldDesc),
				pos: config.pos.map(Number),
				rot: Array.isArray(config.rot) ? config.rot.map(Number) : [0, 0, 0]
			};

			// Spawn IN the requesting player's grid so the client subscribes and
			// renders it. mp.place() creates at 0,0,0 Tamriel; teleporting it in
			// afterwards does NOT re-trigger the player's subscription (that's
			// driven by the player's own grid movement), so the NPC would exist
			// server-side but never stream to the client. Papyrus PlaceAtMe on
			// the requesting actor places natively at that actor's cell (already
			// in the player's grid) and sets the spawn point - the path console
			// placeatme uses, which is known to render. Fall back to place+set
			// only when no anchor actor is available.
			let id = 0;
			const anchor = config.spawnedBy ? Number(config.spawnedBy) : 0;
			if (anchor) {
				try {
					const ret = mp.callPapyrusFunction("method", "ObjectReference", "PlaceAtMe",
						asForm(anchor), [asEspm(baseId), 1, false, false]);
					if (ret && ret.desc) id = mp.getIdFromDesc(ret.desc);
				} catch (e) { console.error(LOG, "PlaceAtMe failed:", e); }
			}
			if (!id) {
				id = mp.place(baseId); // fallback (may not stream to clients until they move)
			}

			// Nudge to the requested offset. The NPC is already in the player's
			// grid (placed at the anchor), so this short teleport keeps it
			// subscribed while spacing multiple spawns apart.
			mp.set(id, "locationalData", locational);
			mp.set(id, "spawnPoint", locational); // respawns happen here

			const respawnMode = ["timed", "never", "trigger"].indexOf(config.respawnMode) !== -1 ? config.respawnMode : "timed";
			const respawnDelaySec = Number(config.respawnDelaySec) > 0 ? Number(config.respawnDelaySec) : 25;
			mp.set(id, "spawnDelay", respawnMode === "timed" ? respawnDelaySec : NEVER_DELAY_SEC);

			if (config.name) {
				try {
					mp.callPapyrusFunction("method", "ObjectReference", "SetDisplayName", asForm(id), [String(config.name), true]);
				} catch (e) { console.error(LOG, "SetDisplayName failed:", e); }
			}

			if (Number(config.scale) > 0 && Number(config.scale) !== 1) {
				try {
					mp.callPapyrusFunction("global", "NetImmerse", "SetNodeScale", null,
						[asForm(id), "NPC Root [Root]", Number(config.scale), false]);
				} catch (e) { console.error(LOG, "SetNodeScale failed:", e); }
			}

			// Only pass formIds that actually resolve to a base record of the
			// expected type - catalog entries can include override records whose
			// runtime formId has no standalone base (Papyrus then throws "Form
			// doesn't exist"). Silently skip those instead of erroring per item.
			const resolves = (formId, types) => {
				try {
					const rec = mp.lookupEspmRecordById(formId);
					return !!(rec && rec.record && types.indexOf(rec.record.type) !== -1);
				} catch (e) { return false; }
			};

			// Inventory via the server-authoritative property (merge onto the
			// base container), not Papyrus AddItem - AddItem triggers a
			// reference load that throws on some valid base records. Adding a
			// weapon here makes EquipBestWeapon equip it on the next host grant.
			if (Array.isArray(config.inventory) && config.inventory.length) {
				try {
					const inv = mp.get(id, "inventory") || { entries: [] };
					const entries = Array.isArray(inv.entries) ? inv.entries : [];
					for (const entry of config.inventory) {
						const itemId = typeof entry.baseId === "string" ? parseInt(entry.baseId, 16) : Number(entry.baseId);
						if (!itemId) continue;
						if (!resolves(itemId, ["WEAP", "ARMO", "AMMO", "ALCH", "INGR", "BOOK", "MISC", "SCRL", "SLGM", "KEYM", "LIGH"])) {
							console.warn(LOG, "skipping unresolvable inventory item 0x" + itemId.toString(16));
							continue;
						}
						const count = Number(entry.count) || 1;
						const existing = entries.find((e) => e.baseId === itemId && Object.keys(e).every((k) => k === "baseId" || k === "count"));
						if (existing) existing.count += count;
						else entries.push({ baseId: itemId, count: count });
					}
					mp.set(id, "inventory", { entries: entries });
				} catch (e) { console.error(LOG, "inventory set failed:", e); }
			}

			if (Array.isArray(config.spells)) {
				for (const spell of config.spells) {
					const spellId = typeof spell === "string" ? parseInt(spell, 16) : Number(spell);
					if (!spellId) continue;
					if (!resolves(spellId, ["SPEL", "SHOU"])) {
						console.warn(LOG, "skipping unresolvable spell 0x" + spellId.toString(16));
						continue;
					}
					try {
						mp.callPapyrusFunction("method", "Actor", "AddSpell", asForm(id), [asEspm(spellId), false]);
					} catch (e) { console.error(LOG, "AddSpell failed for 0x" + spellId.toString(16) + ":", e); }
				}
			}

			// Factions persist server-side (AddToFaction). NOTE: hostility to
			// players is driven by the base NPC_ record on the client, not by
			// server factions - this is bookkeeping/future-proofing, not a
			// reliable aggression switch.
			if (Array.isArray(config.factions)) {
				for (const fac of config.factions) {
					const facId = typeof fac === "string" ? parseInt(fac, 16) : Number(fac);
					if (!facId) continue;
					if (!resolves(facId, ["FACT"])) {
						console.warn(LOG, "skipping unresolvable faction 0x" + facId.toString(16));
						continue;
					}
					try {
						mp.callPapyrusFunction("method", "Actor", "AddToFaction", asForm(id), [asEspm(facId)]);
					} catch (e) { console.error(LOG, "AddToFaction failed for 0x" + facId.toString(16) + ":", e); }
				}
			}

			mp.set(id, TAG_PROP, "1");
			mp.set(id, CFG_PROP, {
				v: 1,
				baseId: baseId,
				baseName: config.baseName || null,
				name: config.name || null,
				scale: Number(config.scale) || 1,
				respawnMode: respawnMode,
				respawnDelaySec: respawnDelaySec,
				triggerDistance: Number(config.triggerDistance) || 0,
				despawnSec: Number(config.despawnSec) || 0,
				corpseLingerSec: Number(config.corpseLingerSec) || 30,
				spawnPoint: locational,
				spawnedBy: config.spawnedBy || null,
				spawnedAt: Date.now()
			});

			console.log(LOG, "spawned 0x" + baseId.toString(16), "as", id.toString(16),
				config.name ? "(" + config.name + ")" : "", "mode:", respawnMode);
			return id;
		} catch (e) {
			console.error(LOG, "spawn failed:", e);
			return 0;
		}
	};

	// ----- delete (permanent: survives restarts) -----
	mp.vgrNpcDelete = (actorId) => {
		pendingTrigger.delete(actorId);
		let ok = true;
		// Clear the indexed tag FIRST so findFormsByPropertyValue stops
		// returning this id. destroyActor removes the in-memory form but does
		// NOT clear the private.indexed reverse index, so without this the
		// registry keeps returning the dead formId and the tick calls mp.get on
		// a destroyed form every cycle (noisy "Form doesn't exist" spam).
		try { mp.set(actorId, TAG_PROP, "0"); } catch (e) { /* form may be gone */ }
		try {
			mp.callPapyrusFunction("method", "ObjectReference", "Delete", asForm(actorId), []);
		} catch (e) { console.error(LOG, "papyrus Delete failed for", actorId, ":", e); ok = false; }
		try {
			mp.destroyActor(actorId);
		} catch (e) { /* may already be gone */ }
		console.log(LOG, "deleted npc", actorId.toString(16));
		return ok;
	};

	// ----- registry / list -----
	mp.vgrNpcList = () => {
		let ids = [];
		try { ids = mp.findFormsByPropertyValue(TAG_PROP, "1") || []; } catch (e) { return []; }
		const out = [];
		for (const id of ids) {
			const cfg = safeGet(id, CFG_PROP);
			const pos = safeGet(id, "pos");
			if (!cfg || !pos) continue; // dangling entry (destroyed form)
			out.push({
				id: id,
				idHex: "0x" + id.toString(16).toUpperCase(),
				baseId: cfg.baseId,
				baseName: cfg.baseName || null,
				name: cfg.name,
				respawnMode: cfg.respawnMode,
				isDead: !!safeGet(id, "isDead"),
				pos: pos,
				cell: safeGet(id, "worldOrCellDesc"),
				spawnedAt: cfg.spawnedAt,
				config: cfg
			});
		}
		return out;
	};

	// ----- ticks: trigger respawns + despawn timers -----
	const distanceOk = (spawnPoint, maxDist) => {
		let players = [];
		try { players = mp.get(0, "onlinePlayers") || []; } catch (e) { return false; }
		const maxSq = maxDist * maxDist;
		for (const p of players) {
			try {
				if (mp.get(p, "worldOrCellDesc") !== spawnPoint.cellOrWorldDesc) continue;
				const pos = mp.get(p, "pos");
				const dx = pos[0] - spawnPoint.pos[0];
				const dy = pos[1] - spawnPoint.pos[1];
				if (dx * dx + dy * dy <= maxSq) return true;
			} catch (e) { /* player mid-despawn */ }
		}
		return false;
	};

	const vgrTick = () => {
		const now = Date.now();

		// trigger-mode respawns: revive when a player is near the spawn point
		for (const [actorId, readyAt] of pendingTrigger) {
			if (now < readyAt) continue;
			const cfg = safeGet(actorId, CFG_PROP);
			if (!cfg) { pendingTrigger.delete(actorId); continue; }
			const dist = Number(cfg.triggerDistance) || 4096;
			if (distanceOk(cfg.spawnPoint, dist)) {
				try {
					mp.set(actorId, "locationalData", cfg.spawnPoint);
					mp.set(actorId, "isDead", false); // engine Respawn
					pendingTrigger.delete(actorId);
					console.log(LOG, "trigger respawn:", actorId.toString(16));
				} catch (e) {
					pendingTrigger.delete(actorId);
				}
			}
		}

		// despawn timers (lifetime since spawn)
		for (const npc of mp.vgrNpcList()) {
			const despawnSec = Number(npc.config.despawnSec) || 0;
			if (despawnSec > 0 && now - npc.config.spawnedAt > despawnSec * 1000) {
				console.log(LOG, "despawn timer expired:", npc.idHex);
				mp.vgrNpcDelete(npc.id);
			}
		}
	};

	// idempotent across gamemode hot-reloads (module factory re-runs)
	if (mp._vgrNpcsTick) clearInterval(mp._vgrNpcsTick);
	mp._vgrNpcsTick = setInterval(vgrTick, 3000);

	// ----- boot pass: re-apply policies after restart resurrection -----
	// The engine revives dead-loaded actors ~spawnDelay after boot; for "never"
	// NPCs that died just before a restart, delete them now; for "trigger"
	// NPCs, re-arm the approach watcher.
	try {
		let cleaned = 0;
		for (const npc of mp.vgrNpcList()) {
			if (npc.isDead && npc.respawnMode === "never") {
				mp.vgrNpcDelete(npc.id);
				cleaned++;
			} else if (npc.isDead && npc.respawnMode === "trigger") {
				pendingTrigger.set(npc.id, Date.now());
			}
		}
		if (cleaned) console.log(LOG, "boot cleanup removed", cleaned, "permanently-dead npc(s)");
	} catch (e) {
		console.error(LOG, "boot pass failed:", e);
	}

	console.log(LOG, "module loaded - registry:", mp.vgrNpcList().length, "npc(s)");
};
