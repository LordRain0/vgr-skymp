"use strict";
// ---------------------------------------------------------------------------
// VGR Enchanting: profession-gated enchanting at arcane enchanters.
//
// The vanilla enchanting menu mutates items into DYNAMIC forms that cannot
// persist or sync, and its output isn't even capturable client-side. So the
// vanilla menu is blocked entirely; activating an enchanting station as a
// trained enchanter opens the VGR enchanting UI instead (CEF). The UI offers
// recipes = PRE-ENCHANTED base records from the load order ("Iron Sword of
// Burning"), filtered to what the player can make: recipe tier <= allocated
// nodes in the Enchanting tree (master rank = everything). Crafting consumes
// the base item + a filled soul gem and grants the pre-enchanted record -
// a plain static baseId that persists, syncs, and renders on every client.
// ---------------------------------------------------------------------------

module.exports = (mp) => {
	const LOG = "[VGR enchanting]";

	let DATA;
	try {
		DATA = require("./vgr_crafting_data.json");
	} catch (e) {
		console.error(LOG, "vgr_crafting_data.json missing - run tools/build_crafting_catalogs.js; enchanting disabled");
		return;
	}

	const stationIds = new Set(DATA.stations.enchanting.map((s) => parseInt(s.id, 16)));

	// soul gems accepted as fuel, by recipe tier. FILLED variants only (the
	// soul is what's consumed). Grand covers everything below it.
	const SOUL_GEMS = {
		1: ["SoulGemPettyFilled", "SoulGemLesserFilled", "SoulGemCommonFilled", "SoulGemGreaterFilled", "SoulGemGrandFilled"],
		2: ["SoulGemLesserFilled", "SoulGemCommonFilled", "SoulGemGreaterFilled", "SoulGemGrandFilled"],
		3: ["SoulGemCommonFilled", "SoulGemGreaterFilled", "SoulGemGrandFilled"],
		4: ["SoulGemGreaterFilled", "SoulGemGrandFilled"],
		5: ["SoulGemGrandFilled"],
		6: ["SoulGemGrandFilled"]
	};
	const gemIdsByEditor = new Map();
	for (const g of DATA.soulGems) if (g.e) gemIdsByEditor.set(g.e, parseInt(g.id, 16));

	// MASTER_ALLOCATED nodes = every recipe; below that, tier <= allocated
	const MASTER_ALLOCATED = 5;

	const getAllocated = (pcFormId) => {
		try { return mp.vgrSkillsGetAllocated ? mp.vgrSkillsGetAllocated(pcFormId, "enchanting") : 0; }
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

	// push data to the enchanting UI over the same property mailbox the admin
	// panel uses (vgrAdminData -> window.vgrAdminData); the UI filters by type.
	const pushUi = (pcFormId, type, payload) => {
		try {
			mp.set(pcFormId, "vgrAdminData", { nonce: Date.now() + ":" + Math.random(), type: type, payload: payload });
		} catch (e) { console.error(LOG, "ui push failed:", e); }
	};

	const invCounts = (pcFormId) => {
		const inv = mp.get(pcFormId, "inventory") || { entries: [] };
		const have = new Map();
		for (const e of inv.entries || []) {
			if (!e || typeof e.baseId !== "number") continue;
			// plain stacks only: enchanting an already-modified entry is out of scope
			have.set(e.baseId, (have.get(e.baseId) || 0) + (e.count || 0));
		}
		return { inv, have };
	};

	const recipesFor = (pcFormId) => {
		const allocated = getAllocated(pcFormId);
		if (allocated < 1) return { allocated, recipes: [] };
		const maxTier = allocated >= MASTER_ALLOCATED ? Infinity : allocated;
		const { have } = invCounts(pcFormId);
		const recipes = [];
		for (const r of DATA.enchantRecipes) {
			if (r.tier > maxTier) continue;
			const baseId = parseInt(r.base, 16);
			recipes.push({
				result: r.result, resultName: r.resultName,
				base: r.base, baseName: r.baseName, t: r.t,
				enchName: r.enchName, tier: r.tier,
				haveBase: (have.get(baseId) || 0) > 0
			});
		}
		return { allocated, recipes };
	};

	// ----- station gate: block vanilla menu; open VGR UI for enchanters -----
	if (typeof mp.vgrRegisterActivationBlocker === "function") {
		mp.vgrRegisterActivationBlocker("vgr_enchanting_station_gate", 60, (targetFormId, actorFormId) => {
			if (!stationIds.has(baseIdOf(targetFormId))) return; // not an enchanter - no opinion
			if (getAllocated(actorFormId) < 1) {
				notify(actorFormId, "Only trained enchanters can use an arcane enchanter. Unlock the Enchanting profession (K).");
				return false;
			}
			// trained: still block the vanilla menu (its output can't persist),
			// open the VGR enchanting UI instead
			const { allocated, recipes } = recipesFor(actorFormId);
			// gems the player holds, for the UI's fuel display
			const { have } = invCounts(actorFormId);
			const gems = [];
			for (const [editor, id] of gemIdsByEditor) {
				const count = have.get(id) || 0;
				if (count > 0) gems.push({ e: editor, count: count });
			}
			pushUi(actorFormId, "enchanting_open", { allocated: allocated, recipes: recipes, gems: gems });
			return false;
		});
	} else {
		console.error(LOG, "activation service missing - station gate NOT installed");
	}

	// ----- craft event from the UI -----
	// payload.data: { result: "0x..." }
	mp.vgrEnchantingCraft = (pcFormId, resultHex) => {
		const allocated = getAllocated(pcFormId);
		if (allocated < 1) { notify(pcFormId, "You are not trained in enchanting."); return false; }
		const maxTier = allocated >= MASTER_ALLOCATED ? Infinity : allocated;

		const recipe = DATA.enchantRecipes.find((r) => r.result === String(resultHex));
		if (!recipe) { notify(pcFormId, "Unknown enchantment recipe."); return false; }
		if (recipe.tier > maxTier) { notify(pcFormId, "That enchantment is beyond your rank."); return false; }

		const baseId = parseInt(recipe.base, 16);
		const resultId = parseInt(recipe.result, 16);
		const gemEditors = SOUL_GEMS[Math.min(recipe.tier, 6)] || SOUL_GEMS[6];

		const { have } = invCounts(pcFormId);
		if ((have.get(baseId) || 0) < 1) { notify(pcFormId, "You need a " + recipe.baseName + "."); return false; }
		const gemId = gemEditors.map((e) => gemIdsByEditor.get(e)).find((id) => id && (have.get(id) || 0) > 0);
		if (!gemId) { notify(pcFormId, "You need a filled soul gem of sufficient power."); return false; }

		// swap: remove base item + gem (plain stacks only), add result
		const inv = mp.get(pcFormId, "inventory") || { entries: [] };
		const entries = (inv.entries || []).slice();
		const takeOne = (id) => {
			for (let i = 0; i < entries.length; i++) {
				const e = entries[i];
				if (!e || e.baseId !== id) continue;
				// only consume plain stacks (no extras) so we never destroy a
				// worn/enchanted/named instance by accident
				if (!Object.keys(e).every((k) => k === "baseId" || k === "count")) continue;
				if ((e.count || 0) <= 1) entries.splice(i, 1);
				else entries[i] = Object.assign({}, e, { count: e.count - 1 });
				return true;
			}
			return false;
		};
		if (!takeOne(baseId)) { notify(pcFormId, "You need an unequipped, unmodified " + recipe.baseName + "."); return false; }
		if (!takeOne(gemId)) { notify(pcFormId, "You need a filled soul gem of sufficient power."); return false; }
		const existing = entries.find((e) => e && e.baseId === resultId && Object.keys(e).every((k) => k === "baseId" || k === "count"));
		if (existing) existing.count += 1;
		else entries.push({ baseId: resultId, count: 1 });
		mp.set(pcFormId, "inventory", { entries: entries });

		notify(pcFormId, "Enchanted: " + recipe.resultName + ".", "success");
		if (typeof mp.vgrSkillsOnGather === "function") {
			mp.vgrSkillsOnGather(pcFormId, "enchanting", 1);
		}
		console.log(LOG, "0x" + pcFormId.toString(16), "enchanted", recipe.resultName, "(" + recipe.result + ")");
		return true;
	};

	// ----- browser -> server command channel -----
	mp.makeEventSource("_vgrEnchanting", `
	  ctx.sp.on("browserMessage", (e) => {
	    const msg = e.arguments && e.arguments[0];
	    if (msg !== "vgr:enchanting") return;
	    ctx.sendEvent({ kind: e.arguments[1], data: e.arguments[2] });
	  });
	`);
	mp._vgrEnchanting = (pcFormId, payload) => {
		try {
			if (!payload || !payload.kind) return;
			if (payload.kind === "craft") {
				const ok = mp.vgrEnchantingCraft(pcFormId, payload.data && payload.data.result);
				if (ok) {
					// refresh the open UI with updated inventory/gems
					const { allocated, recipes } = recipesFor(pcFormId);
					const { have } = invCounts(pcFormId);
					const gems = [];
					for (const [editor, id] of gemIdsByEditor) {
						const count = have.get(id) || 0;
						if (count > 0) gems.push({ e: editor, count: count });
					}
					pushUi(pcFormId, "enchanting_open", { allocated: allocated, recipes: recipes, gems: gems, refresh: true });
				}
			}
		} catch (e) { console.error(LOG, "command failed:", e && e.stack ? e.stack : e); }
	};

	console.log(LOG, "module loaded -", DATA.enchantRecipes.length, "recipes,", stationIds.size, "station bases");
};
