module.exports = (mp) => {
  const DEBUG_LOG = "[VGR debugview]";
  
  mp.makeEventSource("_vgrDebugViewClientUpdater", `
    const UPDATE_MS = 120;

    const createEmptyState = () => ({
      characterName: null,
      profileId: null,
      actorFormId: null,
      playerRefrId: null,
      raceId: null,
      lastTeleportTarget: null,

      currentAnimationEvent: null,
      previousAnimationEvent: null,
      isDodgingCMF: null,
      DirectionalCycleMoveset: null,
      isBlocking: null,
      isSneaking: null,
      isSprinting: null,
      isInAir: null,
      isWeaponDrawn: null,
      rightHandType: null,
      leftHandType: null,
      isAttacking: null,
      isPowerAttack: null,
      lastAnimationPayload: null,

      pos: null,
      rot: null,
      worldOrCell: null,
      isInterior: null,
      worldspace: null,
      exteriorGrid: null,

      cellFormId: null,
      winningCellPlugin: null,
      xcll: null,
      ltmp: null,
      ltmpInheritanceFlags: null,
      imgs: null,
      clmt: null,
      xclr: null,
      xclm: null,
      xclw: null,
	  effectiveSources: {
        ambient: null,
        fog: null,
        directional: null,
        imageSpace: null,
        climate: null,
        music: null,
        water: null
	  }
    });

    if (!ctx.state.vgrDebugView) {
      ctx.state.vgrDebugView = {  
		shouldUpdate: false,
        lastUpdate: 0,
        debug_state: createEmptyState(),
      };
    }
	
	ctx.state.vgrDebugView.shouldUpdate = false;

    if (!ctx.state.vgrDebugView.debug_state) {
      ctx.state.vgrDebugView.debug_state = createEmptyState();
    }

    const debug_state = ctx.state.vgrDebugView.debug_state;

    const safe = (fn, fallback = null) => {
      try {
        const v = fn();
        return v === undefined ? fallback : v;
      } catch (_) {
        return fallback;
      }
    };
	
	const getProfileId = () => {
	  const authData = safe(() => ctx.sp.storage["authGameData"]);

	  if (authData?.local && typeof authData.local.profileId === "number") {
		return authData.local.profileId;
	  }

	  if (authData?.remote && typeof authData.remote.masterApiId === "number") {
		return authData.remote.masterApiId;
	  }

	  return null;
	};
	
	const getGrid = (x, y) => {
	  if (typeof x !== "number" || typeof y !== "number") return null;

	  return {
		x: Math.floor(x / 4096),
		y: Math.floor(y / 4096),
	  };
	};

    const toHex = (v) => {
      if (typeof v !== "number" || !Number.isFinite(v)) return null;
      return "0x" + Math.trunc(v).toString(16).toUpperCase();
    };

    const formatVec = (values) => {
      return values
        .map((v) => typeof v === "number" ? v.toFixed(2) : "null")
        .join(", ");
    };

    ctx.sp.hooks.sendAnimationEvent.add({
      enter: () => {},
      leave: (animCtx) => {
        if (ctx._expired) return;
        if (animCtx.selfId !== 0x14) return;
        if (!animCtx.animationSucceeded) return;

        debug_state.previousAnimationEvent = debug_state.currentAnimationEvent;
        debug_state.currentAnimationEvent = animCtx.animEventName;
        debug_state.lastAnimationPayload = animCtx.animEventName;
      },
    });

	ctx.sp.on("browserMessage", (e) => {
		const msg = e.arguments && e.arguments[0];
		const ui_name = e.arguments && e.arguments[1];
		
		if (msg !== "vgr:ui:on_open" && msg !== "vgr:ui:on_close" ) return;
		if (ui_name !== "debugview") return;
		
		if (msg === "vgr:ui:on_open") {
			ctx.state.vgrDebugView.shouldUpdate = true;
			return;
		}
		
		if (msg === "vgr:ui:on_close") {
			ctx.state.vgrDebugView.shouldUpdate = false;
			return;
		}
	});
	
	
    ctx.sp.on("update", () => {
      if (ctx._expired) return;
	  if (ctx.state.vgrDebugView.shouldUpdate !== true) return;

      const now = Date.now();
      if (now - ctx.state.vgrDebugView.lastUpdate < UPDATE_MS) return;
      ctx.state.vgrDebugView.lastUpdate = now;

      const player = safe(() => ctx.sp.Game.getPlayer());
      const actor = safe(() => ctx.sp.Actor.from(player));

      if (player) {
		debug_state.profileId = getProfileId();
        debug_state.playerRefrId = toHex(safe(() => player.getFormID()));
        debug_state.actorFormId = toHex(safe(() => ctx.getMyFormIdInServerFormat()));

		const posRaw = [
		  safe(() => player.getPositionX()),
		  safe(() => player.getPositionY()),
		  safe(() => player.getPositionZ()),
		];

		const rotRaw = [
		  safe(() => player.getAngleX()),
		  safe(() => player.getAngleY()),
		  safe(() => player.getAngleZ()),
		];

		debug_state.pos = formatVec(posRaw);
		debug_state.rot = formatVec(rotRaw);

        const parentCell = safe(() => player.getParentCell());
        const worldSpace = safe(() => player.getWorldSpace());
		const cellFormId = parentCell ? safe(() => parentCell.getFormID()) : null;
		const worldspaceId = worldSpace ? safe(() => worldSpace.getFormID()) : null;

		debug_state.cellFormId = toHex(cellFormId);
		debug_state.worldspace = toHex(worldspaceId);
        debug_state.worldOrCell = debug_state.worldspace || debug_state.cellFormId;
        debug_state.isInterior = parentCell ? !worldSpace : null;
		
		const local_grid = getGrid(posRaw[0], posRaw[1]);
		debug_state.exteriorGrid = local_grid ? local_grid.x + ", " + local_grid.y : null;
		
		if (cellFormId) {
		  try {
			const env = ctx.sp.getCellEnvironmentDebugData(cellFormId);
			
			if (env) {
				Object.assign(debug_state, env);
				debug_state.effectiveSources = {
				  ...createEmptyState().effectiveSources,
				  ...(env.effectiveSources || {}),
				};
			}
		  } catch (e) {
			ctx.sp.printConsole("[VGR debugview] env exception | ", String(e));
		  }
		}
		
      }

      if (actor) {
        debug_state.characterName = safe(() => actor.getDisplayName());

        const race = safe(() => actor.getRace());
        debug_state.raceId = race ? toHex(safe(() => race.getFormID())) : null;
		
		const teleportTarget = safe(() => ctx.sp.storage["vgrLastTeleportTarget"]);
		debug_state.lastTeleportTarget = teleportTarget ? "pos: " + teleportTarget.pos + " | worldOrCell: " + toHex(teleportTarget.worldOrCell) : null;

        debug_state.isDodgingCMF = safe(() => actor.getAnimationVariableBool("isDodgingCMF"));
        debug_state.DirectionalCycleMoveset = safe(() => actor.getAnimationVariableInt("DirectionalCycleMoveset"));
        debug_state.isBlocking = safe(() => actor.getAnimationVariableBool("IsBlocking"));
        debug_state.isSneaking = safe(() => actor.isSneaking() || actor.getAnimationVariableBool("IsSneaking"));
        debug_state.isSprinting = safe(() => actor.isSprinting());
        debug_state.isInAir = safe(() => actor.getAnimationVariableBool("bInJumpState"));
        debug_state.isWeaponDrawn = safe(() => actor.isWeaponDrawn());
		debug_state.leftHandType = safe(() => actor.getEquippedItemType(ctx.sp.SlotType.Left));
		debug_state.rightHandType = safe(() => actor.getEquippedItemType(ctx.sp.SlotType.Right));
        debug_state.isAttacking = safe(() => actor.getAnimationVariableBool("IsAttacking"));
        debug_state.isPowerAttack = typeof debug_state.currentAnimationEvent === "string" ? debug_state.currentAnimationEvent.toLowerCase().includes("power") : null;
      }

      ctx.sp.browser.executeJavaScript(
        "window.vgrSetDebugViewState && window.vgrSetDebugViewState(" +
          JSON.stringify(debug_state) +
        ");"
      );
    });

    ctx.sp.printConsole("[VGR debugview] client-only updater started");
  `);

  console.log(DEBUG_LOG, "started");
};
