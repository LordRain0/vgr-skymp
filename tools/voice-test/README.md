# VGR three-player voice test

This tool replaces three human testers with three temporary LiveKit participants named A, B, and C. Each participant publishes a quiet test tone, all three are placed close together through the voice-agent API, and the tool checks all six possible hearing directions.

It does not launch Skyrim, use Discord accounts, modify the game client, or alter server files. Temporary participants disconnect when the test finishes.

## One-time setup

1. Install Node.js on the server if it is not already installed.
2. Copy this entire `voice-test` folder to the server.
3. Copy `.env.example` to `.env`.
4. Edit `.env` and set the same LiveKit API key and secret used by the LiveKit server and voice agent.

Do not send `.env` to players or place it in a public archive. It contains the server-side LiveKit secret.

## Run it

1. Make sure no real players are logged in.
2. Start LiveKit, then the voice agent.
3. Double-click `run-three-player-test.bat`.
4. Wait about 25 seconds.

A successful run ends with:

```text
PASS: all six hearing paths subscribed and delivered audio.
```

The six paths are A hears B, A hears C, B hears A, B hears C, C hears A, and C hears B. A JSON report is also saved in `test-results`.

## What a failure means

- No temporary players connect: check LiveKit URL, key, secret, and port 7880.
- Position updates fail: the voice agent is not reachable on port 8090 or does not expose `/api/position`.
- Some paths subscribe but receive no frames: the published track is not binding or media transport is failing.
- Only some paths subscribe: focus on the voice-agent subscription calculation/API calls.
- All six pass here but Skyrim still fails: the remaining defect is in the game client DLL, playback, or a player's network rather than the central three-way LiveKit path.

The test refuses to start when ordinary participants are already in `vgr-voice`. This prevents the tones from interfering with players. An operator can deliberately override that guard with `ALLOW_EXISTING_PARTICIPANTS=1` in `.env`.

## Configuration check without connecting

From this folder:

```powershell
node .\src\three-player-test.mjs --dry-run
```
