import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import {
  AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  Room,
  RoomEvent,
  TrackPublishOptions,
  TrackSource,
  dispose,
} from '@livekit/rtc-node';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';

const ROOT = resolve(import.meta.dirname, '..');
loadEnvFile(resolve(ROOT, '.env'));

const config = {
  livekitUrl: env('LIVEKIT_URL', 'ws://127.0.0.1:7880'),
  apiKey: env('LIVEKIT_API_KEY'),
  apiSecret: env('LIVEKIT_API_SECRET'),
  roomName: env('ROOM_NAME', 'vgr-voice'),
  agentUrl: env('VOICE_AGENT_URL', 'http://127.0.0.1:8090').replace(/\/$/, ''),
  durationSeconds: envNumber('TEST_DURATION_SECONDS', 25),
  positionIntervalMs: envNumber('POSITION_INTERVAL_MS', 500),
  worldOrCell: envNumber('WORLD_OR_CELL', 1),
  nearSpacing: envNumber('NEAR_SPACING', 100),
  allowExisting: env('ALLOW_EXISTING_PARTICIPANTS', '0') === '1',
  dryRun: process.argv.includes('--dry-run'),
};

const suffix = `${Date.now().toString(36)}-${process.pid}`;
const definitions = [
  { label: 'A', identity: `vgr-test-a-${suffix}`, x: 0, frequency: 220 },
  { label: 'B', identity: `vgr-test-b-${suffix}`, x: config.nearSpacing, frequency: 330 },
  { label: 'C', identity: `vgr-test-c-${suffix}`, x: config.nearSpacing * 2, frequency: 440 },
];

const expectedPaths = definitions.flatMap((listener) =>
  definitions
    .filter((speaker) => speaker.identity !== listener.identity)
    .map((speaker) => `${listener.identity}<-${speaker.identity}`),
);

const state = new Map(
  expectedPaths.map((path) => [path, { subscribed: false, frames: 0, nonSilentFrames: 0, lastEvent: 'waiting' }]),
);
const clients = [];
let stopping = false;

function env(name, fallback = '') {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function envNumber(name, fallback) {
  const value = Number(env(name, String(fallback)));
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return value;
}

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const equals = line.indexOf('=');
    if (equals < 1) continue;
    const key = line.slice(0, equals).trim();
    let value = line.slice(equals + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function serviceUrl(wsUrl) {
  const url = new URL(wsUrl);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  return url.toString().replace(/\/$/, '');
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function shortIdentity(identity) {
  return definitions.find((item) => item.identity === identity)?.label ?? identity;
}

function displayPath(path) {
  const [listener, speaker] = path.split('<-');
  return `${shortIdentity(listener)} hears ${shortIdentity(speaker)}`;
}

function printMatrix() {
  console.log('\nCurrent result matrix:');
  for (const path of expectedPaths) {
    const entry = state.get(path);
    const mark = entry.nonSilentFrames >= 10 ? 'PASS' : entry.subscribed ? 'WAIT' : '----';
    console.log(`  ${mark.padEnd(4)}  ${displayPath(path).padEnd(11)}  frames=${entry.frames}`);
  }
}

async function createToken(identity) {
  const token = new AccessToken(config.apiKey, config.apiSecret, {
    identity,
    name: `VGR test ${shortIdentity(identity)}`,
    ttl: '10m',
  });
  token.addGrant({
    roomJoin: true,
    room: config.roomName,
    canPublish: true,
    canSubscribe: true,
    canPublishData: false,
  });
  return token.toJwt();
}

function attachRoomEvents(client) {
  const { room, definition } = client;
  room.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
    const path = `${definition.identity}<-${participant.identity}`;
    const entry = state.get(path);
    if (!entry) return;
    entry.subscribed = true;
    entry.lastEvent = 'subscribed';
    console.log(`[subscription] ${displayPath(path)}`);

    const stream = new AudioStream(track);
    client.streams.add(stream);
    void consumeAudio(path, stream, client);
  });

  room.on(RoomEvent.TrackUnsubscribed, (_track, _publication, participant) => {
    const path = `${definition.identity}<-${participant.identity}`;
    const entry = state.get(path);
    if (!entry) return;
    entry.subscribed = false;
    entry.lastEvent = 'unsubscribed';
    console.log(`[unsubscribe]  ${displayPath(path)}`);
  });

  room.on(RoomEvent.TrackSubscriptionFailed, (trackSid, participant, reason) => {
    console.error(`[failed] ${definition.label} could not subscribe to ${participant.identity}/${trackSid}: ${reason ?? 'unknown'}`);
  });

  room.on(RoomEvent.Disconnected, (reason) => {
    if (!stopping) console.error(`[disconnect] test player ${definition.label}: ${reason}`);
  });
}

async function consumeAudio(path, stream, client) {
  try {
    for await (const frame of stream) {
      const entry = state.get(path);
      if (!entry || stopping) break;
      entry.frames += 1;
      if (frame.data.some((sample) => sample !== 0)) entry.nonSilentFrames += 1;
    }
  } catch (error) {
    if (!stopping) console.error(`[audio] ${displayPath(path)} stream error: ${error.message}`);
  } finally {
    client.streams.delete(stream);
  }
}

function makeToneFrame(frequency, phase) {
  const sampleRate = 48000;
  const samples = 960;
  const data = new Int16Array(samples);
  for (let i = 0; i < samples; i += 1) {
    data[i] = Math.round(Math.sin(phase + (2 * Math.PI * frequency * i) / sampleRate) * 2500);
  }
  const nextPhase = (phase + (2 * Math.PI * frequency * samples) / sampleRate) % (2 * Math.PI);
  return { frame: new AudioFrame(data, sampleRate, 1, samples), nextPhase };
}

async function publishTone(client) {
  let phase = 0;
  while (!stopping) {
    const generated = makeToneFrame(client.definition.frequency, phase);
    phase = generated.nextPhase;
    await client.source.captureFrame(generated.frame);
    await sleep(20);
  }
}

async function postPosition(definition) {
  const response = await fetch(`${config.agentUrl}/api/position`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      identity: definition.identity,
      x: definition.x,
      y: 0,
      z: 0,
      worldOrCell: config.worldOrCell,
    }),
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
}

