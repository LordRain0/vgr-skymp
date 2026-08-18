module.exports = (mp) => {
  const VGR_EMOTES_UI_VERSION = "1.2";

  mp.makeEventSource("_vgrEmotes", `
    ctx.sp.printConsole("[VGR emotes] event source loaded");
    if (!ctx.state.vgrEmote) {
      ctx.state.vgrEmote = { active: false, animation: null };
    }

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
        const selectedFormId = e.arguments[1];
        const animationString = e.arguments[2];
        const numericFormId = parseInt(String(selectedFormId), 16);

        if (!Number.isFinite(numericFormId)) {
          ctx.sp.printConsole("[VGR emotes] invalid FormID: " + String(selectedFormId));
          return;
        }
        if (!animationString) {
          ctx.sp.printConsole("[VGR emotes] invalid animation for FormID " + String(selectedFormId));
          return;
        }

        const animation = String(animationString);
        ctx.state.vgrEmote.active = true;
        ctx.state.vgrEmote.animation = animation;

        // Skyrim native game calls must run from update context.
        ctx.sp.once("update", () => {
          if (
            !ctx.state.vgrEmote ||
            ctx.state.vgrEmote.active !== true ||
            ctx.state.vgrEmote.animation !== animation
          ) return;

          ctx.sp.Debug.sendAnimationEvent(ctx.sp.Game.getPlayer(), animation);
        });
      }
    });
  `);

};
