
if (!ctx.state.vgrUi) {
	ctx.state.vgrUi = { activeUI: null, isFocused: false }; //the nonpersistent active UI in the current context
}


if (!ctx.state.vgrAnim) {
  ctx.state.vgrAnim = {
    lastAnimEvent: null,
    lastAnimTime: 0,
	lastAnimationSucceeded: false
  };
}

const PLAYER_FORM_ID = 0x14;

ctx.sp.hooks.sendAnimationEvent.add({
  enter: () => {},
  leave: (animCtx) => {
    if (animCtx.selfId !== PLAYER_FORM_ID) return;
    if (!animCtx.animationSucceeded) {
		ctx.state.vgrAnim.lastAnimationSucceeded = false;
		return;
	}
	
	ctx.state.vgrAnim.lastAnimationSucceeded = true;
    ctx.state.vgrAnim.lastAnimEvent = animCtx.animEventName;
    ctx.state.vgrAnim.lastAnimTime = Date.now();
  },
});


function sendAnimationEventAndCheck(animEventName, timeoutSeconds = 0.25) {
  return new Promise((resolve) => {
    let hookId = null;
    let finished = false;

    const finish = (success) => {
      if (finished) return;
      finished = true;

      if (hookId !== null) {
        ctx.sp.hooks.sendAnimationEvent.remove(hookId);
        hookId = null;
      }

      resolve(success === true);
    };

    hookId = ctx.sp.hooks.sendAnimationEvent.add(
      {
        enter: () => {},
        leave: (animCtx) => {
          finish(animCtx.animationSucceeded === true);
        },
      },
      PLAYER_FORM_ID,
      PLAYER_FORM_ID,
      animEventName
    );

    ctx.sp.once("update", () => {
      const player = ctx.sp.Game.getPlayer();
      if (!player) {
        finish(false);
        return;
      }

      ctx.sp.Debug.sendAnimationEvent(player, animEventName);

      ctx.sp.Utility.wait(timeoutSeconds).then(() => {
        finish(false);
      });
    });
  });
}



let VGR_UI_REGISTRY = null;
let VGR_SPECIAL_KEYS = null;
let specialKeys = null;

ctx.sp.printConsole("[VGR] UI manager loaded");
ctx.sp.browser.executeJavaScript('window.vgrInitRegistryUI()'); //initializes UI registry

//ctx.sp.printConsole("[VGR] UI: ", VGR_SPECIAL_KEYS);


const nativeMenusToBlock = [
	"BarterMenu",
	"Book Menu",
	"Console",
	"ContainerMenu",
	"Crafting Menu",
	"Dialogue Menu",
	"FavoritesMenu",
	"GiftMenu",
	"InventoryMenu",
	"Journal Menu",
	"Loading Menu",
	"Lockpicking Menu",
	"MagicMenu",
	"MapMenu",
	"RaceSex Menu",
	"Sleep/Wait Menu",
	"StatsMenu",
	"Training Menu",
	"TweenMenu"
];

const isNativeMenuOpen = () => {
	if (ctx.sp.Ui.isTextInputEnabled()) return true;

	for (const menuName of nativeMenusToBlock) {
		try {
			if (ctx.sp.Ui.isMenuOpen(menuName)) return true;
		} catch (_) {}
	}
	
	return false;
};

ctx.state.vgrUi.isNativeMenuOpen = isNativeMenuOpen;



const getUIConfig = (name) => {
	if (!name || !VGR_UI_REGISTRY) return null;
	return VGR_UI_REGISTRY[name] || null;
};



//Returns UI name based on UI Registry by dikCode
const getUINameByDIK = (dikCode) => {
	if (!VGR_UI_REGISTRY) return null;
	
    for (const [uiName, uiConfig] of Object.entries(VGR_UI_REGISTRY)) {
        if (uiConfig.dikCode === dikCode) {
            return uiName;
        }
    }
    return null;
};

//Returns SpecialKeys as array of DIK based on Registry by dikCode to save computing cost
const getSpecialKeys = () => {
	if (!VGR_SPECIAL_KEYS) return [];

	const dikCodes = [];

	for (const specialKeyConfig of Object.values(VGR_SPECIAL_KEYS)) {
		if (!Array.isArray(specialKeyConfig.dikCodes)) continue;

		for (const dikCode of specialKeyConfig.dikCodes) {
			if (!dikCodes.includes(dikCode)) {
				dikCodes.push(dikCode);
			}
		}
	}

	return dikCodes;
};


