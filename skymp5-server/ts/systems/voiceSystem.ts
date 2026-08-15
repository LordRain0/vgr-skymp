// Voice chat system — generates LiveKit tokens and sends voice config
// to clients after their actor is loaded into the world.
//
// Integration with SkyMP reconnection:
//   - On game `connect`: starts polling for the player's actor (created async
//     by Spawn after Login emits `spawnAllowed`). Sends voiceConfig once ready.
//   - On game `disconnect`: cleans up session tracking. Does NOT tell the
//     client to shutdown voice — the game client already handles that via
//     the `connectionDisconnect` event.
//   - On `voiceReconnectRequest` customPacket: generates a fresh JWT if the
//     player's actor still exists (for voice-only disconnects where the game
//     connection is still alive).
//
// Security model:
//   - Tokens are JWTs signed with HMAC-SHA256 (livekitApiSecret)
//   - Each token has a short TTL (default 5 minutes)
//   - Identity is per-userId + a random nonce (prevents reuse across sessions)
//   - Token is only sent AFTER the player's actor exists in the world
//   - Room access is scoped to a single room name
//   - canPublish/canSubscribe are explicitly granted (no admin rights)

import { AccessToken } from "livekit-server-sdk";
import * as crypto from "crypto";
import { System, Content, SystemContext } from "./system";
import { Settings } from "../settings";

interface VoiceSettings {
  enabled: boolean;
  livekitUrl: string;          // e.g. "wss://voice.eruvos.com:7880"
  livekitApiKey: string;
  livekitApiSecret: string;
  roomName: string;            // e.g. "eruvos-voice"
  voiceRange?: number;         // game units
  pttKey?: number;             // keycode for push-to-talk
  inputGain?: number;
  outputVolume?: number;
  noiseGateEnabled?: boolean;       // enable noise gate (default false)
  noiseGateThreshold?: number;      // RMS threshold 0-1 (default 0.01)
  normalizationEnabled?: boolean;   // enable volume normalization / AGC (default false)
  normalizationTarget?: number;     // target RMS 0-1 (default 0.1)
  tokenTtlSeconds?: number;    // token lifetime (default 300 = 5 min)
  positionUpdateIntervalMs?: number; // how often to publish positions (default 500)
}

export class VoiceSystem implements System {
  systemName = "VoiceSystem";

  private settings: VoiceSettings | null = null;
  private tokenTtl = 300;

  // Track active voice sessions to prevent duplicate token issuance
  private activeVoiceSessions = new Map<number, string>(); // userId -> identity
  // Rate limit token issuance per user
  private lastTokenIssueTime = new Map<number, number>(); // userId -> timestamp
  // Users waiting for their actor to be assigned (polling)
  private pendingUsers = new Map<number, ReturnType<typeof setInterval>>(); // userId -> poll timer
  private positionUpdateIntervalMs = 500;
  private lastPositionUpdateTime = 0;

  async initAsync(ctx: SystemContext): Promise<void> {
    const settingsObject = await Settings.get();
    const allSettings = settingsObject.allSettings;
    this.settings = allSettings?.["voice"] as VoiceSettings | undefined ?? null;

    if (!this.settings || !this.settings.enabled) {
      console.log("[VoiceSystem] Voice chat disabled in settings");
      this.settings = null;
      return;
    }

    this.tokenTtl = this.settings.tokenTtlSeconds || 300;
    this.positionUpdateIntervalMs = this.settings.positionUpdateIntervalMs || 500;
    console.log(`[VoiceSystem] Voice chat enabled (LiveKit: ${this.settings.livekitUrl}, TTL: ${this.tokenTtl}s)`);
  }

  // Called on SLikeNet connect — the actor does NOT exist yet.
  // We start polling for the actor since Spawn creates it asynchronously
  // after Login authenticates the user and emits `spawnAllowed`.
  connect(userId: number, ctx: SystemContext): void {
    if (!this.settings) return;

    // Cancel any existing poll for this user (e.g. rapid reconnect)
    this.clearPendingUser(userId);

    // Poll every 500ms for up to 30s waiting for the actor to be assigned
    let attempts = 0;
    const maxAttempts = 60; // 30 seconds

    const timer = setInterval(() => {
      attempts++;

      const actorId = ctx.svr.getUserActor(userId);
      if (actorId && actorId !== 0) {
        // Actor is ready — send voice config
        this.clearPendingUser(userId);
        this.sendVoiceConfig(userId, actorId, ctx);
        return;
      }

      if (attempts >= maxAttempts) {
        // Give up — user might have disconnected during auth
        this.clearPendingUser(userId);
        console.warn(`[VoiceSystem] Timed out waiting for actor for user ${userId}`);
      }
    }, 500);

    this.pendingUsers.set(userId, timer);
  }

  disconnect(userId: number, _ctx: SystemContext): void {
    if (!this.settings) return;

    // Cancel pending poll if user disconnects before actor was ready
    this.clearPendingUser(userId);

    // Clean up session tracking
    const identity = this.activeVoiceSessions.get(userId);
    if (identity) {
      this.activeVoiceSessions.delete(userId);
      this.lastTokenIssueTime.delete(userId);
      console.log(`[VoiceSystem] Cleaned up voice session for user ${userId} (${identity})`);
    }
    // Note: we do NOT send a shutdown command to the client here.
    // The client's VoiceChatService listens for `connectionDisconnect`
    // and calls shutdownVoice() itself. This keeps voice lifecycle
    // aligned with the game connection lifecycle.
  }

