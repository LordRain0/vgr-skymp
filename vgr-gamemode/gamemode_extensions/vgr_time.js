// Config (server-settings.json):
// "vgrTime": { "timescale": 20, "anchor": { "year": 201, "month": 8, "day": 17, "hour": 9 } }
// timescale = game-seconds per real-second (vanilla Skyrim default is 20).

const fs = require("fs");
const path = require("path");

module.exports = (mp) => {

	const LOG = "[VGR time]";
	const STATE_FILE = path.join(__dirname, "vgr_time_state.json");
	const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

	let settings = {};
	try {
		settings = mp.getServerSettings ? mp.getServerSettings() : {};
	} catch (e) {
		console.error(LOG, "failed to read server settings:", e);
	}
	const cfg = settings.vgrTime || {};
	const timescale = Number(cfg.timescale) > 0 ? Number(cfg.timescale) : 20;
	const configAnchor = cfg.anchor || { year: 201, month: 8, day: 17, hour: 9 };

	// Anchor for THIS server session: prefer persisted continuity state
	let anchor = {
		year: Number(configAnchor.year) || 201,
		month: Math.min(12, Math.max(1, Number(configAnchor.month) || 1)),
		day: Math.max(1, Number(configAnchor.day) || 1),
		hour: Number(configAnchor.hour) || 0
	};
	try {
		if (fs.existsSync(STATE_FILE)) {
			const saved = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
			if (saved && saved.anchor && typeof saved.anchor.hour === "number") {
				anchor = saved.anchor;
				console.log(LOG, "resumed clock from state file");
			}
		}
	} catch (e) {
		console.error(LOG, "state file unreadable, using config anchor:", e);
	}
	const anchorRealMs = Date.now();

	// Current game time = anchor rolled forward by elapsed real time
	const vgrComputeNow = () => {
		const elapsedRealHours = (Date.now() - anchorRealMs) / 3600000;
		let hour = anchor.hour + elapsedRealHours * timescale;
		let day = anchor.day;
		let month = anchor.month; // 1-12
		let year = anchor.year;
		let extraDays = Math.floor(hour / 24);
		hour -= extraDays * 24;
		while (extraDays > 0) {
			const remaining = DAYS_IN_MONTH[month - 1] - day;
			if (extraDays <= remaining) {
				day += extraDays;
				extraDays = 0;
			} else {
				extraDays -= remaining + 1;
				day = 1;
				month += 1;
				if (month > 12) { month = 1; year += 1; }
			}
		}
		return { year, month, day, hour };
	};

	// Persist continuity so restarts don't rewind the clock
	const vgrSaveState = () => {
		try {
			fs.writeFileSync(STATE_FILE, JSON.stringify({ anchor: vgrComputeNow() }, null, 2));
		} catch (e) {
			console.error(LOG, "state save failed:", e);
		}
	};

	// Client side: stash the anchor for TimeService (skymp5-client reads sp.storage["vgrServerTime"])
	// nonce-guarded because updateOwner runs every frame.
	mp.makeProperty("vgrTime", {
		isVisibleByOwner: true,
		isVisibleByNeighbors: false,
		updateOwner: `
			const value = ctx.value;
			if (!value || !value.nonce) return;
			if (ctx.state.vgrTimeNonce === value.nonce) return;
			ctx.state.vgrTimeNonce = value.nonce;
			ctx.sp.storage["vgrServerTime"] = {
				anchor: value.anchor,
				anchorRealMs: Date.now() - value.elapsedSinceAnchorMs,
				timescale: value.timescale
			};
		`,
		updateNeighbor: ""
	});

	const vgrPushTime = (actorId) => {
		try {
			mp.set(actorId, "vgrTime", {
				nonce: Date.now() + ":" + Math.random(),
				anchor: anchor,
				elapsedSinceAnchorMs: Date.now() - anchorRealMs,
				timescale: timescale
			});
			return true;
		} catch (e) {
			return false;
		}
	};

	// Join detection
	const vgrPushed = new Set();
	const vgrTick = () => {
		let players = [];
		try { players = mp.get(0, "onlinePlayers") || []; } catch (e) { return; }
		for (const actorId of players) {
			if (vgrPushed.has(actorId)) continue;
			if (vgrPushTime(actorId)) vgrPushed.add(actorId);
		}
	};

	mp.on("disconnect", (userId) => {
		try {
			const actorId = mp.getUserActor ? mp.getUserActor(userId) : 0;
			if (actorId) vgrPushed.delete(actorId);
		} catch (e) { /* actor may already be gone */ }
	});

	// idempotent across gamemode hot-reloads (module factory re-runs)
	if (mp._vgrTimeTick) clearInterval(mp._vgrTimeTick);
	mp._vgrTimeTick = setInterval(vgrTick, 3000);
	if (mp._vgrTimeSave) clearInterval(mp._vgrTimeSave);
	mp._vgrTimeSave = setInterval(vgrSaveState, 60 * 1000);

	const now = vgrComputeNow();
	console.log(LOG, "started - timescale", timescale, "| game time",
		now.year + "-" + now.month + "-" + now.day, Math.floor(now.hour) + ":" + String(Math.floor((now.hour % 1) * 60)).padStart(2, "0"));
};
