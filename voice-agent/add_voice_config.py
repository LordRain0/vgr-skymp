import json
with open('/opt/skymp/server/server-settings.json') as f:
    cfg = json.load(f)
cfg['voice'] = {
    'enabled': True,
    'livekitUrl': 'wss://eruvos-590ob200.livekit.cloud',
    'livekitApiKey': 'APIvNqpF3s2andX',
    'livekitApiSecret': 'uXTzmATtuzcH454xZwfw53H8KX17X7QtlyepleyDvisA',
    'roomName': 'eruvos-voice',
    'redisUrl': 'rediss://eruvos-voice-redis-k6gnub.serverless.sae1.cache.amazonaws.com:6379',
    'voiceRange': 4000,
    'positionUpdateIntervalMs': 500,
    'tokenTtlSeconds': 300
}
with open('/opt/skymp/server/server-settings.json', 'w') as f:
    json.dump(cfg, f, indent=2)
print('voice config added')