const openUI = (name, fromServer) => {
	//ctx.sp.printConsole("[VGR] UI manager open UI");
	const config = getUIConfig(name);
	if (!config) return;
	if (config.server_gated === true && fromServer !== true) { //server decides whether this UI may open
		ctx.sendEvent({ kind: "requestOpen", ui: name });
		return;
	}
	const activeConfig = getUIConfig(ctx.state.vgrUi.activeUI);
	if (config.active == true) {//do nothing if same UI is already open other than regaining focus
		if (config.need_focus === true && ctx.state.vgrUi.isFocused === false) {
			ctx.sp.browser.setFocused(true);
			ctx.state.vgrUi.isFocused = true;
		}
		return; 
	}
	if (activeConfig && activeConfig.blocking === true) return; //if the currently active ui is blocking, dont do anything until properly closed
	if (ctx.state.vgrUi.activeUI !== null && config.persistent !== true) { //close other active UI before opening new one if one is already open and nonpersistent
 		ctx.sp.browser.executeJavaScript('window.vgrHideUI("' + ctx.state.vgrUi.activeUI + '")');
		if (activeConfig) activeConfig.active = false;
		ctx.state.vgrUi.activeUI = null;
		//closeUI(ctx.state.vgrUi.activeUI);
	} else {
		if (config.need_focus === true && ctx.state.vgrUi.isFocused === false) { //get focus if there is no active UI element already
			ctx.sp.browser.setFocused(true);
			ctx.state.vgrUi.isFocused = true;
		}
	}

	ctx.sp.browser.executeJavaScript('window.vgrShowUI("' + name + '")');
	
	if (config.persistent !== true) { //only make active UI if nonpersistent
		ctx.state.vgrUi.activeUI = name;
	}
	config.active = true;
};

const closeUI = (name) => {
	//ctx.sp.printConsole("[VGR] UI manager close UI");
	const config = getUIConfig(name);
	if (!config || config.active == false) return; //do nothing if there is no UI to close to begin with
	ctx.sp.browser.executeJavaScript('window.vgrHideUI("' + name + '")');
	
	if (config.need_focus === true && ctx.state.vgrUi.isFocused === true) {
		ctx.sp.browser.setFocused(false);
		ctx.state.vgrUi.isFocused = false;
	}
	
	config.active = false;
	
	if (config.persistent !== true) { //only clear active UI if nonpersistent
		ctx.state.vgrUi.activeUI = null;
	}
};

let keyStates = new Map();

const syncBrowserKeyState = (dikCode, isPressed) => {
	if (ctx.state.vgrUi.activeUI === null && ctx.state.vgrUi.isFocused !== true) return;
	ctx.sp.browser.executeJavaScript('window.browser_keyStates.set(' + dikCode + ', ' + (isPressed ? 'true' : 'false') + ')');
};

const force_closeUI = (name) => {
	const config = getUIConfig(name);
	if (!config) return;
	const isblocking = config.blocking;

	config.blocking = false;
	closeUI(name);
	
	if (config.dikCode && config.interactionType !== 'hold') keyStates.set(config.dikCode, false); //set kDown = false;
	
	config.blocking = isblocking;
};



const isIdleAnimEvent = (animEventName) => {
  if (!animEventName || typeof animEventName !== "string") return false;

  const lower = animEventName.toLowerCase();

  return (
    lower === "motiondrivenidle" ||
    (
      lower.startsWith("idle") &&
      lower !== "idlestop" &&
      lower !== "idleforcedefaultstate"
    )
  );
};


const trimAnimSuffix = (eventName) => {
	const suffixes = [
		// Specific enter states
		"EnterInstant",
		"EnterPlayer",
		"EnterStart",
		"EnterStop",
		"EnterToSit",
	
		// Directional enter states
		"RightEnter",
		"LeftEnter",
		"FrontEnter",
		"BackEnter",
	
		// Specific exit states
		"ExitToStand",
		"ExitStart",
		"QuickExit",
	
		// Directional exit states
		"RightQuickExit",
		"LeftQuickExit",
		"FrontQuickExit",
		"BackQuickExit",
		"RightExit",
		"LeftExit",
		"FrontExit",
		"BackExit",
	
		// Generic states
		"Sitting",
		"Dialogue",
		"FireAndForget",
		"Enter",
		"Exit",
		"Start",
		"Stop",
	];
	
  if (!eventName || typeof eventName !== "string") return null;

  for (const suffix of suffixes) {
    if (eventName.endsWith(suffix)) {
      return eventName.slice(0, -suffix.length);
    }
  }

  return eventName;
};


