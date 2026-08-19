// ==========================================
// VGR ACTOR HYGIENE
// ==========================================
// Player changeForm docs are $set-only Mongo upserts and are never deleted,
// so a formDesc once used by a scaled NPC (vgr_npcs SetNodeScale at spawn)
// keeps its setNodeScale entry forever. After a restart the server recycles
// low formIds, and a new player character created on such a contaminated doc
// inherits the NPC root scale - players render as giants to everyone.
// The current setNodeScale value is not readable through the gamemode API
// (there is no property binding for it), so this extension unconditionally
// writes root scale 1 once per login for every player actor. The call is
// cheap and idempotent: it rewrites the persisted changeForm entry AND the
// SpSnippet it broadcasts live-corrects the scale on every observer.

"use strict";

module.exports = (mp) => {
	const LOG = "[VGR actor_hygiene]";
	const ROOT_NODE = "NPC Root [Root]";
	const SWEEP_MS = 5000;

	const vgrHelpers = require("./vgr_helpers");
	const actors = vgrHelpers.playerInteractions.createActorHelpers(mp, {});

	// pcFormIds already normalized this server session; cleared on disconnect
	// so a re-login re-applies (still just one call per login).
	const treated = new Set();

	// Same Papyrus argument shape as the vgr_npcs spawn override: a "form"
	// arg resolves a world reference (the player actor), then node name,
	// scale, firstPerson.
	const asForm = (formId) => ({ type: "form", desc: mp.getDescFromId(formId) });

	function isPlayerActor(pcFormId) {
		try {
			return Number(mp.get(pcFormId, "profileId")) > 0;
		} catch (e) {
			return false;
		}
	}

	function enforceRootScale(pcFormId) {
		const id = Number(pcFormId);
		if (!Number.isInteger(id) || id <= 0 || treated.has(id)) return;
		if (!isPlayerActor(id)) return;
		try {
			mp.callPapyrusFunction("global", "NetImmerse", "SetNodeScale", null,
				[asForm(id), ROOT_NODE, 1, false]);
			treated.add(id);
		} catch (e) {
			// Actor may still be mid-load; the sweep below retries until it works.
		}
	}

	function sweepOnline() {
		for (const pcFormId of actors.onlinePlayers()) enforceRootScale(pcFormId);
	}

	// "connect" fires before the login flow attaches the actor, so the
	// immediate resolve usually returns 0 on a fresh login; the sweep interval
	// picks the actor up right after spawn. Trying here still catches fast
	// reconnects where the user->actor mapping already exists.
	mp.on("connect", (userId) => {
		try {
			enforceRootScale(actors.actorFromUser(userId));
		} catch (e) { /* never break the connect chain */ }
	});

	mp.on("disconnect", (userId) => {
		try {
			const pcFormId = actors.actorFromUser(userId);
			if (pcFormId) treated.delete(Number(pcFormId));
		} catch (e) {
			/* ignore - lookup can fail while the user slot winds down */
		} finally {
			actors.forgetUser(userId);
		}
	});

	// idempotent across gamemode hot-reloads (module factory re-runs)
	if (mp._vgrActorHygieneTick) clearInterval(mp._vgrActorHygieneTick);
	mp._vgrActorHygieneTick = setInterval(() => {
		try { sweepOnline(); } catch (e) { /* keep the tick alive */ }
	}, SWEEP_MS);

	// Catch players that are already online when the gamemode (re)loads.
	try { sweepOnline(); } catch (e) { /* best-effort boot pass */ }

	console.log(LOG, "module loaded - enforcing root node scale 1 on player actors");
};
