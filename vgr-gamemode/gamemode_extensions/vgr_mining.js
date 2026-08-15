module.exports = (mp) => {
	
	// ----- VGR Mining config -----
	const LOG = "[VGR mining]";
	const vgrHelpers = require("./vgr_helpers");
	const tradeHelpers = vgrHelpers.trade;
	const actors = vgrHelpers.playerInteractions.createActorHelpers(mp, {});
	const VGR_MINING_TARGET       = 6;          // ore per session
	const VGR_SECONDS_PER_MINING  = 3;          // 5 * 3 = 15s to fill
	const VGR_IRON_ORE_BASEID   = 0x00071CF3; // Iron Ore base form id
	const VGR_MINING_SEC_TO_COLLECT = VGR_SECONDS_PER_MINING * VGR_MINING_TARGET //amount of seconds to collect
	const DEFAULT_MAX_AMOUNT = 30; //base amount of Iron Ore for a Iron Vein, other ores will scale with it
	
	
	// refill_time = how many minutes it takes for one ore to refill
	// max_amount = how much ore a vein can carry
	//balance these before release for economic value
	const MINING_ORES = {
		"Quicksilver": { itemformId: 0x0005ACE2, refill_time: 30, max_amount: 5 },
		"Moonstone": { itemformId: 0x0005ACE0, refill_time: 30, max_amount: 3 },
		"Malachite": { itemformId: 0x0005ACE1, refill_time: 45, max_amount: 3 },
		"Orichalcum": { itemformId: 0x0005ACDD, refill_time: 5, max_amount: 10 },
		"Corundum": { itemformId: 0x0005ACDB, refill_time: 2, max_amount: 15 },
		"Ebony": { itemformId: 0x0005ACDC, refill_time: 45, max_amount: 1 },
		"Gold": { itemformId: 0x0005ACDE, refill_time: 3, max_amount: 15 },
		"Silver": { itemformId: 0x0005ACDF, refill_time: 2, max_amount: 20 },
		"Iron": { itemformId: 0x00071CF3, refill_time: 1, max_amount: 30 }
	};
	
	const VGR_MINING_UI_VERSION = "1.0.3";
	
	
	// ----- VGR MongoDB config -----
	
	let MongoClient = null;
	try {
	  MongoClient = require("mongodb").MongoClient;
	} catch (e) {
	  console.error(LOG, "MongoDB driver missing. Run npm install mongodb in build/dist/server.");
	}

	let settings = {};
	try {
	  settings = mp.getServerSettings ? mp.getServerSettings() : {};
	} catch (e) {
	  console.error(LOG, "failed to read server settings:", e);
	}

	const miningSettings = settings.vgrMining || {};
	const DB_NAME = miningSettings.databaseName || "vengeful_realms";
	const COLLECTION_NAME = miningSettings.collection || "mining_veins";
	const DISABLE_DEPLETED_VISUAL = !!miningSettings.disableDepletedVeins;
	const MONGO_URI = (() => {
	  if (!settings.databaseUri) return "";
	  try {
		const uri = new URL(settings.databaseUri);
		uri.pathname = "/" + DB_NAME;
		return uri.toString();
	  } catch (e) {
		console.error(LOG, "failed to derive mining Mongo URI from databaseUri:", e);
		return "";
	  }
	})();
	
	let mongoClientPromise = null;
	let mongoIndexPromise = null;
	
	
	function vgrGetMongoClient() {
		if (!MongoClient) {
		  return Promise.reject(new Error("MongoDB driver is not loaded"));
		}
		
		
		if (!mongoClientPromise) {
		  mongoClientPromise = MongoClient.connect(MONGO_URI);
		}
		
		return mongoClientPromise;
	}

	async function vgrGetMiningCollection() {
		const client = await vgrGetMongoClient();
		const collection = client.db(DB_NAME).collection(COLLECTION_NAME);

		if (!mongoIndexPromise) {
		  mongoIndexPromise = collection.createIndex(
			{ mining_vein_formid: 1 },
			{ unique: true }
		  );
		}

		await mongoIndexPromise;

		return collection;
	}
	
	
	
	mp.makeProperty("vgrMiningData", {
		isVisibleByOwner: true,
		isVisibleByNeighbors: false,
		updateOwner: `
			const value = ctx.value;
			  
			const time = (typeof value.time === "number") ? value.time : null;
			
			const veintype = (typeof value.veintype === "string") ? value.veintype : null;
			const vein_formid = (typeof value.vein_formid === "string") ? value.vein_formid : null;
		`,
		updateNeighbor: ""
	});

	mp.makeEventSource("_vgrMining", `
		ctx.sp.printConsole("[VGR mining] event source loaded");
				
		ctx.sp.browser.executeJavaScript(\`
			window.VGR_MINING_TARGET = ${VGR_MINING_TARGET}; // ore per session
			window.VGR_SECONDS_PER_MINING = ${VGR_SECONDS_PER_MINING}; // 5 * 3 = 15s to fill
			console.log("[VGR mining] Config loaded:", {
				MINING_TARGET: window.VGR_MINING_TARGET,
				SECONDS_PER_ORE: window.VGR_SECONDS_PER_MINING,
			});
		\`);
		
		if (!ctx.state.vgrMining) {
			ctx.state.vgrMining = { isPickaxing: false };
		}
		
		function getMiningVeinConfig(target) {
		  if (!target) return null;

		  let base = null;

		  try {
			base = target.getBaseObject();
		  } catch (e) {
			return null;
		  }

		  if (!base) return null;
		  
		  //return if not an Activator
		  if (base.getType() !== ctx.sp.FormType.Activator) {
		    return null;
		  }
			
		  const baseName = String( typeof base.getName === "function" ? base.getName() || "" : "" );
			
		  const displayName = String( typeof target.getDisplayName === "function" ? target.getDisplayName() || "" : "" );

		  const text = (baseName + " " + displayName).toLowerCase();

		  if (text.indexOf("vein") === -1 && text.indexOf("ore") === -1) return null;

		  const oreTypes = [
			"quicksilver",
			"moonstone",
			"malachite",
			"orichalcum",
			"corundum",
			"ebony",
			"gold",
			"silver",
			"iron"
		  ];

		  return oreTypes.find((oreType) => text.indexOf(oreType) !== -1) || null;
		}

		// Activator check
		ctx.sp.on("activate", (e) => {
			const player = ctx.sp.Game.getPlayer();
			if (!player || !e || !e.caster || !e.target) return;
			
			const oreType = getMiningVeinConfig(e.target);
			
			
/* 			ctx.sp.printConsole("[VGR mining] target ref id: " + e.target.getFormID().toString(16));
			const base = e.target.getBaseObject();
			ctx.sp.printConsole("[VGR mining] base id: " + (base ? base.getFormID().toString(16) : "null"));
			ctx.sp.printConsole("[VGR mining] base name: " + (base ? base.getName() : "null"));
			ctx.sp.printConsole("[VGR mining] base type: " + (base ? base.getType() : "null"));
			ctx.sp.printConsole("[VGR mining] display name: " + (typeof e.target.getDisplayName === "function" ? e.target.getDisplayName() : "")); */
			
			if (!oreType) return;
			
			if (
				ctx.state.vgrActivation &&
				typeof ctx.state.vgrActivation.blockIfRestrained === "function" &&
				ctx.state.vgrActivation.blockIfRestrained("You cannot mine while restrained.", "warning")
			) return;

			if (ctx.state.vgrSkillsAllocated && !(Number(ctx.state.vgrSkillsAllocated["mining"]) >= 1)) {
				ctx.sp.printConsole("[VGR mining] blocked: no Miner skill point allocated");
				return;
			}

			ctx.sp.printConsole("[VGR mining] Activator : oreType = ", oreType);
			
			
			ctx.state.vgrMining.activeOreType = oreType;
			
			const targetFormId = ctx.getFormIdInServerFormat(e.target.getFormID());
			
			ctx.state.vgrMining.activeTargetFormId = targetFormId;
			ctx.state.vgrMining.activeOreType = oreType;
			
			
/* 			const anim_numericFormId = parseInt(String("0006142C"), 16);
			
			// Skyrim native game calls must run from update context.
			ctx.sp.once("update", () => {
				const form = ctx.sp.Game.getFormEx(anim_numericFormId);
				const idle = ctx.sp.Idle.from(form);
				
				if (!idle) {
					ctx.sp.printConsole("[VGR mining] FormID is not a valid Idle: " + String(anim_numericFormId));
					return;
				}
				
				ctx.sp.Game.getPlayer().playIdle(idle);
				
				ctx.sp.printConsole("[VGR mining] played idle anim_numericFormId " + String(anim_numericFormId));
			}); */
			
			ctx.sp.once("update", () => {
				ctx.sp.Debug.sendAnimationEvent(ctx.sp.Game.getPlayer(), "IdlePickaxeFloorEnter");
				//ctx.sp.printConsole("[VGR mining] played animationevent " + "-IdlePickaxeFloorEnter-");
			});
			
			ctx.sp.browser.executeJavaScript('window.vgrMiningSet(0, false)');
			ctx.sp.browser.executeJavaScript('window.skyrimPlatform?.sendMessage?.("vgr:ui:open", "mining")');
			ctx.sp.browser.executeJavaScript('window.startMining()');
			
			ctx.sendEvent({
				kind: "start",
				targetFormId: targetFormId,
				oreType: oreType
			});
		});
		
		
		
		ctx.sp.hooks.sendAnimationEvent.add({
			enter: () => { 
				ctx.sp.browser.executeJavaScript('window.skyrimPlatform?.sendMessage?.("vgr:ui:close", "mining")');
				ctx.sp.browser.executeJavaScript('window.vgrMiningSet(0, false)');
			},
			leave: () => {}
		}, 0x14, 0x14, "FurnitureExit");
		
		ctx.sp.on("browserMessage", (e) => {
			const msg = e.arguments && e.arguments[0];
			if (msg === "vgr:mining:collect") {
				ctx.state.vgrMining.isPickaxing = false;
				ctx.sp.printConsole("[VGR mining] collect pressed");
				
				//stop animation
				ctx.sp.once("update", () => {
					ctx.sp.Debug.sendAnimationEvent(ctx.sp.Game.getPlayer(), "IdleForceDefaultState");
				});
				
				
				ctx.sendEvent({ kind: "collect" });
				
				//reset client
				ctx.sp.browser.executeJavaScript('window.skyrimPlatform?.sendMessage?.("vgr:ui:close", "mining")');
				ctx.sp.browser.executeJavaScript('window.vgrMiningSet(0, false)');
			}
		});
		
	`);



	// ----- Server flow -----
	
  
	const vgrMiningSessions = new Map(); // pcFormId -> { timestamp }
	const clamp = (val, min, max) => Math.min(Math.max(val, min), max)
	
	const vgrGrantMiningOre = (pcFormId, ore_Type, amount) => {
		try {
			const inv = actors.inventory(pcFormId);
			if (!actors.setInventory(pcFormId, tradeHelpers.addPlainStack(inv, MINING_ORES[ore_Type].itemformId, amount))) {
				throw new Error("inventory write failed");
			}
		} catch (e) {
			console.error("[VGR mining] grant failed:", e);
		}
	};
	
	const vgrStartMiningSession = (pcFormId, mining_veintype, vein_formid) => {
		//start mining session
		const mining_timestamp = Date.now();
		
		try {
			mp.set(pcFormId, "vgrMiningData", {
				time: mining_timestamp,
				veintype: mining_veintype,
				vein_formid: vein_formid
			});
		} catch (e) {
			console.error("[VGR mining] starting mining session for " + String(pcFormId) + " failed:", e);
		}
	};
	
	function vgrFormatFormId(formId) {
		return Number(formId).toString(16).toUpperCase().padStart(8, "0");
	}


	function vgrFormatOreType(oreType) {
		const input = String(oreType || "").toLowerCase();
		
		// Find matching ore type (case-insensitive)
		const match = Object.keys(MINING_ORES).find(
			key => key.toLowerCase() === input
		);
		
		return match || "";  // Return the capitalized key (e.g., "Iron") not lowercase
	}
	
	
	mp._vgrMining = (pcFormId, payload) => {
		if (!payload) return;
		if (typeof mp.vgrIsActivationBlocked === "function" && mp.vgrIsActivationBlocked(Number(payload.targetFormId) || 0, pcFormId)) {
			return;
		}
		
		if (payload.kind === "start") {
 			const targetFormId = Number(payload.targetFormId);
			const oreType = vgrFormatOreType(payload.oreType);

			if (!targetFormId) {
			  console.log(LOG, "start ignored: missing targetFormId", payload);
			  return;
			}

			if (!oreType) {
			  console.log(LOG, "start ignored: invalid oreType", payload);
			  return;
			}

			// Authoritative skill gate (Mining nodes unlock specific ores)
			if (typeof mp.vgrSkillsCanGather === "function" && !mp.vgrSkillsCanGather(pcFormId, "mining", { oreType: oreType })) {
			  console.log(LOG, "start blocked: ore", oreType, "not unlocked for", pcFormId);
			  if (typeof mp.vgrSkillsNotifyDenied === "function") mp.vgrSkillsNotifyDenied(pcFormId, "mining", { oreType: oreType });
			  return;
			}

			const miningVeinFormId = vgrFormatFormId(targetFormId);
			const now = Date.now();
			
			//console.log(LOG, "Mining Vein FormID: ", miningVeinFormId, " | Ore Type: ", oreType);
			
			
			//Access and validate MongoDB collection
			Promise.resolve().then(async () => {
				const collection = await vgrGetMiningCollection();

				let vein = await collection.findOne({
				  mining_vein_formid: miningVeinFormId
				});
				
				//if vein isnt already there create new entry
				if (!vein) {
					vein = {
						mining_vein_formid: miningVeinFormId,
						ore_type: oreType,
						max_amount: MINING_ORES[oreType].max_amount,
						amount_collected: 0,
						last_collected: now
					};

					await collection.insertOne(vein);

					console.log(
						LOG,
						"created mining vein record",
						miningVeinFormId,
						oreType
					);
				} else {
					//if max_amount doesnt match config overwrite value
					if (Number(vein.max_amount) !== MINING_ORES[oreType].max_amount) {
					  await collection.updateOne(
						{ mining_vein_formid: miningVeinFormId },
						{
						  $set: {
							max_amount: MINING_ORES[oreType].max_amount
						  }
						}
					  );
					  
					  vein.max_amount = MINING_ORES[oreType].max_amount;

					  console.log(LOG, "updated vein max_amount from config", miningVeinFormId);
					}
				}

				console.log(
				  LOG,
				  "started mining",
				  "player=" + pcFormId,
				  "vein=" + miningVeinFormId,
				  "ore=" + vein.ore_type
				);
			}).catch((e) => {
				console.error(LOG, "start payload MongoDB failed:", e);
			});
			
			vgrStartMiningSession(pcFormId, oreType, miningVeinFormId);
			
			return;
		}
		
		if (payload.kind === "collect") {
			const miningData = mp.get(pcFormId, "vgrMiningData") || {};
			const start_time = miningData.time;
			const oreType = miningData.veintype;
			const veinFormId = miningData.vein_formid; //form id of the specific vein
			if (start_time === null || start_time === undefined) return;

			if (typeof mp.vgrSkillsCanGather === "function" && !mp.vgrSkillsCanGather(pcFormId, "mining", { oreType: oreType })) {
			  console.log(LOG, "collect blocked: ore", oreType, "not unlocked for", pcFormId);
			  return;
			}
			const secondsPassed = (Date.now() - start_time) / 1000;
			const reachedTarget = !!(secondsPassed >= VGR_MINING_SEC_TO_COLLECT);
			const timestamp_str = new Date(start_time).toString();
			
			//console.log("[VGR mining] Timestamp: ", timestamp_str );
			//console.log("[VGR mining] Seconds passed: ", secondsPassed );
			
			if (!reachedTarget) {
			  console.log("[VGR mining] collect ignored (not ready) for", pcFormId);
			  return;
			}
			
			//console.log("[VGR mining] Ore Type: ", oreType );
			//console.log("[VGR mining] veinFormID: ", veinFormId );
			
			//Access and validate MongoDB collection
			Promise.resolve().then(async () => {
				const collection = await vgrGetMiningCollection();

				let vein = await collection.findOne({
				  mining_vein_formid: veinFormId
				});
				
				if (!vein) {
					console.log(LOG, "Collect failed, FormID " + String(veinFormId) + " for vein doesnt exist in Database" );
					return;
				}
				
				const max_amount = vein.max_amount;
				const amount_collected = vein.amount_collected;
				const last_collected = vein.last_collected;
				
				const secs_since_last_collect = (Date.now() - last_collected) / 1000;
				const refill_amount = Math.round(secs_since_last_collect / 60 / MINING_ORES[oreType].refill_time); //calculate amount that got replenished based on last_collected timestamp
				const amount_available = clamp(max_amount - amount_collected + refill_amount, 0, max_amount); //calculate available amount
				
				//console.log("[VGR mining] max_amount: ", String(max_amount) );
				//console.log("[VGR mining] amount_collected: ", String(amount_collected) );
				//console.log("[VGR mining] last_collected: ", String(last_collected) );
				
				//console.log("[VGR mining] minutes since last collect: ", String(secs_since_last_collect / 60) );
				//console.log("[VGR mining] refill_amount: ", String(refill_amount) );
				
				const amount_to_collect = clamp(VGR_MINING_TARGET, 0, amount_available);
				const new_amount_collected = clamp(amount_collected - refill_amount + amount_to_collect, 0 , max_amount);
				
				//console.log("[VGR mining] new amount collected = ", new_amount_collected);
				console.log(LOG, "Trying to collect " + String(amount_to_collect) + " " + oreType + " from vein " + String(veinFormId) + " | amount available: " + String(amount_available) );
				
				//if valid collect
				if (amount_to_collect > 0) {
					//grant item
					vgrGrantMiningOre(pcFormId, vein.ore_type, amount_to_collect);

					//skills XP (only after the validated, vein-capped grant)
					if (typeof mp.vgrSkillsOnGather === "function") {
						try { mp.vgrSkillsOnGather(pcFormId, "mining", amount_to_collect, { oreType: vein.ore_type, veinFormId: veinFormId }); }
						catch (e) { console.error(LOG, "skills hook failed:", e); }
					}

					//sync database records
					await collection.updateOne(
						{ mining_vein_formid: veinFormId },
						{
						  $set: {
							amount_collected: new_amount_collected,
							last_collected: Date.now()
						  }
						}
					);
				}
			}).catch((e) => {
				console.error(LOG, "collect payload MongoDB failed:", e);
			});
			
			return;
		}
		
	};
};
