// ==========================================
// VGR UI PERMISSIONS
// ==========================================
// Server-side gate for server_gated UIs: the client's key press sends a
// requestOpen event instead of opening locally, and the UI opens only after
// the permission check passes. Keeps the gate out of gamemode.js so the
// loader stays a plain require list.

module.exports = (mp) => {
  const LOG = "[VGR UI permissions]";

  // UIs whose key press asks the server before opening (server_gated in the registry).
  const VGR_UI_OPEN_PERMISSIONS = {
    admin_menu: "vgr.access.manage",
  };

  const denyLogAt = new Map();

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
        if (now - (denyLogAt.get(pcFormId) || 0) > 60000) {
          denyLogAt.set(pcFormId, now);
          console.log(LOG, "denied", uiName, "for actor", pcFormId);
          mp.vgrSendNotification(pcFormId, 2, "You are not authorized to open this menu.", { variant: "error" });
        }
        return;
      }
    }
    mp.vgrOpenUI(pcFormId, uiName);
  };

  console.log(LOG, "loaded;", Object.keys(VGR_UI_OPEN_PERMISSIONS).length, "gated UI(s)");
};