const ifIdleAnim_ForceDefault = async () => {
	const currentAnimEvent = ctx.state.vgrAnim?.lastAnimEvent;
	
	if (!isIdleAnimEvent(currentAnimEvent)) return; //skip if not idle animationevent
	
	ctx.sp.printConsole("[VGR] UI manager: ", "Animation Event: ", currentAnimEvent);
	
	const base = trimAnimSuffix(currentAnimEvent);
	if (!base) return;
	
	if (await sendAnimationEventAndCheck(base + "ExitStart", 0.15)) return;
	if (await sendAnimationEventAndCheck(base + "Exit", 0.15)) return;
	
	await sendAnimationEventAndCheck("IdleForceDefaultState", 0.15);
};




ctx.sp.on("buttonEvent", (e) => {
	if (!VGR_UI_REGISTRY || !VGR_SPECIAL_KEYS || !Array.isArray(specialKeys)) { //make sure registry is initialized
		if (!VGR_UI_REGISTRY) ctx.sp.printConsole("[VGR] UI manager: ", "VGR_UI_REGISTRY is uninitialized");
		if (!VGR_SPECIAL_KEYS) ctx.sp.printConsole("[VGR] UI manager: ", "VGR_SPECIAL_KEYS is uninitialized");
		if (!Array.isArray(specialKeys)) ctx.sp.printConsole("[VGR] UI manager: ", "SpecialKey Array is uninitialized");
		return;
	}
	if (isNativeMenuOpen()) return; //skip if native UI is open
	const uiName = getUINameByDIK(e.code);
	
	if (uiName === null && !specialKeys.includes(e.code)) return; //skip if UI Key isnt registered

	//ctx.sp.printConsole("[VGR] UI manager: ", "Key is Pressed - ", e.isPressed);
	
	if (e.isPressed) {
		if (keyStates.get(e.code)) return; // ignore repeated press while held
		keyStates.set(e.code, true); //set kDown = true;
		syncBrowserKeyState(e.code, true); //sync browser keyState when the UI can consume it
		
		//ctx.sp.printConsole("[VGR] UI manager: ", "KeyPressed - ", e.code);
		
		if ( VGR_SPECIAL_KEYS["force_ui_close_key"].dikCodes.includes(e.code) ) {
			force_closeUI(ctx.state.vgrUi.activeUI);
			return;
		}
		
		if ( VGR_SPECIAL_KEYS["focus_key"].dikCodes.includes(e.code) ) { //focuskey logic for ingame keypresses
			ctx.sp.browser.setFocused(true);
			ctx.state.vgrUi.isFocused = true;
			return;
		}
		
		if ( VGR_SPECIAL_KEYS["cancel_idle_anim_key"].dikCodes.includes(e.code) ) { //cancle idle animation
			ifIdleAnim_ForceDefault();
			return;
		}
		
		if (uiName === null) return; //sanity skip

		if (VGR_UI_REGISTRY[uiName].active === true) {
			if (VGR_UI_REGISTRY[uiName].interactionType === "press") closeUI(uiName);
		} else {
			openUI(uiName);
		}
		return;
	} else {
		keyStates.set(e.code, false); //set kDown = false;
		syncBrowserKeyState(e.code, false); //sync browser keyState when the UI can consume it
		
		//ctx.sp.printConsole("[VGR] UI manager: ", "KeyReleased - ", e.code);
		
		if (uiName === null) return; //sanity skip
		
		if (VGR_UI_REGISTRY[uiName].interactionType === "hold") closeUI(uiName);
	}
});



