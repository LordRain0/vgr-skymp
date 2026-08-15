"use strict";
// ---------------------------------------------------------------------------
// VGR Alchemy: profession-gated potion crafting at vanilla alchemy labs.
//
// The vanilla alchemy menu creates a DYNAMIC ALCH form (session-local, cannot
// persist or sync). Flow here: the client's existing CraftService reports the
// craft (ingredients consumed) via CraftItemMessage; the C++ CraftService,
// finding no COBJ recipe for an alchemy workbench, fires the gamemode event
// "onCustomCraftAttempt" (VGR C++ addition). This extension then re-derives
// the result the way vanilla does - ingredients sharing a common effect - and
// grants the CANONICAL static potion from vgr_crafting_data.json at the tier
// the player's Alchemy profession allows. The dynamic client-side potion is
// wiped by the authoritative inventory reapply; the real one takes its place.
//
// Gating: non-alchemists can't open alchemy labs at all (activation blocker).
// Traits: ingredient effect visibility by rank is served to the UI on request.
// ---------------------------------------------------------------------------

module.exports = (mp) => {
	const LOG = "[VGR alchemy]";

	let DATA;
	try {
		DATA = require("./vgr_crafting_data.json");
	} catch (e) {
		console.error(LOG, "vgr_crafting_data.json missing - run tools/build_crafting_catalogs.js; alchemy disabled");
		return;
	}

	const stationIds = new Set(DATA.stations.alchemy.map((s) => parseInt(s.id, 16)));

	// allocated nodes (0..5) -> max potion tier craftable
	// 1 Herb Lore -> t1 | 2 Minor Potions -> t2 | 3 Salves & Poisons -> t3 +
	// poisons | 4 Potent Mixtures -> t5 | 5 Grand Elixirs -> t6
	const TIER_CAP = [0, 1, 2, 3, 5, 6];
	const POISON_MIN_ALLOCATED = 3;
	// allocated -> how many of an ingredient's 4 effects the UI may reveal
	const TRAITS_VISIBLE = [0, 1, 2, 2, 3, 4];

	const getAllocated = (pcFormId) => {
		try { return mp.vgrSkillsGetAllocated ? mp.vgrSkillsGetAllocated(pcFormId, "alchemy") : 0; }
		catch (e) { return 0; }
	};
	const notify = (pcFormId, message, variant) => {
		if (typeof mp.vgrSendNotification === "function") {
			mp.vgrSendNotification(pcFormId, 2, String(message), { variant: variant || "warning" });
		}
	};
	const baseIdOf = (refrId) => {
		try { const d = mp.get(refrId, "baseDesc"); return d ? mp.getIdFromDesc(d) : 0; }
		catch (e) { return 0; }
	};
	const hex8 = (id) => "0x" + Number(id).toString(16).toUpperCase().padStart(8, "0");

	// ----- station gate: only alchemists may open alchemy labs -----
	if (typeof mp.vgrRegisterActivationBlocker === "function") {
		mp.vgrRegisterActivationBlocker("vgr_alchemy_station_gate", 60, (targetFormId, actorFormId) => {
			if (!stationIds.has(baseIdOf(targetFormId))) return; // not a lab - no opinion
			if (getAllocated(actorFormId) >= 1) return;          // trained - allow
			notify(actorFormId, "Only trained alchemists can use an alchemy lab. Unlock the Alchemy profession (K).");
			return false;
		});
	} else {
		console.error(LOG, "activation service missing - station gate NOT installed");
	}

	// ----- craft resolution -----
	// inputs: [{baseId, count}] as reported by the client's craft detector and
	// re-validated here against the server-side inventory.
	const resolveCraft = (pcFormId, inputs) => {
		const allocated = getAllocated(pcFormId);
		if (allocated < 1) return { err: "You are not trained in alchemy." };

		// validate: every input is a known ingredient
		const used = [];
		for (const entry of inputs) {
			const id = Number(entry.baseId) >>> 0;
			const ing = DATA.ingredients[hex8(id)];
			if (!ing) continue; // non-ingredient consumption (bottles etc.) - ignore
			used.push({ id, count: Math.max(1, Number(entry.count) || 1), ing });
		}
		if (used.length < 2) return { err: "A potion needs at least two ingredients." };

		// validate: server inventory actually holds them
		let inv;
		try { inv = mp.get(pcFormId, "inventory") || { entries: [] }; }
		catch (e) { return { err: "Inventory unavailable." }; }
		const have = new Map();
		for (const e of inv.entries || []) {
			if (!e || typeof e.baseId !== "number") continue;
			have.set(e.baseId, (have.get(e.baseId) || 0) + (e.count || 0));
		}
		for (const u of used) {
			if ((have.get(u.id) || 0) < u.count) {
				return { err: "You don't have those ingredients." };
			}
		}

		// vanilla rule: the potion's effect is one shared by >= 2 ingredients.
		// Count effect occurrences across DISTINCT ingredients.
		const counts = new Map(); // mgef hex -> {n, ingredients}
		for (const u of used) {
			const seen = new Set();
			for (const ef of u.ing.effects) {
				if (seen.has(ef.id)) continue;
				seen.add(ef.id);
				const c = counts.get(ef.id) || { n: 0 };
				c.n++;
				counts.set(ef.id, c);
			}
		}
		const shared = Array.from(counts.entries()).filter(([, c]) => c.n >= 2).map(([id]) => id);
		if (!shared.length) return { err: "Those ingredients share no common effect." };

		// prefer a family we actually have potions for; among those prefer
		// non-poison unless only poisons match
		let family = null, famKey = null;
		for (const mgefId of shared) {
			const fam = DATA.potionFamilies[mgefId];
			if (!fam) continue;
			if (fam.isPoison && allocated < POISON_MIN_ALLOCATED) continue;
			if (!family || (family.isPoison && !fam.isPoison)) { family = fam; famKey = mgefId; }
		}
		if (!family) {
			const anyPoison = shared.some((id) => DATA.potionFamilies[id] && DATA.potionFamilies[id].isPoison);
			return { err: anyPoison ? "Brewing poisons requires the Salves & Poisons rank." : "No known brew matches those effects." };
		}

		const cap = TIER_CAP[Math.min(allocated, TIER_CAP.length - 1)];
		const potion = family.potions.filter((p) => p.tier <= cap).pop() || family.potions[0];
		return { used, family, potion };
	};

	// ----- craft event (fired by C++ when no COBJ recipe matches) -----
	// args: actorId, workbenchBaseId, inputs [{baseId, count}]
	mp.onCustomCraftAttempt = (actorId, workbenchBaseId, inputs) => {
		try {
			if (!stationIds.has(Number(workbenchBaseId) >>> 0)) return; // not alchemy - ignore
			let list = inputs;
			if (typeof inputs === "string") { try { list = JSON.parse(inputs); } catch (e) { list = []; } }
			if (list && Array.isArray(list.entries)) list = list.entries;
			if (!Array.isArray(list) || !list.length) return;

			const res = resolveCraft(actorId, list);
			if (res.err) { notify(actorId, res.err); return; }

			// deduct ingredients + grant canonical potion in one inventory write
			const inv = mp.get(actorId, "inventory") || { entries: [] };
			const entries = (inv.entries || []).slice();
			for (const u of res.used) {
				let remaining = u.count;
				for (let i = 0; i < entries.length && remaining > 0; i++) {
					const e = entries[i];
					if (!e || e.baseId !== u.id) continue;
					const take = Math.min(e.count || 0, remaining);
					remaining -= take;
					if ((e.count || 0) - take <= 0) { entries.splice(i, 1); i--; }
					else entries[i] = Object.assign({}, e, { count: e.count - take });
				}
			}
			const potionId = parseInt(res.potion.id, 16);
			const existing = entries.find((e) => e && e.baseId === potionId && Object.keys(e).every((k) => k === "baseId" || k === "count"));
			if (existing) existing.count += 1;
			else entries.push({ baseId: potionId, count: 1 });
			mp.set(actorId, "inventory", { entries: entries });

			notify(actorId, "Brewed " + res.potion.n + ".", "success");
			if (typeof mp.vgrSkillsOnGather === "function") {
				mp.vgrSkillsOnGather(actorId, "alchemy", 1);
			}
			console.log(LOG, hex8(actorId), "brewed", res.potion.e, "(" + res.potion.id + ") from",
				res.used.map((u) => u.ing.n + " x" + u.count).join(", "));
		} catch (e) {
			console.error(LOG, "craft attempt failed:", e && e.stack ? e.stack : e);
		}
	};

	// ----- ingredient traits (UI request via admin-style data channel) -----
	// Returns the ingredient list with effects truncated to the player's rank.
	mp.vgrAlchemyGetTraits = (pcFormId) => {
		const allocated = getAllocated(pcFormId);
		const visible = TRAITS_VISIBLE[Math.min(allocated, TRAITS_VISIBLE.length - 1)];
		const out = [];
		for (const [id, ing] of Object.entries(DATA.ingredients)) {
			out.push({
				id: id,
				n: ing.n,
				effects: ing.effects.slice(0, visible).map((ef) => ef.n),
				hidden: Math.max(0, ing.effects.length - visible)
			});
		}
		return { allocated: allocated, visible: visible, ingredients: out };
	};

	// ----- browser -> server: traits request (Professions menu, Alchemy tab) -----
	mp.makeEventSource("_vgrAlchemy", `
	  ctx.sp.on("browserMessage", (e) => {
	    const msg = e.arguments && e.arguments[0];
	    if (msg !== "vgr:alchemy") return;
	    ctx.sendEvent({ kind: e.arguments[1], data: e.arguments[2] });
	  });
	`);
	mp._vgrAlchemy = (pcFormId, payload) => {
		try {
			if (!payload || payload.kind !== "traits") return;
			const traits = mp.vgrAlchemyGetTraits(pcFormId);
			mp.set(pcFormId, "vgrAdminData", { nonce: Date.now() + ":" + Math.random(), type: "alchemy_traits", payload: traits });
		} catch (e) { console.error(LOG, "traits request failed:", e); }
	};

	console.log(LOG, "module loaded -", Object.keys(DATA.ingredients).length, "ingredients,",
		Object.keys(DATA.potionFamilies).length, "effect keys,", stationIds.size, "station bases");
};
