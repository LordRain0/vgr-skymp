module.exports = (mp) => {
	
	// ----- VGR Woodcutting config -----
	const vgrHelpers = require("./vgr_helpers");
	const tradeHelpers = vgrHelpers.trade;
	const actors = vgrHelpers.playerInteractions.createActorHelpers(mp, {});
	const VGR_WOOD_TARGET       = 6;          // firewood per session
	const VGR_SECONDS_PER_WOOD  = 3;          // 5 * 3 = 15s to fill
	const VGR_FIREWOOD_BASEID   = 0x0006F993; // Firewood base form id
	const VGR_SEC_TO_COLLECT = VGR_SECONDS_PER_WOOD * VGR_WOOD_TARGET //amount of seconds to collect
	
	const VGR_WOODCUTTING_UI_VERSION = "1.0.2";

	mp.makeProperty("vgrWoodcuttingData", {
		isVisibleByOwner: true,
		isVisibleByNeighbors: false,
		updateOwner: `
			const value = ctx.value;
			  
			const time = (typeof value.time === "number") ? value.time : null;
		`,
		updateNeighbor: ""
	});

	mp.makeEventSource("_vgrWoodcutting", `
		ctx.sp.printConsole("[VGR woodcutting] event source loaded");
				
		ctx.sp.browser.executeJavaScript(\`
			window.VGR_WOOD_TARGET = ${VGR_WOOD_TARGET}; // firewood per session
			window.VGR_SECONDS_PER_WOOD = ${VGR_SECONDS_PER_WOOD}; // 5 * 3 = 15s to fill
			console.log("[VGR woodcutting] Config loaded:", {
				WOOD_TARGET: window.VGR_WOOD_TARGET,
				SECONDS_PER_WOOD: window.VGR_SECONDS_PER_WOOD,
			});
		\`);
		
		if (!ctx.state.vgrWoodcutting) {
			ctx.state.vgrWoodcutting = { isChopping: false };
		}
		
		ctx.sp.hooks.sendAnimationEvent.add({
			enter: (animCtx) => {
				if (ctx.state.vgrWoodcutting.isChopping) return;
				if (
					ctx.state.vgrActivation &&
					typeof ctx.state.vgrActivation.blockAnimationIfRestrained === "function" &&
					ctx.state.vgrActivation.blockAnimationIfRestrained(animCtx, "You cannot chop wood while restrained.", "warning")
				) return;
				ctx.state.vgrWoodcutting.isChopping = true;
				
				ctx.sp.browser.executeJavaScript('window.vgrWoodcuttingSet(0, false)');
				ctx.sp.browser.executeJavaScript('window.skyrimPlatform?.sendMessage?.("vgr:ui:open", "woodcutting")');
				ctx.sendEvent({ kind: "start" });
				ctx.sp.browser.executeJavaScript('window.startWoodcutting()');
			},
			leave: () => {}
		}, 0x14, 0x14, "IdleWoodChopStart");
		
		ctx.sp.hooks.sendAnimationEvent.add({
			enter: () => { 
				ctx.sp.browser.executeJavaScript('window.skyrimPlatform?.sendMessage?.("vgr:ui:close", "woodcutting")');
				ctx.sp.browser.executeJavaScript('window.vgrWoodcuttingSet(0, false)');
			},
			leave: () => {}
		}, 0x14, 0x14, "FurnitureExit");
		
		ctx.sp.on("browserMessage", (e) => {
			const msg = e.arguments && e.arguments[0];
			if (msg === "vgr:woodcutting:collect") {
				ctx.state.vgrWoodcutting.isChopping = false;
				ctx.sp.printConsole("[VGR woodcutting] collect pressed");
				
				ctx.sendEvent({ kind: "collect" });
				//reset client
				
				//stop animation
				ctx.sp.once("update", () => {
					ctx.sp.Debug.sendAnimationEvent(ctx.sp.Game.getPlayer(), "IdleForceDefaultState");
				})
				
				ctx.sp.browser.executeJavaScript('window.skyrimPlatform?.sendMessage?.("vgr:ui:close", "woodcutting")');
				ctx.sp.browser.executeJavaScript('window.vgrWoodcuttingSet(0, false)');
			}
		});
		
	`);


	const vgrWoodSessions = new Map(); // pcFormId -> { timestamp }

	const vgrStopSession = (pcFormId) => {
	  vgrWoodSessions.delete(pcFormId);
	};

	const vgrGrantFirewood = (pcFormId, amount) => {
		try {
			const inv = actors.inventory(pcFormId);
			if (!actors.setInventory(pcFormId, tradeHelpers.addPlainStack(inv, VGR_FIREWOOD_BASEID, amount))) {
				throw new Error("inventory write failed");
			}
		} catch (e) {
			console.error("[VGR woodcutting] grant failed:", e);
		}
	};

	mp._vgrWoodcutting = (pcFormId, payload) => {
		if (!payload) return;
		if (typeof mp.vgrIsActivationBlocked === "function" && mp.vgrIsActivationBlocked(0, pcFormId)) {
			return;
		}
		
		if (payload.kind === "start") {
			vgrStopSession(pcFormId);              // clear any stale session
			
			//start woodcutting session
			const woodcutting_timestamp = Date.now();
			vgrWoodSessions.set(pcFormId, woodcutting_timestamp); //save current timestamp of session
			
			try {
				mp.set(pcFormId, "vgrWoodcuttingData", {
					time: woodcutting_timestamp
				});
			} catch (e) {
				console.error("[VGR woodcutting] setting timestamp in database failed:", e);
			}
			
			return;
		}
		
		if (payload.kind === "collect") {
			const start_time = vgrWoodSessions.get(pcFormId);
			//const start_time_two = mp.get(pcFormId, "vgrWoodcuttingData").time;
			if (start_time === null) return;
			const secondsPassed = (Date.now() - start_time) / 1000;
			const reachedTarget = !!(secondsPassed >= VGR_SEC_TO_COLLECT);
			const timestamp_str = new Date(start_time).toString();
			
			console.log("[VGR woodcutting] Timestamp: ", timestamp_str );
			console.log("[VGR woodcutting] Seconds passed: ", secondsPassed );
			
			vgrStopSession(pcFormId);
			
			if (reachedTarget) {
			  vgrGrantFirewood(pcFormId, VGR_WOOD_TARGET);
			  console.log("[VGR woodcutting] granted", VGR_WOOD_TARGET, "firewood to", pcFormId);

			  //skills XP (harvest itself is ungated per the proposal's user journey)
			  if (typeof mp.vgrSkillsOnGather === "function") {
				try { mp.vgrSkillsOnGather(pcFormId, "woodcutting", VGR_WOOD_TARGET, {}); }
				catch (e) { console.error("[VGR woodcutting] skills hook failed:", e); }
			  }
			} else {
			  console.log("[VGR woodcutting] collect ignored (not ready) for", pcFormId);
			}
			
			return;
		}
		
	};
};