ctx.sp.on("browserMessage", (e) => {
	const msg = e.arguments && e.arguments[0];
	
	if (msg === "vgr:ui:init") {
		const UI_REGISTRY = e.arguments && e.arguments[1]; // Get the key data
		const UI_SPECIAL_KEYS = e.arguments && e.arguments[2];
		VGR_UI_REGISTRY = UI_REGISTRY;
		VGR_SPECIAL_KEYS = UI_SPECIAL_KEYS;
		specialKeys = getSpecialKeys();
		//ctx.sp.printConsole("[VGR] UI manager Registry: " + VGR_UI_REGISTRY);
		//ctx.sp.printConsole("[VGR] UI manager Registry Special Keys: " + VGR_SPECIAL_KEYS);
		return;
	} else if (msg === "vgr:ui:open" || msg === "vgr:ui:close") {
		
		const name_ui = e.arguments && e.arguments[1]; // Get the key data
		if (!getUIConfig(name_ui)) return;
		
		if (msg === "vgr:ui:open") {
			openUI(name_ui, true);
			return;
		}
		
		if (msg === "vgr:ui:close") {
			force_closeUI(name_ui);
			return;
		}
		
	} else {
		if (!VGR_UI_REGISTRY || !VGR_SPECIAL_KEYS) return;
	
		const keyData = e.arguments && e.arguments[1]; // Get the key data
		const uiName = getUINameByDIK(keyData);
		
		
		if (msg === "vgr:ui:keydown") {
			
			keyStates.set(keyData, true); //update keyState
			
			if ( VGR_SPECIAL_KEYS["force_ui_close_key"].dikCodes.includes(keyData) ) {
				force_closeUI(ctx.state.vgrUi.activeUI);
				return;
			}
			
			if ( VGR_SPECIAL_KEYS["focus_key"].dikCodes.includes(keyData) ) { //focuskey logic for CEF focus keypresses
				//ctx.sp.browser.executeJavaScript("window.vgrReleaseBrowserInput()");
				ctx.sp.browser.setFocused(false);
				ctx.state.vgrUi.isFocused = false;
				return;
			}
			
			if ( VGR_SPECIAL_KEYS["cancel_idle_anim_key"].dikCodes.includes(keyData) ) { //cancle idle animation
				ifIdleAnim_ForceDefault();
				return;
			}
			
			if (uiName === null ) return; //sanity skip
			
			if (ctx.state.vgrUi.activeUI !== null) {
			
				if (ctx.state.vgrUi.activeUI !== uiName) {  // if key is registered in list and different from active UI- make a clean swap to new UI instead
					if (VGR_UI_REGISTRY[ctx.state.vgrUi.activeUI].blocking === true) return;
/* 					ctx.sp.printConsole("[VGR] UI manager uiName for swap =" + uiName);
					ctx.sp.browser.executeJavaScript('window.vgrHideUI("' + ctx.state.vgrUi.activeUI + '")');
					ctx.sp.browser.executeJavaScript('window.vgrShowUI("' + uiName + '")');
					VGR_UI_REGISTRY[ctx.state.vgrUi.activeUI].active = false;
					ctx.state.vgrUi.activeUI = uiName;
					VGR_UI_REGISTRY[uiName].active = true; */
					
					keyStates.set( VGR_UI_REGISTRY[ctx.state.vgrUi.activeUI].dikCode , false); //set kDown = false;
					
					openUI(uiName);
					
					return;
				} else {
					if (VGR_UI_REGISTRY[ctx.state.vgrUi.activeUI].blocking === true) return;
					if (VGR_UI_REGISTRY[uiName].interactionType !== 'hold') {
						closeUI(uiName);
						//keyStates.set(keyData, false); //set kDown = false;
					}
					return;
				}
			
			} else { //edge case for no active UI
				openUI(uiName);
				return;
			}
		}
		
		if (msg === "vgr:ui:keyup") {
			
			keyStates.set(keyData, false); //set kDown = false;
			
			if (uiName === null ) return; //sanity skip
			
			const activeConfig = getUIConfig(ctx.state.vgrUi.activeUI);
			
			if (!activeConfig) return;	
			if (activeConfig.blocking === true) return;
			if (activeConfig.interactionType !== "hold") return; //skip non-hold UI
			
			if (ctx.state.vgrUi.activeUI !== null && uiName !== null) { //close ui if key gets released
				if (ctx.state.vgrUi.activeUI == uiName) closeUI(uiName);
				return;
			}
			
		}
	
	}
	

});


