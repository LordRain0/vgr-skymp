# LiveKit Voice Chat

This SkyMP fork supports proximity based voice chat powered by [LiveKit](https://livekit.io/). Players can talk to nearby players using push-to-talk, with spatial audio that attenuates based on in-game distance.

The system consists of three components:

1. **VoiceSystem** (TypeScript, runs inside `skymp5-server`) — generates per-player LiveKit tokens and publishes 3D positions.
2. **Voice Agent** (Go service) — manages LiveKit room subscriptions for proximity filtering.
3. **Client-side VoiceChatService** (TypeScript + native C++ plugin) — captures microphone audio, connects to the LiveKit room, and renders spatial audio.

## Prerequisites

- A running [LiveKit server](https://docs.livekit.io/home/self-hosting/local/) (self-hosted or LiveKit Cloud)
- An API key and secret for your LiveKit instance

## Server Configuration

Voice chat is configured through the `voice` section in `server-settings.json`.

### Minimal example

```json5
{
  // ... other server settings ...
  "voice": {
    "enabled": true,
    "livekitUrl": "wss://your-livekit-host:7880",
    "livekitApiKey": "your-api-key",
    "livekitApiSecret": "your-api-secret",
    "roomName": "my-server-voice"
  }
}
```

### Full reference

```json5
{
  "voice": {
    "enabled": true,                    // Enable/disable voice chat
    "livekitUrl": "wss://voice.example.com:7880", // LiveKit server WebSocket URL
    "livekitApiKey": "APIxxxxxxx",      // LiveKit API key
    "livekitApiSecret": "secret...",    // LiveKit API secret (used to sign JWTs)
    "roomName": "my-voice-room",        // LiveKit room name all players join
    "voiceRange": 4000,                 // Proximity range in game units (default 4000)
    "pttKey": 47,                       // Push-to-talk key (DirectX scan code, default 47 = V)
    "inputGain": 1.0,                   // Microphone input gain multiplier (default 1.0)
    "outputVolume": 1.0,                // Speaker output volume multiplier (default 1.0)
    "noiseGateEnabled": false,          // Enable noise gate to suppress background noise
    "noiseGateThreshold": 0.01,         // Noise gate RMS threshold 0-1 (default 0.01)
    "normalizationEnabled": false,      // Enable volume normalization / AGC
    "normalizationTarget": 0.1,         // Normalization target RMS 0-1 (default 0.1)
    "tokenTtlSeconds": 300,             // JWT token lifetime in seconds (default 300 = 5 min)
    "positionUpdateIntervalMs": 500     // How often to broadcast positions (default 500ms)
  }
}
```

### Settings breakdown

| Setting | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | — | Must be `true` to activate voice chat. |
| `livekitUrl` | string | — | WebSocket URL of your LiveKit server (e.g. `wss://host:7880`). |
| `livekitApiKey` | string | — | API key from your LiveKit instance. |
| `livekitApiSecret` | string | — | API secret used to sign player JWT tokens. |
| `roomName` | string | — | Name of the LiveKit room all players join. |
| `voiceRange` | number | `4000` | Maximum distance (in game units) at which players can hear each other. |
| `pttKey` | number | `47` | DirectX scan code for push-to-talk. `47` is the V key. |
| `inputGain` | number | `1.0` | Microphone gain multiplier sent to clients. |
| `outputVolume` | number | `1.0` | Output volume multiplier sent to clients. |
| `noiseGateEnabled` | boolean | `false` | Enable client-side noise gate. |
| `noiseGateThreshold` | number | `0.01` | RMS threshold for the noise gate (0–1). |
| `normalizationEnabled` | boolean | `false` | Enable automatic gain control / volume normalization. |
| `normalizationTarget` | number | `0.1` | Target RMS level for normalization (0–1). |
| `tokenTtlSeconds` | number | `300` | Lifetime of each player's LiveKit JWT. Clients request a new token on expiry. |
| `positionUpdateIntervalMs` | number | `500` | Interval for broadcasting player positions to voice clients. |

## Voice Agent

The voice agent is a standalone Go service that manages proximity-based subscriptions in the LiveKit room. It controls which audio tracks each participant receives based on their positions.

### Configuration

The voice agent reads a JSON config file passed as a command-line argument:

```json5
{
  "livekitHost": "ws://localhost:7880",  // LiveKit server URL
  "livekitApiKey": "APIxxxxxxx",         // Same API key as server-settings.json
  "livekitSecret": "secret...",          // Same API secret as server-settings.json
  "voiceRange": 4000,                    // Must match server voiceRange setting
  "roomPrefix": "my-server",             // Prefix for room naming
  "tickRateMs": 250,                     // Proximity check interval in ms
  "maxStreams": 20                        // Max simultaneous audio streams per listener
}
```

### Running locally

```bash
cd voice-agent
go build -o voice-agent .
./voice-agent config.json
```

### Running with Docker

```bash
cd voice-agent
docker build -t voice-agent .
docker run --rm -v /path/to/config.json:/etc/voice-agent.json voice-agent /etc/voice-agent.json
```

## Ports

Voice chat introduces the following additional ports:

| Port | Protocol | Component | Description |
|---|---|---|---|
| `7880` | WebSocket (wss) | LiveKit server | Default LiveKit signaling port. |
| `7881` | TCP | LiveKit server | Default LiveKit RTC port. |
| `7882` | UDP | LiveKit server | Default LiveKit RTC port. |

Ensure these ports are accessible between the relevant services. Clients need access to the LiveKit server ports (`7880`–`7882`).

## Security

- Player tokens are short-lived JWTs (default 5 minutes) signed with HMAC-SHA256.
- Each token contains a unique identity with a random nonce, preventing reuse across sessions.
- Tokens are only issued after the player's actor exists in the game world.
- Token grants are scoped: `canPublish` and `canSubscribe` only, with no admin rights.
- Rate limiting prevents token re-issuance faster than every 5 seconds per player.
- The `livekitApiSecret` should be kept confidential and never exposed to clients.

## How It Works

1. Player connects to the game server and their actor is spawned.
2. `VoiceSystem` detects the actor, generates a LiveKit JWT, and sends a `voiceConfig` custom packet to the client.
3. The client's `VoiceChatService` connects to LiveKit using the native C++ plugin (`MpClientPlugin`).
4. The server periodically broadcasts a `voiceParticipantMap` packet mapping LiveKit identities to in-game actor IDs.
5. Clients use the participant map to position remote audio sources in 3D space relative to the listener.
6. When a token expires or the LiveKit connection drops, the client sends a `voiceReconnectRequest` and receives a fresh token.
7. On game disconnect, the client shuts down voice automatically.