async function positionLoop() {
  while (!stopping) {
    await Promise.all(definitions.map(postPosition));
    await sleep(config.positionIntervalMs);
  }
}

async function connectPlayer(definition) {
  const room = new Room();
  const client = { definition, room, source: null, track: null, streams: new Set(), publishTask: null };
  attachRoomEvents(client);
  const token = await createToken(definition.identity);
  await room.connect(config.livekitUrl, token, { autoSubscribe: false, dynacast: false });

  const source = new AudioSource(48000, 1);
  const track = LocalAudioTrack.createAudioTrack(`vgr-test-tone-${definition.label}`, source);
  const options = new TrackPublishOptions();
  options.source = TrackSource.SOURCE_MICROPHONE;
  await room.localParticipant.publishTrack(track, options);

  client.source = source;
  client.track = track;
  client.publishTask = publishTone(client);
  clients.push(client);
  console.log(`[connected] test player ${definition.label} (${definition.identity})`);
}

async function assertSafeRoom() {
  const roomService = new RoomServiceClient(serviceUrl(config.livekitUrl), config.apiKey, config.apiSecret);
  let participants = [];
  try {
    participants = await roomService.listParticipants(config.roomName);
  } catch (error) {
    if (!String(error.message).toLowerCase().includes('not found')) throw error;
  }
  const realParticipants = participants.filter((participant) => !participant.identity.startsWith('vgr-test-'));
  if (realParticipants.length > 0 && !config.allowExisting) {
    throw new Error(
      `Room ${config.roomName} already has ${realParticipants.length} non-test participant(s). ` +
        'Run this while players are logged out, or set ALLOW_EXISTING_PARTICIPANTS=1 deliberately.',
    );
  }
}

async function cleanup() {
  if (stopping) return;
  stopping = true;
  console.log('\nCleaning up temporary participants...');
  await Promise.allSettled(
    clients.flatMap((client) => [
      ...[...client.streams].map((stream) => stream.cancel().catch(() => {})),
      client.room.disconnect(),
    ]),
  );
  await Promise.allSettled(clients.map((client) => client.publishTask));
  await dispose();
}

function writeResult(passed, startedAt, error = null) {
  const outputDir = resolve(ROOT, 'test-results');
  mkdirSync(outputDir, { recursive: true });
  const result = {
    passed,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    room: config.roomName,
    livekitUrl: config.livekitUrl,
    voiceAgentUrl: config.agentUrl,
    error: error?.message ?? null,
    paths: Object.fromEntries([...state].map(([path, value]) => [displayPath(path), value])),
  };
  const filename = resolve(outputDir, `voice-test-${startedAt.toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(filename, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`Detailed result: ${filename}`);
}

async function main() {
  const startedAt = new Date();
  if (!config.apiKey || !config.apiSecret) {
    throw new Error('LIVEKIT_API_KEY and LIVEKIT_API_SECRET are required in voice-test/.env');
  }

  console.log('VGR three-player voice test');
  console.log(`LiveKit:    ${config.livekitUrl}`);
  console.log(`Room:       ${config.roomName}`);
  console.log(`Voice agent:${config.agentUrl}`);
  console.log(`Scenario:   A, B, and C are in the same world, ${config.nearSpacing} units apart`);

  if (config.dryRun) {
    console.log('\nDry run passed: configuration is readable; no connections were made.');
    return;
  }

  await assertSafeRoom();
  await Promise.all(definitions.map(connectPlayer));
  console.log('\nAll three temporary players are publishing audio. Waiting for proximity subscriptions...');
  const positionsTask = positionLoop();
  const printTimer = setInterval(printMatrix, 5000);

  await Promise.race([sleep(config.durationSeconds * 1000), positionsTask]);
  clearInterval(printTimer);
  stopping = true;
  await positionsTask;

  printMatrix();
  const failed = expectedPaths.filter((path) => state.get(path).nonSilentFrames < 10);
  const passed = failed.length === 0;
  if (passed) {
    console.log('\nPASS: all six hearing paths subscribed and delivered audio.');
  } else {
    console.error(`\nFAIL: ${failed.length} hearing path(s) did not deliver enough audio:`);
    for (const path of failed) console.error(`  - ${displayPath(path)} (${state.get(path).lastEvent})`);
  }
  writeResult(passed, startedAt);
  await cleanupAfterRun();
  process.exitCode = passed ? 0 : 2;
}

async function cleanupAfterRun() {
  console.log('\nCleaning up temporary participants...');
  await Promise.allSettled(clients.map((client) => client.room.disconnect()));
  await Promise.allSettled(clients.map((client) => client.publishTask));
  await dispose();
}

process.once('SIGINT', () => {
  void cleanup().finally(() => process.exit(130));
});
process.once('SIGTERM', () => {
  void cleanup().finally(() => process.exit(143));
});

main().catch(async (error) => {
  console.error(`\nTEST ERROR: ${error.message}`);
  writeResult(false, new Date(), error);
  await cleanup();
  process.exitCode = 1;
});
