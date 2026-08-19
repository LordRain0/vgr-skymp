// ==========================================
// VENGEFUL REALMS (VGR) EXTENSIONS
// ==========================================
const fs = require('fs');

const path = require('path');
const extensionsDir = path.join(process.cwd(), 'gamemode_extensions');
const vgrHelpers = require(path.join(extensionsDir, 'vgr_helpers.js'));
const vgrActors = vgrHelpers.playerInteractions.createActorHelpers(mp, {});

function vgrSendUiManagerPacket(pcFormId, action, uiName) {
  if (pcFormId == null || pcFormId === 0) return;
  const name = String(uiName || "").trim();
  if (!name) return;

  let userId = null;
  try {
    userId = vgrActors.userFromActor(pcFormId);
  } catch (e) {
    console.warn("[VGR UI manager] failed to resolve actor user:", e && e.message ? e.message : e);
    return;
  }
  if (userId == null) return;

  try {
    mp.sendCustomPacket(userId, JSON.stringify({
      customPacketType: "vgrUiManager",
      action: action === "close" ? "close" : "open",
      ui: name,
    }));
  } catch (e) {
    console.warn("[VGR UI manager] failed to send UI packet:", name, e && e.message ? e.message : e);
  }
}

mp.vgrOpenUI = (pcFormId, uiName) => {
  vgrSendUiManagerPacket(pcFormId, "open", uiName);
};

mp.vgrCloseUI = (pcFormId, uiName) => {
  vgrSendUiManagerPacket(pcFormId, "close", uiName);
};

// UIs whose key press asks the server before opening (server_gated in the registry).
const VGR_UI_OPEN_PERMISSIONS = {
  admin_menu: "vgr.access.manage",
};

const vgrUiDenyLogAt = new Map();

mp._vgrUiManager = (pcFormId, payload) => {
  if (!payload || payload.kind !== "requestOpen") return;
  const uiName = String(payload.ui || "").trim();
  if (!uiName) return;

  const required = VGR_UI_OPEN_PERMISSIONS[uiName];
  if (required) {
    const perms = mp.vgrAccessPermissions;
    if (!perms || perms.hasPermission(pcFormId, required).allowed !== true) {
      // Players mash the key; log and notify at most once a minute per actor
      const now = Date.now();
      if (now - (vgrUiDenyLogAt.get(pcFormId) || 0) > 60000) {
        vgrUiDenyLogAt.set(pcFormId, now);
        console.log("[VGR UI manager] denied", uiName, "for actor", pcFormId);
        mp.vgrSendNotification(pcFormId, 2, "You are not authorized to open this menu.", { variant: "error" });
      }
      return;
    }
  }
  mp.vgrOpenUI(pcFormId, uiName);
};

mp.vgrSendNotification = (pcFormId, type, message, options) => {
  if (pcFormId == null || pcFormId === 0) return;
  let userId = null;
  try {
    userId = vgrActors.userFromActor(pcFormId);
  } catch (e) {
    console.warn("[VGR notification] failed to resolve actor user:", e && e.message ? e.message : e);
    return;
  }
  if (userId == null) return;

  try {
    mp.sendCustomPacket(userId, JSON.stringify({
      customPacketType: "vgrNotification",
      type: Number(type) === 1 ? 1 : 2,
      message: String(message || ""),
      options: options && typeof options === "object" ? options : {},
    }));
  } catch (e) {
    console.warn("[VGR notification] failed to send notification packet:", e && e.message ? e.message : e);
  }
};

//require(path.join(extensionsDir, 'vgr_ui_manager.js'))(mp);
//require(path.join(extensionsDir, 'vgr_voip.js'))(mp);
//require(path.join(extensionsDir, 'vgr_voice.js'))(mp);



require(path.join(extensionsDir, 'vgr_activation_service.js'))(mp);
require(path.join(extensionsDir, 'vgr_npcs.js'))(mp);
require(path.join(extensionsDir, 'vgr_skills.js'))(mp);
require(path.join(extensionsDir, 'vgr_alchemy.js'))(mp);
require(path.join(extensionsDir, 'vgr_enchanting.js'))(mp);
require(path.join(extensionsDir, 'vgr_woodcutting.js'))(mp);
require(path.join(extensionsDir, 'vgr_mining.js'))(mp);
require(path.join(extensionsDir, 'vgr_emotes.js'))(mp);
require(path.join(extensionsDir, 'vgr_social.js'))(mp);
require(path.join(extensionsDir, 'vgr_transform_race.js'))(mp);




require(path.join(extensionsDir, 'vgr_livekit_voice.js'))(mp);
require(path.join(extensionsDir, 'vgr_trading.js'))(mp);
require(path.join(extensionsDir, 'vgr_admin_menu.js'))(mp);
require(path.join(extensionsDir, 'vgr_debug_view.js'))(mp);
require(path.join(extensionsDir, 'vgr_access_control.js'))(mp);
require(path.join(extensionsDir, 'vgr_nameplates.js'))(mp);
require(path.join(extensionsDir, 'vgr_player_interactions.js'))(mp);
require(path.join(extensionsDir, 'vgr_respawn.js'))(mp);
require(path.join(extensionsDir, 'vgr_actor_hygiene.js'))(mp);
require(path.join(extensionsDir, 'vgr_restoration.js'))(mp);


//require(path.join(extensionsDir, 'vgr_time.js'))(mp);
require(path.join(extensionsDir, 'vgr_weather.js'))(mp);


// ========== VGR UI MANAGER ==========


// Read the file content as string
const uiManagerContent = fs.readFileSync(path.join(extensionsDir, 'vgr_ui_manager.js'), 'utf8');

mp.makeEventSource("_vgrUiManager", uiManagerContent);








































mp.makeProperty("vgrPerks", {
  isVisibleByOwner: true,
  isVisibleByNeighbors: false,

  updateOwner: `
    const player = ctx.sp.Game.getPlayer();
    if (!player) return;

    const perks = Array.isArray(ctx.value) ? ctx.value : [];

    for (const perkId of perks) {
      const perk = ctx.sp.Perk.from(ctx.sp.Game.getFormEx(perkId));
      if (perk && !player.hasPerk(perk)) {
        player.addPerk(perk);
      }
    }
  `,

  updateNeighbor: ""
});

mp.makeProperty("vgrSkillLevel", {
  isVisibleByOwner: true,
  isVisibleByNeighbors: false,

  updateOwner: `
    const player = ctx.sp.Game.getPlayer();
    if (!player) return;

    const skills = Array.isArray(ctx.value) ? ctx.value : [];

    for (const skill of skills) {
      if (!skill || typeof skill.skillName !== "string") continue;
      if (typeof skill.level !== "number") continue;

      player.setActorValue(skill.skillName, skill.level);
    }
  `,

  updateNeighbor: ""
});






