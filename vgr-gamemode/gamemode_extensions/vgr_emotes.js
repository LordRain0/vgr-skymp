module.exports = (mp) => {
  const VGR_EMOTES_UI_VERSION = "1.2";

  mp.makeEventSource("_vgrEmotes", `
    ctx.sp.printConsole("[VGR emotes] event source loaded");

    ctx.sp.on("browserMessage", (e) => {
      const msg = e.arguments && e.arguments[0];
      if (!msg) return;
        
      if (msg === "vgr:emotes:play") {
		if (
			ctx.state.vgrActivation &&
			typeof ctx.state.vgrActivation.blockIfRestrained === "function" &&
			ctx.state.vgrActivation.blockIfRestrained("You cannot use emotes while restrained.", "warning")
		) {
			return;
		}
		const selectedFormId = e.arguments[1]; // Ex: "0003EA32"
		const animationString = e.arguments[2]; // Ex: "IdleWave"
		const numericFormId = parseInt(String(selectedFormId), 16);
		  
		if (!Number.isFinite(numericFormId)) {
			ctx.sp.printConsole("[VGR emotes] invalid FormID: " + String(selectedFormId));
			return;
		}
		  
		ctx.sp.printConsole("Sending emote browsermsg to mp- FormID-" + String(selectedFormId) );
		
		// Skyrim native game calls must run from update context.
		ctx.sp.once("update", () => {
			//const form = ctx.sp.Game.getFormEx(numericFormId);
			//const idle = ctx.sp.Idle.from(form);
			
			if (!animationString) {
				//ctx.sp.printConsole("[VGR emotes] FormID is not a valid Idle: " + String(selectedFormId));
				ctx.sp.printConsole("[VGR emotes] animationString is not valid: ", animationString);
				return;
			}
			
			//ctx.sp.Game.getPlayer().playIdle(idle);
			ctx.sp.Debug.sendAnimationEvent(ctx.sp.Game.getPlayer(), String(animationString));
			
			ctx.sp.printConsole("[VGR emotes] played idle FormID " + String(selectedFormId), " | Animation: ", animationString );
		});
		  
		//ctx.sendEvent({ kind: "play", emoteId: selectedFormId });
			  
		//mp.playAnimation(pcFormId, numericFormId);
	  }
    });
	
  `);

};
