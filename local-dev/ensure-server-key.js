// Ensures the local server has a gamemode-script signing keypair.
// SkyMP signs server-sent JS (PartOne.cpp: "// skymp:sig:y:CPP<alias>:<sig>")
// and the client rejects unsigned JS whenever its settings contain a
// server-public-keys object (even an empty one - see
// serverJsVerificationService.ts). So the local server must sign like prod,
// with a locally generated key.
//
// Usage: node ensure-server-key.js <path-to-server-settings.json>
// Prints JSON {keyId, pub} for the client settings writer.
const fs = require('fs');
const crypto = require('crypto');

const settingsPath = process.argv[2];
if (!settingsPath || !fs.existsSync(settingsPath)) {
  console.error('server-settings.json not found: ' + settingsPath);
  process.exit(1);
}

const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

if (!settings.serverKey || !settings.serverKey.private) {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  settings.serverKey = {
    alias: 'vgrlocal',
    private: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

const pub = crypto
  .createPublicKey(crypto.createPrivateKey(settings.serverKey.private))
  .export({ type: 'spki', format: 'pem' })
  .toString();

console.log(JSON.stringify({ keyId: 'CPP' + settings.serverKey.alias, pub }));
