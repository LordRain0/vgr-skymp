// ==========================================
// VGR SKILLS & LEVELS (v1.5 - node trees)
// ==========================================
// Implements the Levels & Skill Points proposal:
//   - general XP -> character level (soft cap), +1 skill point per level
//   - per-tree skill XP, gained only once a point is allocated in that tree
//   - trees are chains of named nodes; each node costs 1 point and requires
//     the tree XP printed on it (first node always 0, per the mockups)
//   - mining nodes carry "unlocks" ore lists - harvesting an ore requires an
//     allocated node that unlocks it
//   - specialisations are GM-grant only
// Authoritative state lives in the per-actor property "private.vgrSkills"
// (auto-persisted in the changeform, never synced to clients).
// UI channel follows the vgr_trading pattern: "_vgrSkills" event source for
// browser->server requests, "vgrSkillsUi" nonce-deduped property mailbox for
// server->browser pushes, "vgrSkillsClient" for cosmetic client-side gating.
// NOTE: the vgrSkillsUi mailbox holds ONE value per client frame - a notice
// and a state refresh must travel in the SAME payload, never as two pushes.
// Tuning lives in vgr_skills_config.json - XP numbers are placeholders.

const fs = require("fs");
const path = require("path");

module.exports = (mp) => {

	const LOG = "[VGR skills]";
	const VGR_SKILLS_UI_VERSION = "1.1.0";
	const STATE_VERSION = 1;

	// ----- Config -----
	const DEFAULT_CONFIG = {
		baseSkillPoints: 3,
		levelCap: 10,
		levelXp: [0, 100, 250, 450, 700, 1000, 1350, 1750, 2200, 2700, 3250],
		gather: {},
		trees: {}
	};

	let config = DEFAULT_CONFIG;
	try {
		config = JSON.parse(fs.readFileSync(path.join(__dirname, "vgr_skills_config.json"), "utf8"));
	} catch (e) {
		console.error(LOG, "failed to load vgr_skills_config.json, using defaults:", e);
	}

	const TREE_IDS = Object.keys(config.trees || {});

	// Nodes for a tree; tolerates legacy tier-style config
	const vgrTreeNodes = (cfg) => {
		if (Array.isArray(cfg.nodes) && cfg.nodes.length) return cfg.nodes;
		const maxTier = Number(cfg.maxTier) || 5;
		const tierXp = Array.isArray(cfg.tierXp) ? cfg.tierXp : [0];
		const nodes = [];
		for (let i = 0; i < maxTier; i++) {
			nodes.push({
				name: (cfg.tierNames && cfg.tierNames[i]) || ("Rank " + (i + 1)),
				xpReq: Number(tierXp[i] || 0)
			});
		}
		return nodes;
	};

	// ----- State (authoritative, persisted in changeform dynamicFields) -----

	const vgrDefaultState = () => {
		const trees = {};
		for (const id of TREE_IDS) {
			trees[id] = { xp: 0, allocated: 0 };
		}
		return {
			version: STATE_VERSION,
			generalXp: 0,
			level: 0,
			skillPoints: Number(config.baseSkillPoints) || 3,
			specializations: [],
			trees: trees
		};
	};

	const vgrGetState = (pcFormId) => {
		let state = null;
		try {
			state = mp.get(pcFormId, "private.vgrSkills");
		} catch (e) {
			console.error(LOG, "state read failed for", pcFormId, e);
		}
		if (!state || typeof state !== "object" || !state.trees) {
			return vgrDefaultState();
		}
		// tolerate config gaining new trees after a character was created
		for (const id of TREE_IDS) {
			if (!state.trees[id]) state.trees[id] = { xp: 0, allocated: 0 };
		}
		return state;
	};

	const vgrSaveState = (pcFormId, state) => {
		try {
			mp.set(pcFormId, "private.vgrSkills", state);
		} catch (e) {
			console.error(LOG, "state save failed for", pcFormId, e);
		}
	};

	const vgrLevelForXp = (generalXp) => {
		const curve = config.levelXp || DEFAULT_CONFIG.levelXp;
		const cap = Number(config.levelCap) || 10;
		let level = 0;
		for (let i = 0; i < curve.length && i <= cap; i++) {
			if (generalXp >= curve[i]) level = i;
		}
		return Math.min(level, cap);
	};

	// ----- Client-visible allocation flags (cosmetic gate for gather UIs) -----

	mp.makeProperty("vgrSkillsClient", {
		isVisibleByOwner: true,
		isVisibleByNeighbors: false,
		updateOwner: `
			const value = ctx.value;
			if (!value || !value.allocated) return;
			ctx.state.vgrSkillsAllocated = value.allocated;
		`,
		updateNeighbor: ""
	});

	const vgrPushClientFlags = (pcFormId, state) => {
		const allocated = {};
		for (const id of TREE_IDS) {
			allocated[id] = state.trees[id] ? state.trees[id].allocated : 0;
		}
		try {
			mp.set(pcFormId, "vgrSkillsClient", { allocated: allocated });
		} catch (e) {
			console.error(LOG, "client flags push failed for", pcFormId, e);
		}
	};

	// ----- UI mailbox (server -> browser) -----

	mp.makeProperty("vgrSkillsUi", {
		isVisibleByOwner: true,
		isVisibleByNeighbors: false,
		updateOwner: `
			const value = ctx.value;
			if (!value || value.version !== "${VGR_SKILLS_UI_VERSION}") return;
			if (!ctx.state.vgrSkillsUi) ctx.state.vgrSkillsUi = { lastNonce: null };
			if (ctx.state.vgrSkillsUi.lastNonce === value.nonce) return;
			ctx.state.vgrSkillsUi.lastNonce = value.nonce;
			if (value.closeUi && /^[a-z_]+$/.test(value.closeUi)) {
				ctx.sp.browser.executeJavaScript('window.skyrimPlatform?.sendMessage?.("vgr:ui:close", "' + value.closeUi + '")');
			}
			ctx.sp.browser.executeJavaScript("window.vgrSkillsUpdate && window.vgrSkillsUpdate(" + JSON.stringify(value) + ");");
		`,
		updateNeighbor: ""
	});

	const vgrBuildUiState = (state) => {
		const curve = config.levelXp || DEFAULT_CONFIG.levelXp;
		const cap = Number(config.levelCap) || 10;
		let allocatedTotal = 0;

		const trees = TREE_IDS.map((id) => {
			const cfg = config.trees[id] || {};
			const t = state.trees[id] || { xp: 0, allocated: 0 };
			const nodes = vgrTreeNodes(cfg);
			allocatedTotal += t.allocated;

			const uiNodes = nodes.map((node, i) => {
				let nodeState = "locked";
				if (i < t.allocated) {
					nodeState = "allocated";
				} else if (i === t.allocated && state.skillPoints > 0 && t.xp >= Number(node.xpReq || 0)) {
					nodeState = "unlockable";
				}
				return {
					name: node.name || ("Rank " + (i + 1)),
					sp: i + 1,
					xpReq: Number(node.xpReq || 0),
					unlocks: Array.isArray(node.unlocks) ? node.unlocks : null,
					state: nodeState
				};
			});

			return {
				id: id,
				name: cfg.name || id,
				desc: cfg.desc || "",
				xp: t.xp,
				allocated: t.allocated,
				nodes: uiNodes,
				specialization: {
					name: cfg.specialization || "Specialisation",
					unlocked: state.specializations.indexOf(id) !== -1
				}
			};
		});

		return {
			action: "state",
			level: state.level,
			levelCap: cap,
			generalXp: state.generalXp,
			prevLevelXp: Number(curve[Math.min(state.level, curve.length - 1)] || 0),
			nextLevelXp: state.level >= cap ? null : Number(curve[state.level + 1] || 0),
			skillPoints: state.skillPoints,
			allocatedTotal: allocatedTotal,
			totalPoints: allocatedTotal + state.skillPoints,
			trees: trees
		};
	};

	const vgrPushUi = (pcFormId, payload) => {
		try {
			mp.set(pcFormId, "vgrSkillsUi", Object.assign({
				version: VGR_SKILLS_UI_VERSION,
				nonce: Date.now() + ":" + Math.random()
			}, payload));
		} catch (e) {
			console.error(LOG, "ui push failed for", pcFormId, e);
		}
	};

	// Track who has the skills panel open so XP ticks refresh it live
	const vgrOpenPanels = new Set();

	// ----- Public API for other extensions -----

	// How many nodes has this player allocated in `treeId`? (Node identity is
	// positional: node i is owned iff i < allocated.) Returns 0 on any error.
	mp.vgrSkillsGetAllocated = (pcFormId, treeId) => {
		try {
			const state = vgrGetState(pcFormId);
			const t = state.trees[treeId];
			return (t && t.allocated) || 0;
		} catch (e) { return 0; }
	};

	// May this player use the gather gameplay of `treeId`? meta.oreType (for
	// mining) is checked against the union of allocated nodes' `unlocks`.
	mp.vgrSkillsCanGather = (pcFormId, treeId, meta) => {
		try {
			const cfg = config.trees[treeId];
			if (!cfg || !cfg.gatherGated) return true;
			const state = vgrGetState(pcFormId);
			const t = state.trees[treeId];
			if (!t || t.allocated < 1) return false;

			const oreType = meta && meta.oreType ? String(meta.oreType) : null;
			if (oreType) {
				const nodes = vgrTreeNodes(cfg);
				const usesUnlocks = nodes.some((n) => Array.isArray(n.unlocks));
				if (usesUnlocks) {
					for (let i = 0; i < t.allocated && i < nodes.length; i++) {
						if (Array.isArray(nodes[i].unlocks) && nodes[i].unlocks.indexOf(oreType) !== -1) {
							return true;
						}
					}
					return false;
				}
			}
			return true;
		} catch (e) {
			console.error(LOG, "canGather failed:", e);
			return true; // fail open - never brick gameplay on a skills bug
		}
	};

	// Toast + close the gather UI when a gated action is denied
	mp.vgrSkillsNotifyDenied = (pcFormId, treeId, meta) => {
		const cfg = config.trees[treeId] || {};
		let notice = "Requires a skill point in " + (cfg.name || treeId) + ". Press K to open your skills.";

		const oreType = meta && meta.oreType ? String(meta.oreType) : null;
		if (oreType) {
			const nodes = vgrTreeNodes(cfg);
			const needed = nodes.find((n) => Array.isArray(n.unlocks) && n.unlocks.indexOf(oreType) !== -1);
			if (needed) {
				notice = oreType + " veins require the \"" + needed.name + "\" node in " + (cfg.name || treeId) + ". Press K to open your skills.";
			}
		}

		vgrPushUi(pcFormId, {
			action: "notice",
			notice: notice,
			closeUi: treeId === "mining" ? "mining" : null
		});
	};

	// Award XP after a VALIDATED gather. Tree XP only accrues once a point is
	// allocated (proposal rule); general XP accrues from all harvesting.
	mp.vgrSkillsOnGather = (pcFormId, treeId, amount, meta) => {
		try {
			const gatherCfg = (config.gather || {})[treeId];
			if (!gatherCfg) return;
			const n = Number(amount) || 0;
			if (n <= 0) return;

			const state = vgrGetState(pcFormId);
			let changed = false;

			const tree = state.trees[treeId];
			if (tree && tree.allocated >= 1) {
				tree.xp += n * (Number(gatherCfg.treeXpPerItem) || 0);
				changed = true;
			}

			let levelNotice = null;
			const generalGain = n * (Number(gatherCfg.generalXpPerItem) || 0);
			if (generalGain > 0) {
				state.generalXp += generalGain;
				const newLevel = vgrLevelForXp(state.generalXp);
				if (newLevel > state.level) {
					const gained = newLevel - state.level;
					state.level = newLevel;
					state.skillPoints += gained;
					levelNotice = "Level up! You are now level " + newLevel + " (+" + gained + " skill point" + (gained > 1 ? "s" : "") + ")";
					console.log(LOG, pcFormId, "leveled up to", newLevel);
				}
				changed = true;
			}

			if (changed) {
				vgrSaveState(pcFormId, state);
				// single combined push: the Ui property holds one value per frame
				if (vgrOpenPanels.has(pcFormId)) {
					const payload = vgrBuildUiState(state);
					if (levelNotice) payload.notice = levelNotice;
					vgrPushUi(pcFormId, payload);
				} else if (levelNotice) {
					vgrPushUi(pcFormId, { action: "notice", notice: levelNotice });
				}
			}
		} catch (e) {
			console.error(LOG, "onGather failed:", e);
		}
	};

	// GM APIs (wire to admin menu later)
	mp.vgrSkillsGrantPoints = (pcFormId, points) => {
		const state = vgrGetState(pcFormId);
		state.skillPoints += Number(points) || 0;
		vgrSaveState(pcFormId, state);
		vgrPushUi(pcFormId, vgrBuildUiState(state));
	};

	mp.vgrSkillsGrantSpecialization = (pcFormId, treeId) => {
		const state = vgrGetState(pcFormId);
		if (config.trees[treeId] && state.specializations.indexOf(treeId) === -1) {
			state.specializations.push(treeId);
			vgrSaveState(pcFormId, state);
			vgrPushUi(pcFormId, vgrBuildUiState(state));
		}
	};

	// ----- Browser -> server relay -----

	mp.makeEventSource("_vgrSkills", `
		ctx.sp.printConsole("[VGR skills] event source loaded");

		ctx.sp.on("browserMessage", (e) => {
			const msg = e.arguments && e.arguments[0];
			if (msg === "vgr:skills:load") {
				ctx.sendEvent({ kind: "load" });
			} else if (msg === "vgr:skills:allocate") {
				ctx.sendEvent({ kind: "allocate", treeId: e.arguments[1] });
			} else if (msg === "vgr:skills:allocateBatch") {
				ctx.sendEvent({ kind: "allocateBatch", trees: e.arguments[1] });
			} else if (msg === "vgr:ui:on_open" && e.arguments[1] === "skills") {
				ctx.sendEvent({ kind: "panelOpen" });
			} else if (msg === "vgr:ui:on_close" && e.arguments[1] === "skills") {
				ctx.sendEvent({ kind: "panelClose" });
			}
		});
	`);

	mp._vgrSkills = (pcFormId, payload) => {
		try {
			if (!payload) return;

			if (payload.kind === "load" || payload.kind === "panelOpen") {
				vgrOpenPanels.add(pcFormId);
				const state = vgrGetState(pcFormId);
				// lazily materialize state + client flags for fresh characters
				vgrSaveState(pcFormId, state);
				vgrPushClientFlags(pcFormId, state);
				vgrPushUi(pcFormId, vgrBuildUiState(state));
				return;
			}

			if (payload.kind === "panelClose") {
				vgrOpenPanels.delete(pcFormId);
				return;
			}

			if (payload.kind === "allocate") {
				const treeId = String(payload.treeId || "");
				const cfg = config.trees[treeId];
				if (!cfg) {
					console.log(LOG, "allocate ignored: unknown tree", treeId);
					return;
				}
				const state = vgrGetState(pcFormId);
				const tree = state.trees[treeId];
				const nodes = vgrTreeNodes(cfg);

				if (state.skillPoints <= 0) {
					vgrPushUi(pcFormId, { action: "notice", notice: "No unspent skill points." });
					return;
				}
				if (tree.allocated >= nodes.length) {
					vgrPushUi(pcFormId, { action: "notice", notice: "That skill is already at its maximum." });
					return;
				}
				const nextNode = nodes[tree.allocated];
				const required = Number(nextNode.xpReq || 0);
				if (tree.xp < required) {
					vgrPushUi(pcFormId, { action: "notice", notice: "\"" + nextNode.name + "\" needs " + required + " " + (cfg.name || treeId) + " XP (you have " + tree.xp + ")." });
					return;
				}

				tree.allocated += 1;
				state.skillPoints -= 1;
				vgrSaveState(pcFormId, state);
				vgrPushClientFlags(pcFormId, state);
				vgrPushUi(pcFormId, vgrBuildUiState(state));
				console.log(LOG, pcFormId, "allocated", treeId, "node", tree.allocated, "(" + nextNode.name + ")");
				return;
			}

			// Staged Apply from the Professions UI: payload.trees is an ordered
			// array of treeIds, one point each (repeats allowed). Validated
			// all-or-nothing so a stale client can't half-spend points.
			if (payload.kind === "allocateBatch") {
				const picks = Array.isArray(payload.trees) ? payload.trees.map(String) : [];
				if (picks.length === 0) return;

				const state = vgrGetState(pcFormId);
				const rejectWith = (msg) => {
					vgrPushUi(pcFormId, Object.assign(vgrBuildUiState(state), { notice: msg }));
				};

				if (picks.length > state.skillPoints) {
					rejectWith("Not enough unspent skill points for that selection.");
					return;
				}

				// simulate sequentially against a copy of allocated counts
				const simAllocated = {};
				for (const treeId of picks) {
					const cfg = config.trees[treeId];
					if (!cfg) {
						rejectWith("Unknown profession in selection.");
						return;
					}
					const tree = state.trees[treeId];
					const nodes = vgrTreeNodes(cfg);
					if (!(treeId in simAllocated)) simAllocated[treeId] = tree.allocated;
					const idx = simAllocated[treeId];
					if (idx >= nodes.length) {
						rejectWith((cfg.name || treeId) + " is already at its maximum.");
						return;
					}
					const required = Number(nodes[idx].xpReq || 0);
					if (tree.xp < required) {
						rejectWith("\"" + nodes[idx].name + "\" needs " + required + " " + (cfg.name || treeId) + " XP (you have " + tree.xp + ").");
						return;
					}
					simAllocated[treeId] = idx + 1;
				}

				// all valid - commit
				for (const treeId in simAllocated) {
					state.trees[treeId].allocated = simAllocated[treeId];
				}
				state.skillPoints -= picks.length;
				vgrSaveState(pcFormId, state);
				vgrPushClientFlags(pcFormId, state);
				vgrPushUi(pcFormId, Object.assign(vgrBuildUiState(state), {
					notice: picks.length + " skill point" + (picks.length > 1 ? "s" : "") + " applied."
				}));
				console.log(LOG, pcFormId, "batch-allocated", JSON.stringify(simAllocated));
				return;
			}
		} catch (e) {
			console.error(LOG, "handler failed:", e);
		}
	};

	// Session hygiene: connect/disconnect callbacks receive the USER id (not
	// an actor formId - see ScampServerListener.cpp); we only need to drop
	// panel-open tracking, keyed by actor, so resolve it defensively.
	mp.on("disconnect", (userId) => {
		try {
			const actorId = mp.getUserActor ? mp.getUserActor(userId) : 0;
			if (actorId) vgrOpenPanels.delete(actorId);
		} catch (e) { /* actor may already be gone */ }
	});

	console.log(LOG, "module loaded -", TREE_IDS.length, "trees (node model)");
};
