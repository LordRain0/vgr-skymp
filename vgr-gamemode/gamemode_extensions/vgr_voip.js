// ── VGR VOIP - Server Extension ──────────────────────────────────────────────
// Handles push-to-talk detection and proximity-based speaker notifications.
// Follows the same property+eventSource pattern as vgr_woodcutting.js.
//
// Usage: add to main gamemode script:
//   require(path.join(extensionsDir, 'vgr_voip.js'))(mp);
//
// Keys:
//   V         (DIK 47) = normal speak  (~1500 units)
//   Caps Lock (DIK 58) = yell          (~4500 units)

module.exports = (mp) => {

    const SPEAK_RANGE = 1500;
    const YELL_RANGE  = 4500;
    const V_KEY       = 47; // V
    const YELL_KEY    = 58; // Caps Lock
    const helpers     = require("./vgr_helpers").playerInteractions;
    const actors      = helpers.createActorHelpers(mp, {});

    // ── Server → Client: speaker notifications via property ──────────────────
    // When a nearby player starts/stops speaking, we push a notification
    // to each listener via mp.set → updateOwner → CEF executeJavaScript.

    mp.makeProperty("vgrVoipNotify", {
        isVisibleByOwner: true,
        isVisibleByNeighbors: false,
        updateOwner: `
            const value = ctx.value;
            if (!value) return;

            if (!ctx.state.vgrVoipNotify) {
                ctx.state.vgrVoipNotify = { lastNonce: null };
            }

            // Deduplicate via nonce
            if (ctx.state.vgrVoipNotify.lastNonce === value.nonce) return;
            ctx.state.vgrVoipNotify.lastNonce = value.nonce;

            ctx.sp.printConsole("[VGR voip] CLIENT received notify isOn=" + value.isOn + " id=" + value.id);

            if (value.isOn) {
                ctx.sp.browser.executeJavaScript(
                    'window.vgrVoipSpeakerOn && window.vgrVoipSpeakerOn(' + JSON.stringify(value.id) + ')'
                );
            } else {
                ctx.sp.browser.executeJavaScript(
                    'window.vgrVoipSpeakerOff && window.vgrVoipSpeakerOff(' + JSON.stringify(value.id) + ')'
                );
            }
        `,
        updateNeighbor: ""
    });

    // Helper: push speaker notification to a listener
    const pushNotify = (listenerId, speakerId, isOn) => {
        try {
            console.log("[VGR voip] SERVER pushNotify -> listener", listenerId, "speaker", speakerId, "isOn", isOn);
            mp.set(listenerId, "vgrVoipNotify", {
                nonce: Date.now() + ":" + Math.random(),
                id: speakerId,
                isOn: isOn
            });
        } catch(e) {
            console.error("[VGR voip] pushNotify failed:", e);
        }
    };

    // ── Client-side PTT handler ───────────────────────────────────────────────

    mp.makeEventSource("_vgrVoip", `
        ctx.sp.printConsole("[VGR voip] loaded");

        if (!ctx.state.vgrVoip) {
            ctx.state.vgrVoip = { speakDown: false, yellDown: false };
        }

        ctx.sp.on("buttonEvent", (e) => {

            // ── V key: normal speak ───────────────────────────────────────────
            if (e.code === ${V_KEY}) {
                if (e.isPressed && !ctx.state.vgrVoip.speakDown) {
                    ctx.state.vgrVoip.speakDown = true;
                    ctx.sp.browser.executeJavaScript(
                        'window.vgrVoipMicOn && window.vgrVoipMicOn("speak")'
                    );
                    ctx.sendEvent({ kind: "voipStart", range: ${SPEAK_RANGE} });
                } else if (!e.isPressed && ctx.state.vgrVoip.speakDown) {
                    ctx.state.vgrVoip.speakDown = false;
                    ctx.sp.browser.executeJavaScript(
                        'window.vgrVoipMicOff && window.vgrVoipMicOff()'
                    );
                    ctx.sendEvent({ kind: "voipStop" });
                }
            }

            // ── Caps Lock: yell ───────────────────────────────────────────────
            if (e.code === ${YELL_KEY}) {
                if (e.isPressed && !ctx.state.vgrVoip.yellDown) {
                    ctx.state.vgrVoip.yellDown = true;
                    ctx.sp.browser.executeJavaScript(
                        'window.vgrVoipMicOn && window.vgrVoipMicOn("yell")'
                    );
                    ctx.sendEvent({ kind: "voipStart", range: ${YELL_RANGE} });
                } else if (!e.isPressed && ctx.state.vgrVoip.yellDown) {
                    ctx.state.vgrVoip.yellDown = false;
                    ctx.sp.browser.executeJavaScript(
                        'window.vgrVoipMicOff && window.vgrVoipMicOff()'
                    );
                    ctx.sendEvent({ kind: "voipStop" });
                }
            }
        });
    `);

    // ── Server-side event handler ─────────────────────────────────────────────
    // Called when client fires ctx.sendEvent(...)

    const speaking = new Map(); // formId → range

    mp._vgrVoip = (formId, payload) => {
        if (!payload) return;

        if (payload.kind === "voipStart") {
            const range = payload.range || SPEAK_RANGE;
            speaking.set(formId, range);
            console.log("[VGR voip] player", formId, "started speaking (range:", range, ")");
            notifyNearby(formId, range, true);
        }

        if (payload.kind === "voipStop") {
            const lastRange = speaking.get(formId) || SPEAK_RANGE;
            speaking.delete(formId);
            console.log("[VGR voip] player", formId, "stopped speaking");
            notifyNearby(formId, lastRange, false);
        }
    };

    // ── Proximity check ───────────────────────────────────────────────────────

    function notifyNearby(speakerId, range, isOn) {
        const speakerPos = actors.position(speakerId);
        const speakerCell = actors.cell(speakerId);

        console.log("[VGR voip] notifyNearby speakerCell=", JSON.stringify(speakerCell), "pos?", !!speakerPos);

        if (!speakerPos || !speakerCell) {
            console.log("[VGR voip] BAILED: missing pos or cell");
            return;
        }

        // Get online players from the global game object (formId 0xff000000)
        // Returns array of online player actor formIds only (no NPCs)
        const onlineActors = actors.onlinePlayers();

        console.log("[VGR voip] onlinePlayers =", JSON.stringify(onlineActors), "isArray?", Array.isArray(onlineActors));

        if (!Array.isArray(onlineActors)) {
            console.log("[VGR voip] BAILED: onlinePlayers not an array");
            return;
        }

        onlineActors.forEach(otherId => {
            // TEMP SELF-TEST: do NOT skip the speaker, so a solo player can
            // verify the push pipeline. Re-enable the skip after testing.
            // if (otherId === speakerId) return;

            try {
                const otherCell = actors.cell(otherId);
                console.log("[VGR voip] check otherId", otherId, "cell", JSON.stringify(otherCell), "vs speakerCell", JSON.stringify(speakerCell));

                // Must be in same world/cell
                if (otherCell !== speakerCell) {
                    console.log("[VGR voip] skip: cell mismatch");
                    return;
                }

                const otherPos = actors.position(otherId);
                if (!otherPos) {
                    console.log("[VGR voip] skip: no pos");
                    return;
                }

                const dist = helpers.distance3(speakerPos, otherPos);
                console.log("[VGR voip] dist", dist, "range", range);
                if (dist <= range) {
                    pushNotify(otherId, speakerId, isOn);
                }
            } catch(e) {
                console.error("[VGR voip] forEach error:", e);
                // Skip actors that error (NPCs, unloaded, etc.)
            }
        });
    }

    // ── Cleanup on disconnect ─────────────────────────────────────────────────

    mp.on("disconnect", (userId) => {
        try {
            const formId = actors.actorFromUser(userId);
            if (!formId) return;
            if (speaking.has(formId)) {
                const lastRange = speaking.get(formId);
                speaking.delete(formId);
                notifyNearby(formId, lastRange, false);
            }
        } finally {
            actors.forgetUser(userId);
        }
    });

};
