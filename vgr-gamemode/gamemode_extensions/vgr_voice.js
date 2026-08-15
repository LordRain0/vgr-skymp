// vgr_voice.js — LiveKit voice config injection
// Generates a LiveKit JWT server-side and sends voiceConfig to each player
// after they connect. No external npm packages needed — uses
// Node's built-in crypto module for HS256 JWT signing.
//
// Usage: add to gamemode.js:
//   require(path.join(extensionsDir, 'vgr_voice.js'))(mp);

module.exports = (mp) => {
    const crypto = require('crypto');

    const VOICE = {
        livekitUrl: "wss://vgrwebrtc-ylbvo44t.livekit.cloud",
        apiKey:     "APIpNoZb58JmPkE",
        apiSecret:  "9Ws8b4nPKJSYiBwelKSq2MUnx9Gbat7vlJjxeiibuRk",
        roomName:   "test",
        voiceRange: 4000,
        pttKey:     47,      // V key DX scan code
        tokenTtl:   300      // 5 minutes
    };

    // ── HS256 JWT generation (LiveKit-compatible) ─────────────────────────────

    function b64url(input) {
        const buf = typeof input === 'string' ? Buffer.from(input) : input;
        return buf.toString('base64')
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=/g, '');
    }

    function makeToken(identity) {
        const now = Math.floor(Date.now() / 1000);
        const header  = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
        const payload = b64url(JSON.stringify({
            iss: VOICE.apiKey,
            sub: identity,
            iat: now,
            exp: now + VOICE.tokenTtl,
            video: {
                room:         VOICE.roomName,
                roomJoin:     true,
                canPublish:   true,
                canSubscribe: true,
                roomAdmin:    false,
                roomCreate:   false,
                roomList:     false,
                roomRecord:   false
            }
        }));
        const sig = b64url(
            crypto.createHmac('sha256', VOICE.apiSecret)
                  .update(`${header}.${payload}`)
                  .digest()
        );
        return `${header}.${payload}.${sig}`;
    }

    // ── Send voiceConfig packet to client ─────────────────────────────────────

    function sendVoiceConfig(userId) {
        try {
            if (!userId) {
                console.log('[VoiceSystem] userId is falsy, skipping');
                return;
            }

            const nonce    = crypto.randomBytes(4).toString('hex');
            const identity = `player-${userId}-${nonce}`;
            const token    = makeToken(identity);

            const packet = JSON.stringify({
                customPacketType:     "voiceConfig",
                livekitUrl:           VOICE.livekitUrl,
                token,
                sampleRate:           48000,
                numChannels:          1,
                pttKey:               VOICE.pttKey,
                voiceMode:            0,
                inputGain:            1.0,
                outputVolume:         1.0,
                voiceRange:           VOICE.voiceRange,
                noiseGateEnabled:     false,
                noiseGateThreshold:   0.01,
                normalizationEnabled: false,
                normalizationTarget:  0.1
            });

            mp.sendCustomPacket(userId, packet);
            console.log('[VoiceSystem] sent voiceConfig to userId', userId, '(' + identity + ')');
        } catch(e) {
            console.error('[VoiceSystem] sendVoiceConfig error:', e.message);
        }
    }

    // ── Send voiceConfig 1s after connect to ensure actor is ready ────────────

    mp.on("connect", (userId) => {
        console.log("[VoiceSystem] connect fired, userId: " + userId);
        setTimeout(() => sendVoiceConfig(userId), 1000);
    });

    console.log('[VoiceSystem] Extension loaded');
};