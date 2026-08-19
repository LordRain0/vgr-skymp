// VGR LiveKit voice extension.
//
// Usage in gamemode.js:
//   require(path.join(extensionsDir, 'vgr_livekit_voice.js'))(mp);
//
// Reads the "voice" block from server-settings.json, sends LiveKit join tokens
// to clients, broadcasts identity -> actor maps, and feeds positions to the
// voice-agent HTTP API for proximity subscription management.

module.exports = function (mp) {
  const crypto = require("crypto");
  const fs = require("fs");
  const http = require("http");
  const { URL } = require("url");
  const actors = require("./vgr_helpers").playerInteractions.createActorHelpers(mp, {});

  const settings = JSON.parse(fs.readFileSync("server-settings.json", "utf8"));
  const voice = settings.voice;

  if (!voice || !voice.enabled) {
    console.log("[VGR LiveKit] disabled");
    return;
  } else {
    console.log("[VGR LiveKit] enabled");
  }

  const agentPositionUrl = voice.voiceAgentPositionUrl || "http://127.0.0.1:8090/api/position";
  const agentPositionsBatchUrl =
    voice.voiceAgentPositionsBatchUrl ||
    agentPositionUrl.replace(/\/api\/position$/, "/api/positions-batch");
  const agentRequestTimeoutMs = voice.voiceAgentRequestTimeoutMs || 200;
  const positionIntervalMs = voice.positionUpdateIntervalMs || 500;
  const tokenTtlSeconds = voice.tokenTtlSeconds || 300;
  const reconnectCooldownMs = voice.voiceReconnectCooldownMs || 5000;

  // Voice mode cycling: whisper -> talk -> yell, ranges in game units (same units the agent compares against)
  const modeKey = voice.modeKey || 49; // DIK 49 = N
  const pttKeyCode = voice.pttKey || 47; // DIK 47 = V, drives the transmit banner
  const MODE_ORDER = ["whisper", "talk", "yell"];
  const DEFAULT_MODE = "talk";
  const modeRanges = Object.assign({ whisper: 500, talk: 1500, yell: 4500 }, voice.modes || {});

  const sessions = new Map(); // userId -> { identity, actorId }
  const lastIssued = new Map(); // userId -> timestamp
  const pendingActorTimers = new Map(); // userId -> timer
  const voiceModes = new Map(); // userId -> mode name, session only
  let updatingAgentPositions = false;

  function b64url(input) {
    const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
    return buf
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");
  }

  function makeLiveKitToken(identity, actorName) {
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const payload = b64url(JSON.stringify({
      iss: voice.livekitApiKey,
      sub: identity,
      name: actorName || identity,
      iat: now,
      nbf: now,
      exp: now + tokenTtlSeconds,
      video: {
        roomJoin: true,
        room: voice.roomName,
        canPublish: true,
        canSubscribe: true,
		canUpdateOwnMetadata: true,
        roomAdmin: false,
        roomCreate: false,
        roomList: false,
        roomRecord: false
      }
    }));

    const signature = b64url(
      crypto
        .createHmac("sha256", voice.livekitApiSecret)
        .update(`${header}.${payload}`)
        .digest()
    );

    return `${header}.${payload}.${signature}`;
  }

  function postJson(urlString, body, timeoutMs) {
    return new Promise((resolve, reject) => {
      const url = new URL(urlString);
      const data = JSON.stringify(body);
      const req = http.request({
        hostname: url.hostname,
        port: url.port || 80,
        path: `${url.pathname}${url.search}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data)
        }
      }, (res) => {
        res.resume();
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            reject(new Error(`HTTP ${res.statusCode}`));
          }
        });
      });

      req.on("error", reject);
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`timeout after ${timeoutMs}ms`));
      });
      req.write(data);
      req.end();
    });
  }

  function getActorId(userId) {
    return actors.actorFromUser(userId);
  }

  function getActorPosition(actorId) {
    const pos = mp.getActorPos(actorId);
    const worldOrCell = mp.getActorCellOrWorld(actorId);

    if (!Array.isArray(pos) || pos.length < 3) {
      return null;
    }

    return {
      x: Number(pos[0]),
      y: Number(pos[1]),
      z: Number(pos[2]),
      worldOrCell: Number(worldOrCell)
    };
  }

  function getVoiceMode(userId) {
    return voiceModes.get(userId) || DEFAULT_MODE;
  }

  function getVoiceRange(userId) {
    const range = Number(modeRanges[getVoiceMode(userId)]);
    return range > 0 ? range : Number(modeRanges[DEFAULT_MODE]) || 1500;
  }

  // HUD payload channel; nonce-deduped because updateOwner runs every frame
  mp.makeProperty("vgrVoiceMode", {
    isVisibleByOwner: true,
    isVisibleByNeighbors: false,
    updateOwner: `
      const value = ctx.value;
      if (!value || !value.nonce) return;
      if (ctx.state.vgrVoiceModeNonce === value.nonce) return;
      ctx.state.vgrVoiceModeNonce = value.nonce;
      ctx.sp.browser.executeJavaScript("window.vgrVoiceModeUpdate && window.vgrVoiceModeUpdate(" + JSON.stringify({ mode: String(value.mode || "talk"), range: Number(value.range) || 0 }) + ")");
    `,
    updateNeighbor: ""
  });

  function pushModeHud(actorId, mode) {
    try {
      mp.set(actorId, "vgrVoiceMode", {
        nonce: Date.now() + ":" + Math.random(),
        mode,
        range: Number(modeRanges[mode]) || 0
      });
    } catch (e) {
      console.warn(`[VGR LiveKit] pushModeHud failed for actor ${actorId}: ${e.message}`);
    }
  }

  // Injected key listener; cycles the mode server-side so no client rebuild is needed
  mp.makeEventSource("_vgrVoiceModeCycle", `
    ctx.sp.printConsole("[VGR LiveKit] voice mode cycle source loaded");
    if (!ctx.state.vgrVoiceModeCycle) {
      ctx.state.vgrVoiceModeCycle = { keyDown: false };
    }
    // Launcher-written rebinds in skymp5-client-settings.txt win over server defaults
    let vgrVoiceLocal = {};
    try { vgrVoiceLocal = ctx.sp.settings["skymp5-client"] || {}; } catch (e) { }
    const vgrVoiceModeKey = Number(vgrVoiceLocal.voiceModeCycleKeyCode) > 0 ? Number(vgrVoiceLocal.voiceModeCycleKeyCode) : ${modeKey};
    const vgrVoicePttKey = Number(vgrVoiceLocal.voicePushToTalkKeyCode) > 0 ? Number(vgrVoiceLocal.voicePushToTalkKeyCode) : ${pttKeyCode};
    ctx.sp.on("buttonEvent", (e) => {
      if (e.code === vgrVoicePttKey) {
        ctx.sp.browser.executeJavaScript("window.vgrVoiceModeShow && window.vgrVoiceModeShow(" + (e.isPressed ? "true" : "false") + ")");
        return;
      }
      if (e.code !== vgrVoiceModeKey) return;
      if (e.isPressed) {
        if (ctx.state.vgrVoiceModeCycle.keyDown) return;
        ctx.state.vgrVoiceModeCycle.keyDown = true;
        ctx.sendEvent({ kind: "cycleVoiceMode" });
      } else {
        ctx.state.vgrVoiceModeCycle.keyDown = false;
      }
    });
  `);

  mp._vgrVoiceModeCycle = (pcFormId, payload) => {
    if (!payload || payload.kind !== "cycleVoiceMode") return;
    const userId = actors.userFromActor(pcFormId);
    if (userId === null) return;
    const next = MODE_ORDER[(MODE_ORDER.indexOf(getVoiceMode(userId)) + 1) % MODE_ORDER.length];
    voiceModes.set(userId, next);
    pushModeHud(pcFormId, next);
    console.log(`[VGR LiveKit] user ${userId} voice mode -> ${next} (${getVoiceRange(userId)})`);
  };

  async function sendVoiceConfig(userId, forceNewToken = false) {
    const actorId = getActorId(userId);
    if (!actorId) return false;

    const now = Date.now();
    const lastIssueTime = lastIssued.get(userId) || 0;
    if (now - lastIssueTime < reconnectCooldownMs) {
      if (forceNewToken) {
        console.warn(`[VGR LiveKit] rate limiting voice config for user ${userId}`);
      }
      return true;
    }

    try {
      const nonce = crypto.randomBytes(4).toString("hex");
      const identity = `player-${userId}-${nonce}`;
      const actorName = mp.getActorName(actorId);
      const token = makeLiveKitToken(identity, actorName);

      mp.sendCustomPacket(userId, JSON.stringify({
        customPacketType: "voiceConfig",
        livekitUrl: voice.livekitUrl,
        token,
        sampleRate: 48000,
        numChannels: 1,
        pttKey: voice.pttKey || 47,
        voiceMode: 0,
        inputGain: voice.inputGain || 1.0,
        outputVolume: voice.outputVolume || 1.0,
        voiceRange: voice.voiceRange || 4000,
        noiseGateEnabled: voice.noiseGateEnabled ?? false,
        noiseGateThreshold: voice.noiseGateThreshold ?? 0.01,
        normalizationEnabled: voice.normalizationEnabled ?? false,
        normalizationTarget: voice.normalizationTarget ?? 0.1
      }));

      sessions.set(userId, { identity, actorId });
      lastIssued.set(userId, now);

      if (!voiceModes.has(userId)) voiceModes.set(userId, DEFAULT_MODE);
      pushModeHud(actorId, getVoiceMode(userId));

      console.log(`[VGR LiveKit] sent voiceConfig to user ${userId} (${identity})`);
      return true;
    } catch (e) {
      console.error(`[VGR LiveKit] sendVoiceConfig error for user ${userId}: ${e.message}`);
      return false;
    }
  }

  function waitForActorThenSend(userId) {
    clearPendingTimer(userId);

    let attempts = 0;
    const timer = setInterval(async () => {
      attempts++;

      try {
        if (await sendVoiceConfig(userId, true)) {
          clearPendingTimer(userId);
          return;
        }
      } catch (e) {
        clearPendingTimer(userId);
        console.error(`[VGR LiveKit] failed to send voiceConfig to user ${userId}:`, e);
        return;
      }

      if (attempts >= 60) {
        clearPendingTimer(userId);
        console.warn(`[VGR LiveKit] timed out waiting for actor for user ${userId}`);
      }
    }, 500);

    pendingActorTimers.set(userId, timer);
  }

  function clearPendingTimer(userId) {
    const timer = pendingActorTimers.get(userId);
    if (timer) {
      clearInterval(timer);
      pendingActorTimers.delete(userId);
    }
  }

  function broadcastParticipantMap() {
    if (sessions.size === 0) return;

    const participants = {};
    for (const [userId, session] of sessions) {
      const actorId = getActorId(userId);
      if (actorId) {
        session.actorId = actorId;
        participants[session.identity] = actorId;
      }
    }

    const packet = JSON.stringify({
      customPacketType: "voiceParticipantMap",
      participants
    });

    for (const userId of sessions.keys()) {
      try {
        mp.sendCustomPacket(userId, packet);
      } catch (_) {}
    }
  }

  async function updateAgentPositions() {
    if (sessions.size === 0) return;

    const positions = [];

    for (const [userId, session] of sessions) {
      const actorId = getActorId(userId);
      if (!actorId) continue;

      let position;
      try {
        position = getActorPosition(actorId);
      } catch (e) {
        console.warn(`[VGR LiveKit] failed to read position for user ${userId}: ${e.message}`);
        continue;
      }

      if (!position) continue;

      positions.push({
        identity: session.identity,
        x: position.x,
        y: position.y,
        z: position.z,
        worldOrCell: position.worldOrCell,
        range: getVoiceRange(userId)
      });
    }

    if (positions.length === 0) return;

    try {
      await postJson(agentPositionsBatchUrl, { positions }, agentRequestTimeoutMs);
    } catch (e) {
      console.warn(`[VGR LiveKit] voice-agent batch position update failed: ${e.message}`);
    }
  }

  mp.on("connect", (userId) => {
    console.log(`[VGR LiveKit] connect ${userId}`);
    waitForActorThenSend(userId);
  });

  mp.on("disconnect", (userId) => {
    console.log(`[VGR LiveKit] disconnect ${userId}`);
    clearPendingTimer(userId);
    sessions.delete(userId);
    lastIssued.delete(userId);
    voiceModes.delete(userId);
    actors.forgetUser(userId);
  });

  mp.on("customPacket", async (userId, rawContent) => {
    let packet;
    try {
      packet = JSON.parse(rawContent);
    } catch (_) {
      return;
    }

    if (packet.customPacketType === "voiceReconnectRequest") {
      try {
        await sendVoiceConfig(userId, true);
      } catch (e) {
        console.error(`[VGR LiveKit] reconnect request failed for user ${userId}: ${e.message}`);
      }
    }
  });

  setInterval(() => {
    broadcastParticipantMap();

    if (updatingAgentPositions) {
      return;
    }

    updatingAgentPositions = true;
    updateAgentPositions()
      .catch((e) => {
        console.warn(`[VGR LiveKit] updateAgentPositions failed: ${e.message}`);
      })
      .finally(() => {
        updatingAgentPositions = false;
      });
  }, positionIntervalMs);

  console.log(`[VGR LiveKit] loaded: ${voice.livekitUrl}, room=${voice.roomName}, agent=${agentPositionsBatchUrl}, agentTimeout=${agentRequestTimeoutMs}ms`);
  
};
