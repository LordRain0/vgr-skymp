module.exports = (mp) => {
	
	const LOG_ADMIN = "[VGR Admin]";
	const vgrHelpers = require("./vgr_helpers");
	const tradeHelpers = vgrHelpers.trade;
	const actors = vgrHelpers.playerInteractions.createActorHelpers(mp, {});
	
	
	const VGR_Locations = {
		"High Hrothgar": {
			pos: [56897.6641, -31974.1055, 23557.9063],
			rot: [0, 0, 18.4644],
			cellOrWorldDesc: "3c:Skyrim.esm"
		},
		
		"Markarth": {
			pos: [-169535.3125, 5386.9585, -4097.5298],
			rot: [0, 0, 200],
			cellOrWorldDesc: "3c:Skyrim.esm"
		},
		
		"Solitude": {
			pos: [-68173.9609, 103311.75, -8927.1338],
			rot: [0, 0, 287],
			cellOrWorldDesc: "3c:Skyrim.esm"
		},

		"Riften": {
			pos: [174274.6406, -91459.6719, 11108.4971],
			rot: [0, 0, 160],
			cellOrWorldDesc: "3c:Skyrim.esm"
		},
		
		"Whiterun": {
			pos: [16476.6757, -9595.6777, -4686.5805],
			rot: [0, 0, 300],
			cellOrWorldDesc: "3c:Skyrim.esm"
		},
		
		"Falkreath": {
			pos: [-34020.3906, -89435.8047, -3038.1484],
			rot: [0, 0, 60.0],
			cellOrWorldDesc: "3c:Skyrim.esm"
		},
		
		"Windhelm": {
			pos: [135019.4375, 33731.6640, -12567.7031],
			rot: [0, 0, 0],
			cellOrWorldDesc: "3c:Skyrim.esm"
		},
		
		"Winterhold": {
			pos: [114050.0078, 94006.2813, -7737.9941],
			rot: [0, 0, 100],
			cellOrWorldDesc: "3c:Skyrim.esm"
		},
		
		"Morthal": {
			pos: [-39547.5117, 70770.9219, -13880.8662],
			rot: [0, 0, 177.5],
			cellOrWorldDesc: "3c:Skyrim.esm"
		},
		
		"Dawnstar": {
			pos: [26328.2324, 101092.5781, -13251.6260],
			rot: [0, 0, 0.0],
			cellOrWorldDesc: "3c:Skyrim.esm"
		},
		
		"Riverwood": {
			pos: [19233.25, -46721.7305, -141.1717],
			rot: [0, 0, 70],
			cellOrWorldDesc: "3c:Skyrim.esm"
		},
		
		"Rorikstead": {
			pos: [-78931.0703, 2789.2280, -4595.1055],
			rot: [0, 0, 150],
			cellOrWorldDesc: "3c:Skyrim.esm"
		},
		
		"Ivarstead": {
			pos: [78291.9453, -67062.6406, 10920.3896],
			rot: [0, 0, 295],
			cellOrWorldDesc: "3c:Skyrim.esm"
		},
		
		"Dragon's Bridge": {
			pos: [-100811.4531, 80907.1563, -12563.0840],
			rot: [0, 0, 332.5024],
			cellOrWorldDesc: "3c:Skyrim.esm"
		},
		
		"Raven Rock": {
			pos: [28932.6641, 33531.2734, 310.6727],
			rot: [0, 0, 86.23],
			cellOrWorldDesc: "800:Dragonborn.esm"
		},

		"Apocrypha": {
			pos: [2617.9512, 33.9083, 1292.5867], // Z raised +100
			rot: [0, 0, 0],
			cellOrWorldDesc: "1c0b2:Dragonborn.esm"
		},

		"Forgotten Vale": {
			pos: [23148.1152, 4222.9600, -859.2448],
			rot: [0, 0, 334.7898],
			cellOrWorldDesc: "bb5:Dawnguard.esm"
		},

		"Soul Cairn": {
			pos: [-14776.9541, -2957.8350, 273.5106],
			rot: [0, 0, 0],
			cellOrWorldDesc: "1408:Dawnguard.esm"
		},
		
		"Solitude Temple": {
			pos: [1676.9298, 1571.1854, -0.0000],
			rot: [0, 0, 15.75],
			cellOrWorldDesc: "16a02:Skyrim.esm"
		},
		
		"Markarth Temple": {
			pos: [-1870.3627, 356.0162, 156.2366],
			rot: [0, 0, 279.5],
			cellOrWorldDesc: "16df3:Skyrim.esm"
		},
		
		"Whiterun Temple": {
			pos: [223.2394, 248.8467, 54],
			rot: [0, 0, 0],
			cellOrWorldDesc: "165a7:Skyrim.esm"
		},
		
		"Windhelm Temple": {
			pos: [0, -2800, 64.35],
			rot: [0, 0, 0],
			cellOrWorldDesc: "16785:Skyrim.esm"
		},
		
		"Riften Temple": {
			pos: [-1414.3446, 208.6403, 64],
			rot: [0, 0, 15.75],
			cellOrWorldDesc: "16bd7:Skyrim.esm"
		},
		
		"Whiterun Tavern": {
			pos: [-108, -809, 69.25],
			rot: [0, 0, 176],
			cellOrWorldDesc: "1605e:Skyrim.esm"
		},
		
		
		
		
		"Blackreach": {
			pos: [2778.395, 9827.326, 2354.271],
			rot: [0, 0, 0],
			cellOrWorldDesc: "1ee62:Skyrim.esm"
		},
		
		"VGR-Hub": {
			pos: [0.0, 130.0, 284.0],
			rot: [0, 0, 0],
			cellOrWorldDesc: "8002:VGR-Additions.esp"
		},
		
		"Helgen": {
			pos: [14923.729, -81225.922, 8209.643],
			rot: [0, 0, 0],
			cellOrWorldDesc: "3c:Skyrim.esm"
		},
		
		"Sovngarde": {
			pos: [59033.918, 56824.727, 11652.7791],
			rot: [0, 0, 23.59],
			cellOrWorldDesc: "2ee41:Skyrim.esm"
		}
		
		
	};
	
	
	

	mp.makeEventSource("_vgrAdminMenu", `
	  ctx.sp.printConsole("[VGR admin_menu] event source loaded");

	  ctx.sp.on("browserMessage", (e) => {
			const msg = e.arguments && e.arguments[0];
			if (!msg) return;
			
			
			//ctx.sp.printConsole(String(msg));
			
			if (msg === "vgr:admin_menu:update") {
				const action = e.arguments && e.arguments[1];
				const vgr_payload = e.arguments && e.arguments[2];

				if (
					action === "vgr_teleport_player_to_me" ||
					action === "vgr_teleport_player_to_location"
				) {
					ctx.sp.browser.executeJavaScript('window.skyrimPlatform.sendMessage("vgr:ui:close", "admin_menu")');
				}
				
				ctx.sendEvent({ kind: action, data: vgr_payload });
				
			}
	  });
		
	`);


	mp.makeProperty("vgrTempWeather", {
	  isVisibleByOwner: true,
	  isVisibleByNeighbors: false,
	  updateOwner: `
		if (!ctx.value || !ctx.value.formId) return;
		if (ctx.state.lastWeatherNonce === ctx.value.nonce) return;
		ctx.state.lastWeatherNonce = ctx.value.nonce;

		const weather = ctx.sp.Weather.from(ctx.sp.Game.getFormEx(ctx.value.formId));
		if (weather) {
		  weather.forceActive(true);
		}
	  `,
	  updateNeighbor: "",
	});


	// Server -> admin-browser data channel (revives the dead "vgr-admin-backend"
	// receive path). Nonce-deduped because updateOwner runs every frame.
	mp.makeProperty("vgrAdminData", {
	  isVisibleByOwner: true,
	  isVisibleByNeighbors: false,
	  updateOwner: `
		const value = ctx.value;
		if (!value || !value.nonce) return;
		if (ctx.state.vgrAdminDataNonce === value.nonce) return;
		ctx.state.vgrAdminDataNonce = value.nonce;
		ctx.sp.browser.executeJavaScript("window.vgrAdminData && window.vgrAdminData(" + JSON.stringify({ type: value.type, payload: value.payload }) + ")");
	  `,
	  updateNeighbor: "",
	});

	const vgrPushAdminData = (pcFormId, type, payload) => {
		try {
			mp.set(pcFormId, "vgrAdminData", { nonce: Date.now() + ":" + Math.random(), type: type, payload: payload });
		} catch (e) { console.error(LOG_ADMIN, "admin data push failed:", e); }
	};




// =====================================================
// Generic Gift Item Function for SkyMP
// =====================================================

const notifyAdmin = (pcFormId, message, variant) => {
	if (typeof mp.vgrSendNotification === "function") {
		mp.vgrSendNotification(pcFormId, 2, String(message || ""), { variant: variant || "error" });
	}
};

function parseFormId(value) {
	if (typeof value === "number") return value;

	if (typeof value === "string") {
		return Number(value.startsWith("0x") ? value : "0x" + value);
	}

	return 0;
}

function normalizeAngle(angle) {
	return ((angle % 360) + 360) % 360;
}

// =====================================================
// Generic Gift Item Function - Fixed Type Conversion
// =====================================================
const vgrGiftItem = (targetPcFormId, itemFormId, amount) => {
    try {
        // Validate parameters
        if (!targetPcFormId || !itemFormId) {
            console.error("[GIFT] Invalid parameters: missing target or item FormId");
            return false;
        }
        
        if (typeof amount !== 'number' || amount <= 0) {
            console.error(`[GIFT] Invalid amount: ${amount}`);
            return false;
        }
        
        // CRITICAL FIX: Convert itemFormId to number if it's a hex string
        let normalizedItemId;
        if (typeof itemFormId === 'string') {
            if (itemFormId.startsWith('0x')) {
                normalizedItemId = parseInt(itemFormId, 16);
            } else {
                normalizedItemId = parseInt(itemFormId, 10);
            }
        } else {
            normalizedItemId = itemFormId;
        }
        
        // Validate conversion worked
        if (isNaN(normalizedItemId)) {
            console.error(`[GIFT] Failed to convert itemFormId to number: ${itemFormId}`);
            return false;
        }
        
        const inv = actors.inventory(targetPcFormId);
        if (!actors.setInventory(targetPcFormId, tradeHelpers.addPlainStack(inv, normalizedItemId, amount))) {
            throw new Error("inventory write failed");
        }
        
        return true;
        
    } catch (e) {
        console.error(`[GIFT] Failed to gift item ${itemFormId} to player ${targetPcFormId}:`, e);
        return false;
    }
};


const vgrRemoveItem = (targetPcFormId, itemFormId, amount, notifyPcFormId) => {
    try {
        // Validate parameters
        if (!targetPcFormId || !itemFormId) {
            console.error("[REMOVE] Invalid parameters: missing target or item FormId");
            return false;
        }
        
        if (typeof amount !== 'number' || amount <= 0) {
            console.error(`[REMOVE] Invalid amount: ${amount}`);
            return false;
        }
        
        // Convert itemFormId to number if it's a hex string
        let normalizedItemId;
        if (typeof itemFormId === 'string') {
            if (itemFormId.startsWith('0x')) {
                normalizedItemId = parseInt(itemFormId, 16);
            } else {
                normalizedItemId = parseInt(itemFormId, 10);
            }
        } else {
            normalizedItemId = itemFormId;
        }
        
        // Validate conversion worked
        if (isNaN(normalizedItemId)) {
            console.error(`[REMOVE] Failed to convert itemFormId to number: ${itemFormId}`);
            return false;
        }
        
        const inv = actors.inventory(targetPcFormId);

        const result = tradeHelpers.removePlainStack(inv, normalizedItemId, amount);
        if (!result.ok && result.reason === "not_found") {
            console.warn(`[REMOVE] Item ${normalizedItemId} not found in player's inventory`);
            notifyAdmin(notifyPcFormId || targetPcFormId, `Item not found in player's inventory`, "error");
            return false;
        }

        if (!result.ok && result.reason === "insufficient") {
            console.warn(`[REMOVE] Not enough items. Have: ${result.available}, Requested: ${amount}`);
            notifyAdmin(notifyPcFormId || targetPcFormId, `Not enough items. Player has ${result.available}`, "error");
            return false;
        }

        if (!result.ok) {
            notifyAdmin(notifyPcFormId || targetPcFormId, `Could not remove item`, "error");
            return false;
        }
        
        if (!actors.setInventory(targetPcFormId, result.inventory)) {
            throw new Error("inventory write failed");
        }
        
        return true;
        
    } catch (e) {
        console.error(`[REMOVE] Failed to remove item ${itemFormId} from player ${targetPcFormId}:`, e);
        return false;
    }
};



// =====================================================
// Generic Teleport Player Function
// =====================================================
const vgrTeleportPlayer = (targetPCFormId, position, worldOrCellDesc, rotation) => {
	if (targetPCFormId == null || targetPCFormId === 0) return;
	try {
		mp.set(targetPCFormId, "locationalData", {
			pos: [ position[0], position[1], position[2] + 100], //small offset to prevent clipping
			rot: [ rotation[0], rotation[1], rotation[2] ] || [0.0, 0.0, 0.0],
			cellOrWorldDesc: worldOrCellDesc,
		});
	} catch (e) {
		console.warn("Teleporting player failed for", targetPCFormId, e);
		return false;
	}
};



// =====================================================
// Generic Weather Activation Function
// =====================================================
const vgrSetWeather = (targetPCFormId, targetWeatherFormId) => {
	if (targetPCFormId == null || targetPCFormId === 0) return;
	const weatherFormId = parseFormId(targetWeatherFormId);
	if (weatherFormId == null || weatherFormId == 0) {
		console.log("Could not parse formID for weather ", targetWeatherFormId);
		return;
	}
	
	try {
		mp.set(targetPCFormId, "vgrTempWeather", {
			nonce: Date.now() + ":" + Math.random(),
			formId: weatherFormId,
		});
	} catch (e) {
		console.warn("Teleporting player failed for", targetPCFormId, e);
		return false;
	}
};







mp._vgrAdminMenu = (pcFormId, payload) => {
    if (!pcFormId || pcFormId === 0) {
        console.error(LOG_ADMIN, "Invalid pcFormId");
        return;
    }
	if (!payload) return;
		try {
			const perms = mp.vgrAccessPermissions;
			if (!perms || perms.hasPermission(pcFormId, "vgr.access.manage").allowed !== true) {
				console.log(LOG_ADMIN, "unauthorized admin command from", pcFormId, "(", payload.kind, ")");
				if (typeof mp.vgrSendNotification === "function") {
					mp.vgrSendNotification(pcFormId, "access", "You are not authorized to use admin commands.", { variant: "error" });
				}
				return;
			}
		} catch (e) {
			console.error(LOG_ADMIN, "permission check failed (failing closed):", e);
			return;
		}

		// Case template for handling all admin menu commands
		switch (payload.kind) {
			case "vgr_give_item": {
				// Give item to target player
				const { targetPlayerId, itemId, amount } = payload.data;
				console.log("Giving ", amount, "x ", itemId, " to player ", pcFormId);
				// Your game logic here
				//vgrGiftItem(targetPlayerId, itemId, amount);
				
				vgrGiftItem(pcFormId, itemId, amount);
				// Example: giveItemToPlayer(targetPlayerId, itemId, amount);
				break;
			}
			
			case "vgr_remove_item": {
				// Remove item from target player
				const { targetPlayerId, itemId, amount } = payload.data;
				console.log("Removing ", amount, "x ", itemId, " from player ", pcFormId);
				// Your game logic here
				vgrRemoveItem(pcFormId, itemId, amount, pcFormId);
				
				break;
			}
				
			case "vgr_teleport_player_to_me": {
				// Teleport target player to current player's location
				const { targetPlayerId } = payload.data;
				let pos = null;
				let cellOrWorldDesc = "";
				try {
					pos = actors.position(pcFormId);
					cellOrWorldDesc = actors.cell(pcFormId);
				} catch (e) {
					console.warn("couldnt fetch teleport target from ", pcFormId, e);
					return;
				}
				if (!Array.isArray(pos) || !cellOrWorldDesc) return;
				
				if (targetPlayerId == pcFormId) return; //skip if target player is current player
				console.log("Teleporting player ", targetPlayerId, " to player", pcFormId);
				
				// Teleport
				vgrTeleportPlayer(targetPlayerId, pos, cellOrWorldDesc, [0.0, 0.0, 0.0]);
				
				// Example: teleportPlayerToMe(targetPlayerId);
				break;
			}
				
			case "vgr_teleport_player_to_location": {
				// Teleport target player to predefined location
				const { targetPlayerId, locationName, x, y, z } = payload.data;
				console.log("Teleporting player ", targetPlayerId, " to ", locationName, " (", VGR_Locations[locationName].pos[0], ", ", VGR_Locations[locationName].pos[1], ", ", VGR_Locations[locationName].pos[2], ")");
				
				// Teleport Player to predetermined Location
				if (VGR_Locations[locationName] === null) {
					console.log("Invalid location name ", locationName);
					return; //skip if no entry
				}
				vgrTeleportPlayer(pcFormId, VGR_Locations[locationName].pos, VGR_Locations[locationName].cellOrWorldDesc, VGR_Locations[locationName].rot);
				
				
				// Example: teleportPlayerToLocation(targetPlayerId, x, y, z);
				break;
			}
				
			case "vgr_spawn_npc": {
				// Quick spawn (legacy NPC tab presets): baseId + count only
				const { npcId, count } = payload.data;
				if (typeof mp.vgrNpcSpawn !== "function") {
					console.error(LOG_ADMIN, "vgr_npcs extension not loaded");
					break;
				}
				const n = Math.min(Math.max(parseInt(count, 10) || 1, 1), 10);
				let spawned = 0;
				try {
					const pos = mp.get(pcFormId, "pos");
					const cell = mp.get(pcFormId, "worldOrCellDesc");
					const angle = mp.get(pcFormId, "angle");
					for (let i = 0; i < n; i++) {
						const id = mp.vgrNpcSpawn({
							baseId: npcId,
							cellOrWorldDesc: cell,
							pos: [pos[0] + 96, pos[1] + 96 + i * 64, pos[2]],
							rot: [0, 0, Array.isArray(angle) ? angle[2] : 0],
							respawnMode: "timed", respawnDelaySec: 60, spawnedBy: pcFormId
						});
						if (id) spawned++;
					}
				} catch (e) { console.error(LOG_ADMIN, "spawn failed:", e); }
				notifyAdmin(pcFormId, "Spawned " + spawned + "/" + n + " NPC(s).", spawned ? "success" : "error");
				break;
			}

			case "vgr_npc_spawn": {
				// Full spawner: { baseId, baseName, name, scale, respawnMode,
				//   respawnDelaySec, triggerDistance, despawnSec, count,
				//   inventory:[{baseId,count}], spells:[id], factions:[id] }
				const d = payload.data || {};
				if (typeof mp.vgrNpcSpawn !== "function") { notifyAdmin(pcFormId, "NPC system not loaded.", "error"); break; }
				const n = Math.min(Math.max(parseInt(d.count, 10) || 1, 1), 10);
				let spawned = 0;
				try {
					const pos = mp.get(pcFormId, "pos");
					const cell = mp.get(pcFormId, "worldOrCellDesc");
					const angle = mp.get(pcFormId, "angle");
					for (let i = 0; i < n; i++) {
						const id = mp.vgrNpcSpawn({
							baseId: d.baseId,
							baseName: d.baseName || null,
							cellOrWorldDesc: cell,
							pos: [pos[0] + 128, pos[1] + 128 + i * 80, pos[2]],
							rot: [0, 0, Array.isArray(angle) ? angle[2] : 0],
							name: d.name || null,
							scale: Number(d.scale) || 1,
							respawnMode: d.respawnMode || "timed",
							respawnDelaySec: Number(d.respawnDelaySec) || 60,
							triggerDistance: Number(d.triggerDistance) || 0,
							despawnSec: Number(d.despawnSec) || 0,
							inventory: Array.isArray(d.inventory) ? d.inventory : [],
							spells: Array.isArray(d.spells) ? d.spells : [],
							factions: Array.isArray(d.factions) ? d.factions : [],
							spawnedBy: pcFormId
						});
						if (id) spawned++;
					}
				} catch (e) { console.error(LOG_ADMIN, "full spawn failed:", e); }
				notifyAdmin(pcFormId, "Spawned " + spawned + "/" + n + " — " + (d.name || d.baseName || "NPC"), spawned ? "success" : "error");
				break;
			}

			case "vgr_npc_list": {
				let list = [];
				try { list = (mp.vgrNpcList ? mp.vgrNpcList() : []).map((npc) => ({
					id: npc.idHex,
					name: npc.name || npc.baseName || ("0x" + (npc.baseId || 0).toString(16)),
					baseName: npc.baseName,
					baseId: "0x" + (npc.baseId || 0).toString(16).toUpperCase(),
					respawnMode: npc.respawnMode,
					dead: npc.isDead,
					cell: npc.cell
				})); } catch (e) { console.error(LOG_ADMIN, "npc list failed:", e); }
				vgrPushAdminData(pcFormId, "npc_list", list);
				break;
			}

			case "vgr_npc_delete": {
				const idHex = payload.data && payload.data.id;
				const id = typeof idHex === "string" ? parseInt(idHex, 16) : Number(idHex);
				let ok = false;
				if (id && mp.vgrNpcDelete) { try { ok = mp.vgrNpcDelete(id); } catch (e) { console.error(LOG_ADMIN, "delete failed:", e); } }
				notifyAdmin(pcFormId, ok ? "NPC deleted." : "Delete failed.", ok ? "success" : "error");
				// push refreshed list
				let list = [];
				try { list = (mp.vgrNpcList ? mp.vgrNpcList() : []).map((npc) => ({
					id: npc.idHex, name: npc.name || npc.baseName || ("0x" + (npc.baseId || 0).toString(16)),
					baseName: npc.baseName, baseId: "0x" + (npc.baseId || 0).toString(16).toUpperCase(),
					respawnMode: npc.respawnMode, dead: npc.isDead, cell: npc.cell
				})); } catch (e) { }
				vgrPushAdminData(pcFormId, "npc_list", list);
				break;
			}
				
			case "vgr_set_skill": {
				// Set a specific skill value for target player
				const { targetPlayerId, skillName, value } = payload.data;
				console.log("Setting ", skillName, " to ", value, " for player ", targetPlayerId);
				// Your game logic here
				// Example: setPlayerSkill(targetPlayerId, skillName, value);
				break;
			}
				
			case "vgr_increment_skill": {
				// Increase a skill by increment amount
				const { targetPlayerId, skillName, increment } = payload.data;
				console.log("Increasing ", skillName, " by ", increment, " for player ", targetPlayerId);
				// Your game logic here
				// Example: incrementPlayerSkill(targetPlayerId, skillName, increment);
				break;
			}
				
			case "vgr_add_perk": {
				// Add a perk to target player
				const { targetPlayerId, perkFormId } = payload.data;
				console.log("Adding perk ", perkFormId, " to player ", targetPlayerId);
				// Your game logic here
				// Example: addPerkToPlayer(targetPlayerId, perkFormId);
				break;
			}
				
			case "vgr_remove_perk": {
				// Remove a perk from target player
				const { targetPlayerId, perkFormId } = payload.data;
				console.log("Removing perk ", perkFormId, " from player ", targetPlayerId);
				// Your game logic here
				// Example: removePerkFromPlayer(targetPlayerId, perkFormId);
				break;
			}
				
			case "vgr_delete_all_perks": {
				// Delete all perks from target player
				const { targetPlayerId } = payload.data;
				console.log("Deleting all perks from player ", targetPlayerId);
				// Your game logic here
				// Example: deleteAllPerksFromPlayer(targetPlayerId);
				break;
			}
				
			case "vgr_get_player_perks": {
				// Get all perks for target player and return them
				const { targetPlayerId } = payload.data;
				console.log("Retrieving perks for player ", targetPlayerId);
				// Your game logic here - should return a response
				// Example: const perks = getPlayerPerks(targetPlayerId);
				// Send back to UI using ctx.sp.emitBrowserMessage()
				break;
			}
				
			case "vgr_set_weather": {
				// Set global weather
				const { weatherFormId, weatherName } = payload.data;
				const displayName = weatherName || weatherFormId;
				console.log("Setting weather to ", displayName);
				// Push weatherstate to client
				vgrSetWeather(pcFormId, weatherFormId);
				break;
			}
				
			case "vgr_reset_weather": {
				// Reset weather to region default
				console.log("Resetting weather to default");
				// Your game logic here
				//vgrSetWeather(pcFormId, "0x0000081A");
				vgrSetWeather(pcFormId, "0x0000015E");
				// Example: resetWeatherToDefault();
				break;
			}
				
			default:
				console.log("Unknown command: ", payload.kind, " | ", payload.data);
				break;
		}
}


};