  // Broadcast voice participant map to clients
  async updateAsync(ctx: SystemContext): Promise<void> {
    if (!this.settings) return;
    if (this.activeVoiceSessions.size === 0) return;

    const now = Date.now();
    if (now - this.lastPositionUpdateTime < this.positionUpdateIntervalMs) return;
    this.lastPositionUpdateTime = now;

    // Build identity → actorRefrId map for all active voice sessions
    const participantMap: Record<string, number> = {};
    for (const [userId, identity] of this.activeVoiceSessions) {
      try {
        const actorId = ctx.svr.getUserActor(userId);
        if (!actorId || actorId === 0) continue;

        participantMap[identity] = actorId;
      } catch (e) {
        console.error(`[VoiceSystem] updateAsync error for user ${userId}:`, e);
      }
    }

    // Broadcast the participant map to all connected voice users
    // so each client can map identities to in-game actors for spatial audio
    const mapPacket = JSON.stringify({
      customPacketType: "voiceParticipantMap",
      participants: participantMap,
    });
    for (const [userId] of this.activeVoiceSessions) {
      try {
        ctx.svr.sendCustomPacket(userId, mapPacket);
      } catch (_) { /* user may have disconnected */ }
    }
  }

  // Handle custom packets from clients
  customPacket(userId: number, type: string, content: Content, ctx: SystemContext): void {
    if (!this.settings) return;

    if (type === "voiceReconnectRequest") {
      this.handleReconnectRequest(userId, ctx);
    }
  }

  // Voice-only reconnect: the game connection is alive but the LiveKit
  // connection was lost. Generate a fresh JWT and send it.
  private async handleReconnectRequest(userId: number, ctx: SystemContext): Promise<void> {
    const actorId = ctx.svr.getUserActor(userId);
    if (!actorId || actorId === 0) {
      console.warn(`[VoiceSystem] Reconnect request from user ${userId} but no actor exists`);
      return;
    }

    // Rate limit: minimum 5 seconds between token issues per user
    const lastIssue = this.lastTokenIssueTime.get(userId) || 0;
    const now = Date.now();
    if (now - lastIssue < 5000) {
      console.warn(`[VoiceSystem] Rate limiting voice reconnect for user ${userId}`);
      return;
    }

    console.log(`[VoiceSystem] Voice reconnect request from user ${userId}`);
    this.sendVoiceConfig(userId, actorId, ctx);
  }

  private async sendVoiceConfig(userId: number, actorId: number, ctx: SystemContext): Promise<void> {
    if (!this.settings) return;

    try {
      // Generate a unique identity with a random nonce
      const nonce = crypto.randomBytes(4).toString("hex");
      const identity = `player-${userId}-${nonce}`;

      // Track session
      const prevIdentity = this.activeVoiceSessions.get(userId);
      if (prevIdentity) {
        console.log(`[VoiceSystem] Replacing voice session for user ${userId} (was ${prevIdentity})`);
      }
      this.activeVoiceSessions.set(userId, identity);
      this.lastTokenIssueTime.set(userId, Date.now());

      // Generate LiveKit access token with short TTL
      const token = new AccessToken(
        this.settings.livekitApiKey,
        this.settings.livekitApiSecret,
        {
          identity,
          name: ctx.svr.getActorName(actorId),
          ttl: this.tokenTtl,
        }
      );

      token.addGrant({
        roomJoin: true,
        room: this.settings.roomName,
        canPublish: true,
        canSubscribe: true,
        // Explicitly deny admin capabilities
        roomAdmin: false,
        roomCreate: false,
        roomList: false,
        roomRecord: false,
      });

      const jwt = await token.toJwt();

      // Send voice config to client via CustomPacket
      // Uses customPacketType field to match the server's customPacket dispatch
      const voiceConfig = {
        customPacketType: "voiceConfig",
        livekitUrl: this.settings.livekitUrl,
        token: jwt,
        sampleRate: 48000,
        numChannels: 1,
        pttKey: this.settings.pttKey || 47, // V key (DxScanCode 47, not Windows VK 0x56)
        voiceMode: 0, // proximity
        inputGain: this.settings.inputGain || 1.0,
        outputVolume: this.settings.outputVolume || 1.0,
        voiceRange: this.settings.voiceRange || 4000,
        noiseGateEnabled: this.settings.noiseGateEnabled ?? false,
        noiseGateThreshold: this.settings.noiseGateThreshold ?? 0.01,
        normalizationEnabled: this.settings.normalizationEnabled ?? false,
        normalizationTarget: this.settings.normalizationTarget ?? 0.1,
      };

      ctx.svr.sendCustomPacket(
        userId,
        JSON.stringify(voiceConfig)
      );

      console.log(`[VoiceSystem] Sent voice config to user ${userId} (${identity}, TTL=${this.tokenTtl}s)`);
    } catch (e) {
      console.error(`[VoiceSystem] Failed to send voice config to user ${userId}:`, e);
    }
  }

  private clearPendingUser(userId: number): void {
    const timer = this.pendingUsers.get(userId);
    if (timer) {
      clearInterval(timer);
      this.pendingUsers.delete(userId);
    }
  }
}
