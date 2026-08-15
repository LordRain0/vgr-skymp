#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

let MongoClient = null;
try {
  MongoClient = require("mongodb").MongoClient;
} catch (e) {
  console.error("[VGR access migration] mongodb package is required.");
  process.exit(2);
}

function usage() {
  return [
    "Usage: node tools/migrate_vgr_legacy_locks.js --settings <server-settings.json> [--commit] [--filter <text-or-regex>] [--report <file>]",
    "",
    "Dry run is the default. Add --commit to write vgr_access_objects documents.",
  ].join("\n");
}

function parseArgs(argv) {
  const args = { commit: false, settings: "", filter: "", report: "" };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--commit") args.commit = true;
    else if (arg === "--settings") args.settings = argv[++i] || "";
    else if (arg === "--filter") args.filter = argv[++i] || "";
    else if (arg === "--report") args.report = argv[++i] || "";
    else if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error("Unknown argument: " + arg);
    }
  }
  if (!args.settings) throw new Error("--settings is required");
  return args;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function deriveUri(settings, dbName) {
  const source = settings.databaseUri || "";
  if (!source) throw new Error("databaseUri missing from settings");
  const uri = new URL(source);
  uri.pathname = "/" + dbName;
  return uri.toString();
}

function nowIso() {
  return new Date().toISOString();
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeCharacter(doc) {
  const profileId = Number(doc && doc.profileId);
  if (!Number.isInteger(profileId) || profileId < 0) return null;
  const displayName = String(doc.displayName || doc.name || doc.appearanceDump?.name || doc.appearance?.name || ("Profile " + profileId)).trim();
  return { profileId, displayName };
}

function normalizeRef(ref) {
  if (!ref || !ref.formDesc) return null;
  return {
    formDesc: String(ref.formDesc),
    formIdHex: ref.formIdHex ? String(ref.formIdHex).toUpperCase() : "",
    worldOrCellDesc: ref.worldOrCellDesc ? String(ref.worldOrCellDesc) : "",
    position: Array.isArray(ref.position) ? ref.position.slice(0, 3).map((n) => Number(n) || 0) : [0, 0, 0],
  };
}

function refsFromLegacy(doc) {
  if (Array.isArray(doc.refs) && doc.refs.length) return doc.refs.map(normalizeRef).filter(Boolean);
  const formDesc = typeof doc._id === "string" && doc._id.indexOf(":") !== -1 && doc._id.indexOf("pair:") !== 0
    ? doc._id
    : doc.formDesc || "";
  if (!formDesc) return [];
  return [normalizeRef({
    formDesc,
    formIdHex: doc.formIdHex || "",
    worldOrCellDesc: doc.worldOrCellDesc || "",
    position: doc.position || [0, 0, 0],
  })].filter(Boolean);
}

function objectIdFor(doc, refs) {
  if (typeof doc._id === "string" && doc._id.startsWith("pair:")) {
    return "door:" + doc._id.slice("pair:".length);
  }
  const first = refs[0] && refs[0].formDesc;
  const type = doc.objectType === "door" ? "door" : "container";
  return type + ":" + first;
}

async function resolveByFormDesc(changeForms, characters, formDesc) {
  if (!formDesc) return null;
  const changeForm = await changeForms.findOne(
    { formDesc: String(formDesc) },
    { projection: { profileId: 1, appearance: 1, appearanceDump: 1, formDesc: 1 } }
  );
  const fromChangeForm = normalizeCharacter(changeForm);
  if (fromChangeForm) return fromChangeForm;

  const name = String(changeForm?.appearanceDump?.name || changeForm?.appearance?.name || "").trim();
  if (name) {
    const regex = new RegExp("^" + escapeRegex(name) + "$", "i");
    const byName = await characters.findOne(
      { deletedAt: null, $or: [{ name: regex }, { displayName: regex }] },
      { projection: { profileId: 1, name: 1, displayName: 1 } }
    );
    return normalizeCharacter(byName);
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv);
  const settingsPath = path.resolve(args.settings);
  const settings = readJson(settingsPath);
  const access = settings.vgrAccessControl || {};
  const locks = settings.vgrLocks || {};

  const accessDbName = access.databaseName || "vengeful_realms";
  const backendDbName = access.backendDatabaseName || "skymp-backend";
  const gameDbName = settings.databaseName || "skymp";
  const legacyDbName = locks.databaseName || accessDbName;
  const legacyCollectionName = locks.collection || "locked_objects";
  const targetCollectionName = access.collection || "vgr_access_objects";

  const legacyClient = await MongoClient.connect(deriveUri(settings, legacyDbName));
  const accessClient = legacyDbName === accessDbName ? legacyClient : await MongoClient.connect(deriveUri(settings, accessDbName));
  const gameClient = gameDbName === legacyDbName ? legacyClient : await MongoClient.connect(deriveUri(settings, gameDbName));
  const backendClient = backendDbName === legacyDbName ? legacyClient : await MongoClient.connect(deriveUri(settings, backendDbName));

  const legacyCol = legacyClient.db(legacyDbName).collection(legacyCollectionName);
  const targetCol = accessClient.db(accessDbName).collection(targetCollectionName);
  const changeForms = gameClient.db(gameDbName).collection("changeForms");
  const characters = backendClient.db(backendDbName).collection(access.charactersCollection || "characters");

  const query = {};
  let filterRegex = null;
  if (args.filter) {
    filterRegex = new RegExp(escapeRegex(args.filter), "i");
  }

  const report = {
    generatedAt: nowIso(),
    mode: args.commit ? "commit" : "dry-run",
    source: { database: legacyDbName, collection: legacyCollectionName },
    target: { database: accessDbName, collection: targetCollectionName },
    scanned: 0,
    planned: 0,
    inserted: 0,
    skipped: [],
    unresolvedIdentities: [],
    objects: [],
  };

  const cursor = legacyCol.find(query).sort({ _id: 1 });
  while (await cursor.hasNext()) {
    const legacy = await cursor.next();
    report.scanned += 1;
    const identityText = String(legacy._id || "") + " " + String(legacy.formDesc || "");
    if (filterRegex && !filterRegex.test(identityText)) continue;

    const refs = refsFromLegacy(legacy);
    if (!refs.length) {
      report.skipped.push({ legacyId: legacy._id, reason: "no stable refs" });
      continue;
    }

    const objectType = legacy.objectType === "door" ? "door" : "container";
    const objectId = objectIdFor(Object.assign({}, legacy, { objectType }), refs);
    const owner = await resolveByFormDesc(changeForms, characters, legacy.ownerFormDesc);
    const users = [];
    for (const formDesc of Array.isArray(legacy.users) ? legacy.users : []) {
      const resolved = await resolveByFormDesc(changeForms, characters, formDesc);
      if (resolved) users.push(resolved);
      else report.unresolvedIdentities.push({ legacyId: legacy._id, formDesc: String(formDesc) });
    }
    if (legacy.ownerFormDesc && !owner) report.unresolvedIdentities.push({ legacyId: legacy._id, formDesc: String(legacy.ownerFormDesc), role: "owner" });

    const doc = {
      _id: objectId,
      schemaVersion: 2,
      objectType,
      displayName: legacy.displayName || (objectType === "door" ? "Door" : "Container"),
      refs,
      owner,
      users: users.filter((user) => !owner || user.profileId !== owner.profileId),
      locked: legacy.locked !== false,
      revision: 1,
      createdAt: legacy.createdAt || nowIso(),
      updatedAt: nowIso(),
      migratedFrom: { collection: legacyCollectionName, legacyId: legacy._id },
      audit: [{
        at: nowIso(),
        action: "migrate_legacy_locks",
        actor: null,
        details: { legacyId: legacy._id, inventoryIgnored: legacy.inventory !== undefined },
      }],
    };

    report.planned += 1;
    report.objects.push({ legacyId: legacy._id, targetId: objectId, refs: refs.length, owner: owner ? owner.profileId : null, users: doc.users.map((u) => u.profileId) });

    if (args.commit) {
      const existing = await targetCol.findOne({ _id: objectId }, { projection: { _id: 1 } });
      if (existing) {
        report.skipped.push({ legacyId: legacy._id, targetId: objectId, reason: "target exists" });
      } else {
        await targetCol.insertOne(doc);
        report.inserted += 1;
      }
    }
  }

  if (args.report) {
    fs.writeFileSync(path.resolve(args.report), JSON.stringify(report, null, 2));
  }

  console.log(JSON.stringify({
    mode: report.mode,
    scanned: report.scanned,
    planned: report.planned,
    inserted: report.inserted,
    skipped: report.skipped.length,
    unresolvedIdentities: report.unresolvedIdentities.length,
    report: args.report || null,
  }, null, 2));

  await Promise.all([
    legacyClient.close(),
    accessClient === legacyClient ? Promise.resolve() : accessClient.close(),
    gameClient === legacyClient ? Promise.resolve() : gameClient.close(),
    backendClient === legacyClient ? Promise.resolve() : backendClient.close(),
  ]);
}

main().catch((err) => {
  console.error("[VGR access migration]", err && err.stack ? err.stack : err);
  process.exit(1);
});
