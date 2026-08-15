// Config: vgr_weather_config.json (regions, pools, weights, hold times).
// Weather formIds are validated against the loaded espm at boot.
//
// Admin/API surface for other extensions:
//   mp.vgrWeatherSetRegion(regionId, weatherFormId, holdMs?) -> bool
//   mp.vgrWeatherStatus() -> { regions: {id: {label, formId, nextChangeAt}}, players }
//
// v1 (global cycle) failed on two bugs this version avoids: it called a
// nonexistent SP API (Weather.forceWeather) inside try/catch, and its
// updateOwner had no nonce guard so it re-applied every frame.

const fs = require("fs");
const path = require("path");

module.exports = (mp) => {

	const LOG = "[VGR weather]";

	// config
	let config = { pollIntervalMs: 2000, regions: [] };
	try {
		config = JSON.parse(fs.readFileSync(path.join(__dirname, "vgr_weather_config.json"), "utf8"));
	} catch (e) {
		console.error(LOG, "failed to load vgr_weather_config.json:", e);
	}

	const regions = (config.regions || []).map((r) => ({
		id: String(r.id),
		name: r.name || r.id,
		priority: Number(r.priority) || 0,
		worldspaces: Array.isArray(r.worldspaces) ? r.worldspaces : [],
		bounds: r.bounds || null,
		minHoldMs: Number(r.minHoldMs) || 480000,
		maxHoldMs: Number(r.maxHoldMs) || 1200000,
		weathers: (r.weathers || []).map((w) => ({
			formId: typeof w.formId === "string" ? parseInt(w.formId, 16) : Number(w.formId),
			label: w.label || String(w.formId),
			weight: Number(w.weight) > 0 ? Number(w.weight) : 1
		}))
	})).filter((r) => r.weathers.length > 0);

	// sort by priority descending so the first bounds match wins
	regions.sort((a, b) => b.priority - a.priority);

	if (regions.length === 0) {
		console.error(LOG, "no usable regions configured - weather system inactive");
		return;
	}

	// validate weather formIds against the loaded plugins (WTHR records)
	for (const region of regions) {
		for (const w of region.weathers) {
			try {
				const res = mp.lookupEspmRecordById(w.formId);
				const type = res && res.record ? res.record.type : null;
				if (type !== "WTHR") {
					console.error(LOG, "config warning:", region.id, "weather", w.label,
						"0x" + w.formId.toString(16).toUpperCase(),
						type ? "is a " + type + " record, not WTHR" : "not found in load order");
				}
			} catch (e) { /* lookup unavailable - skip validation */ }
		}
	}

	// per-region weather state
	const regionState = new Map(); // regionId -> { current: {formId,label}, nextChangeAt }

	const vgrRollWeather = (region, excludeFormId) => {
		const pool = region.weathers.filter((w) => w.formId !== excludeFormId);
		const usable = pool.length > 0 ? pool : region.weathers;
		const totalWeight = usable.reduce((sum, w) => sum + w.weight, 0);
		let roll = Math.random() * totalWeight;
		let picked = usable[usable.length - 1];
		for (const w of usable) {
			roll -= w.weight;
			if (roll <= 0) { picked = w; break; }
		}
		const holdMs = region.minHoldMs +
			Math.floor(Math.random() * Math.max(1, region.maxHoldMs - region.minHoldMs));
		regionState.set(region.id, { current: picked, nextChangeAt: Date.now() + holdMs });
		return picked;
	};

	for (const region of regions) {
		const w = vgrRollWeather(region, null);
		console.log(LOG, "region", region.id, "starts with", w.label);
	}

	// region resolution (worldspace + XY bounds)
	const vgrResolveRegion = (worldOrCellDesc, pos) => {
		for (const region of regions) {
			if (region.worldspaces.indexOf(worldOrCellDesc) === -1) continue;
			const b = region.bounds;
			if (b) {
				if (!Array.isArray(pos) || pos.length < 2) continue;
				if (pos[0] < b.minX || pos[0] > b.maxX || pos[1] < b.minY || pos[1] > b.maxY) continue;
			}
			return region;
		}
		return null; // interior or unlisted worldspace: keep last weather
	};

	// client side
	// updateOwner runs EVERY frame: nonce guard is mandatory. Applies the
	// weather and remembers it in ctx.state for the reassert event source.
	mp.makeProperty("vgrWeather", {
		isVisibleByOwner: true,
		isVisibleByNeighbors: false,
		updateOwner: `
			const value = ctx.value;
			if (!value || !value.nonce) return;
			if (!ctx.state.vgrWeatherClient) ctx.state.vgrWeatherClient = { lastNonce: null, lastFormId: null };
			const st = ctx.state.vgrWeatherClient;
			if (st.lastNonce === value.nonce) return;
			st.lastNonce = value.nonce;
			st.lastFormId = value.formId;
			try {
				const w = ctx.sp.Weather.from(ctx.sp.Game.getFormEx(value.formId));
				if (!w) return;
				if (value.mode === "force") {
					w.forceActive(true);
				} else {
					w.setActive(true, value.mode === "fast");
				}
			} catch (e) {
				ctx.sp.printConsole("[VGR weather] apply failed: " + e);
			}
		`,
		updateNeighbor: ""
	});

	// Reassert after cell loads (interior exits, fast travel): the engine can
	// stomp a forced weather on load; there is no weather-change event in SP,
	// so re-apply only when the active weather diverges from ours.
	mp.makeEventSource("_vgrWeatherReassert", `
		ctx.sp.on("cellFullyLoaded", () => {
			const st = ctx.state.vgrWeatherClient;
			if (!st || !st.lastFormId) return;
			ctx.sp.once("update", () => {
				try {
					const current = ctx.sp.Weather.getCurrentWeather();
					if (current && current.getFormID() === st.lastFormId) return;
					const w = ctx.sp.Weather.from(ctx.sp.Game.getFormEx(st.lastFormId));
					if (w) w.forceActive(true);
				} catch (e) {}
			});
		});
	`);

	// server tick
	const actorCache = new Map(); // actorId -> { regionId, formId }

	const vgrPushWeather = (actorId, formId, mode) => {
		try {
			mp.set(actorId, "vgrWeather", {
				nonce: Date.now() + ":" + Math.random(),
				formId: formId,
				mode: mode
			});
			return true;
		} catch (e) {
			return false;
		}
	};

	const vgrTick = () => {
		const now = Date.now();

		// roll region weathers that are due
		for (const region of regions) {
			const state = regionState.get(region.id);
			if (now >= state.nextChangeAt) {
				const next = vgrRollWeather(region, state.current.formId);
				console.log(LOG, "region", region.id, "->", next.label);
			}
		}

		// deliver to players on region-cross or region-weather change only
		let players = [];
		try { players = mp.get(0, "onlinePlayers") || []; } catch (e) { return; }
		const online = new Set(players);

		for (const actorId of players) {
			try {
				const worldOrCellDesc = mp.get(actorId, "worldOrCellDesc");
				const pos = mp.get(actorId, "pos");
				const region = vgrResolveRegion(worldOrCellDesc, pos);
				if (!region) continue; // interior: keep last weather

				const current = regionState.get(region.id).current;
				const cached = actorCache.get(actorId);

				if (!cached) {
					// first sight after join: force so stale persisted weather is replaced
					if (vgrPushWeather(actorId, current.formId, "force")) {
						actorCache.set(actorId, { regionId: region.id, formId: current.formId });
					}
				} else if (cached.regionId !== region.id) {
					// crossed a region boundary: fast (accelerated) transition
					if (vgrPushWeather(actorId, current.formId, cached.formId === current.formId ? "smooth" : "fast")) {
						actorCache.set(actorId, { regionId: region.id, formId: current.formId });
					}
				} else if (cached.formId !== current.formId) {
					// weather rolled in place: natural transition
					if (vgrPushWeather(actorId, current.formId, "smooth")) {
						actorCache.set(actorId, { regionId: region.id, formId: current.formId });
					}
				}
			} catch (e) {
				actorCache.delete(actorId);
			}
		}

		// drop cache entries for departed actors
		for (const actorId of actorCache.keys()) {
			if (!online.has(actorId)) actorCache.delete(actorId);
		}
	};

	// idempotent across gamemode hot-reloads (module factory re-runs)
	if (mp._vgrWeatherTick) clearInterval(mp._vgrWeatherTick);
	mp._vgrWeatherTick = setInterval(vgrTick, Number(config.pollIntervalMs) || 2000);

	// admin / extension API
	mp.vgrWeatherSetRegion = (regionId, weatherFormId, holdMs) => {
		const region = regions.find((r) => r.id === regionId);
		if (!region) return false;
		const formId = typeof weatherFormId === "string" ? parseInt(weatherFormId, 16) : Number(weatherFormId);
		const match = region.weathers.find((w) => w.formId === formId);
		regionState.set(region.id, {
			current: match || { formId: formId, label: "0x" + formId.toString(16) },
			nextChangeAt: Date.now() + (Number(holdMs) || 30 * 60 * 1000)
		});
		console.log(LOG, "admin set region", regionId, "->", "0x" + formId.toString(16));
		return true;
	};

	mp.vgrWeatherStatus = () => {
		const out = { regions: {}, players: actorCache.size };
		for (const region of regions) {
			const state = regionState.get(region.id);
			out.regions[region.id] = {
				label: state.current.label,
				formId: "0x" + state.current.formId.toString(16).toUpperCase(),
				nextChangeInSec: Math.max(0, Math.round((state.nextChangeAt - Date.now()) / 1000))
			};
		}
		return out;
	};

	console.log(LOG, "region weather started -", regions.length, "regions, poll", (Number(config.pollIntervalMs) || 2000) + "ms");
};
