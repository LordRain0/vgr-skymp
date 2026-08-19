#!/usr/bin/env node
"use strict";

// ============================================================================
// !!!!!!!!!!!!!!!!!!!!!!!!!!!!!! WARNING !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
// ============================================================================
// RUN THIS ONLY WITH THE GAME SERVER (VgrGameServer / scamp_native) STOPPED.
//
// The server keeps every changeForm in memory and upserts the full document
// back to Mongo on its own save cycle. If the server is running while this
// script writes, the very next save will overwrite every repair made here
// with the stale in-memory copy, and the two writers can interleave into a
// worse state than before. Stop the NSSM service first, run this script,
// verify the output, then start the server again.
//
// Default mode is DRY-RUN: it only prints findings and writes nothing.
// Pass --apply to actually modify the database.
// ============================================================================
//
// What this script does (see vgr_actor_hygiene.js for the root cause):
//   NPC spawns persisted SetNodeScale into changeForm docs; Mongo upserts are
//   $set-only so the field never clears, NPC docs are never deleted, and the
//   server recycles low formIds after restart. New player characters then
//   inherit docs still carrying NPC scale (players render as giants), and
//   corrupted player docs (no appearanceDump, worldOrCellDesc "0:Skyrim.esm")
//   poison the client's per-form render loop (invisible neighbors).
//
//   (a) $unset setNodeScale on player-base actor docs
//       (recType 1, baseDesc "7:Skyrim.esm")
//   (b) list NPC docs that still carry setNodeScale - REVIEW ONLY, no writes
//   (c) repair player docs whose worldOrCellDesc is "0:Skyrim.esm": set
//       worldOrCellDesc/position/angle to the Whiterun temple spawn used by
//       vgr_respawn.js (WHITERUN const); flag docs missing appearanceDump in
//       the output (appearances are NOT fabricated - the race menu reopens
//       for those players via the spawn.ts validation)
//
// Usage:
//   node tools/cleanup-scale-contamination.js [--settings <path>] [--apply]
//
//   --settings <path>  server-settings.json (default: ../server/server-settings.json)
//   --apply            write the (a) and (c) repairs; without it, dry-run only

const fs = require("fs");
const path = require("path");

// mongodb driver comes from skymp5-backend's node_modules (the game server
// itself does not ship a Node mongodb dependency at the repo root).
let MongoClient = null;
const driverCandidates = [
	path.join(__dirname, "..", "skymp5-backend", "node_modules", "mongodb"),
	"mongodb",
];
for (const candidate of driverCandidates) {
	try {
		MongoClient = require(candidate).MongoClient;
		break;
	} catch (e) { /* try the next candidate */ }
}
if (!MongoClient) {
	console.error("mongodb driver not found (looked in skymp5-backend/node_modules and the ambient require path).");
	process.exit(2);
}

// Whiterun temple spawn - mirrors the WHITERUN const in
// vgr-gamemode/gamemode_extensions/vgr_respawn.js
const WHITERUN = {
	cellOrWorldDesc: "165a7:Skyrim.esm",
	pos: [223.24, 248.85, 54],
	rot: [0, 0, 0],
};

const PLAYER_BASE_DESC = "7:Skyrim.esm"; // Player base record
const VOID_WORLD_DESC = "0:Skyrim.esm"; // worldOrCellDesc resolving to form 0
const REC_TYPE_ACTOR = 1;
const COLLECTION = "changeForms";

function parseArgs(argv) {
	const args = {
		apply: false,
		settings: path.join(__dirname, "..", "server", "server-settings.json"),
	};
	for (let i = 2; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--apply") args.apply = true;
		else if (arg === "--settings") args.settings = argv[++i] || "";
		else if (arg === "--help" || arg === "-h") {
			console.log("Usage: node tools/cleanup-scale-contamination.js [--settings <path>] [--apply]");
			console.log("Dry-run is the default; --apply writes the (a) and (c) repairs.");
			console.log("RUN ONLY WITH THE GAME SERVER STOPPED.");
			process.exit(0);
		} else {
			console.error("Unknown argument: " + arg);
			process.exit(2);
		}
	}
	return args;
}

function fmtScale(setNodeScale) {
	if (!setNodeScale || typeof setNodeScale !== "object") return "(unreadable)";
	return Object.keys(setNodeScale)
		.map((node) => JSON.stringify(node) + ": " + setNodeScale[node])
		.join(", ");
}

function fmtPos(position) {
	if (!Array.isArray(position)) return "(none)";
	return "[" + position.map((n) => Number(n)).join(", ") + "]";
}

function hasAppearance(doc) {
	// appearanceDump is stored as null (not absent) for actors that never
	// completed the race menu; treat null/missing/empty the same way.
	return doc.appearanceDump !== null && doc.appearanceDump !== undefined;
}

function describeDoc(doc) {
	const flags = [];
	if (!hasAppearance(doc)) flags.push("MISSING appearanceDump");
	if (doc.worldOrCellDesc === VOID_WORLD_DESC) flags.push("VOID worldOrCellDesc");
	if (doc.spawnPoint_cellOrWorldDesc === VOID_WORLD_DESC) flags.push("VOID spawnPoint (review manually)");
	return [
		"  formDesc=" + doc.formDesc,
		"baseDesc=" + doc.baseDesc,
		"profileId=" + (doc.profileId === undefined ? "(none)" : doc.profileId),
		"worldOrCellDesc=" + (doc.worldOrCellDesc || "(none)"),
		"pos=" + fmtPos(doc.position),
		"setNodeScale={" + fmtScale(doc.setNodeScale) + "}",
		flags.length ? "FLAGS: " + flags.join("; ") : "",
	].filter(Boolean).join(" ");
}

async function main() {
	const args = parseArgs(process.argv);

	const settings = JSON.parse(fs.readFileSync(args.settings, "utf8"));
	if (!settings.databaseUri || !settings.databaseName) {
		console.error("databaseUri / databaseName missing from " + args.settings);
		process.exit(2);
	}

	console.log("=".repeat(76));
	console.log("changeForm scale/void-cell contamination cleanup");
	console.log("mode: " + (args.apply ? "APPLY (writing to the database)" : "DRY-RUN (no writes)"));
	console.log("database: " + settings.databaseName + " collection: " + COLLECTION);
	console.log("REMINDER: the game server MUST be stopped while this runs.");
	console.log("=".repeat(76));

	const client = await MongoClient.connect(settings.databaseUri, { maxPoolSize: 4 });
	try {
		const collection = client.db(settings.databaseName).collection(COLLECTION);

		// ---- (a) player-base actor docs carrying setNodeScale -> $unset ----
		const playerScaleFilter = {
			recType: REC_TYPE_ACTOR,
			baseDesc: PLAYER_BASE_DESC,
			setNodeScale: { $exists: true },
		};
		const playerScaleDocs = await collection.find(playerScaleFilter).toArray();
		console.log("");
		console.log("(a) player docs with setNodeScale (will $unset): " + playerScaleDocs.length);
		for (const doc of playerScaleDocs) console.log(describeDoc(doc));
		if (args.apply && playerScaleDocs.length) {
			const result = await collection.updateMany(playerScaleFilter, { $unset: { setNodeScale: "" } });
			console.log("    APPLIED: $unset setNodeScale on " + result.modifiedCount + " doc(s)");
		}

		// ---- (b) NPC docs with setNodeScale - list only, never modified ----
		const npcScaleDocs = await collection.find({
			recType: REC_TYPE_ACTOR,
			baseDesc: { $ne: PLAYER_BASE_DESC },
			setNodeScale: { $exists: true },
		}).toArray();
		console.log("");
		console.log("(b) NPC docs with setNodeScale (manual review only, NOT modified): " + npcScaleDocs.length);
		for (const doc of npcScaleDocs) console.log(describeDoc(doc));

		// ---- (c) player docs stranded in the void cell -> whiterun temple ----
		const voidFilter = {
			recType: REC_TYPE_ACTOR,
			baseDesc: PLAYER_BASE_DESC,
			worldOrCellDesc: VOID_WORLD_DESC,
		};
		const voidDocs = await collection.find(voidFilter).toArray();
		console.log("");
		console.log("(c) player docs in void cell " + VOID_WORLD_DESC + " (will move to Whiterun temple): " + voidDocs.length);
		let missingAppearance = 0;
		for (const doc of voidDocs) {
			console.log(describeDoc(doc));
			if (!hasAppearance(doc)) missingAppearance++;
		}
		if (missingAppearance) {
			console.log("    NOTE: " + missingAppearance + " doc(s) above are missing appearanceDump.");
			console.log("    Appearances are NOT fabricated here; those players get the race");
			console.log("    menu reopened on next login by the spawn.ts validation.");
		}
		if (args.apply && voidDocs.length) {
			const result = await collection.updateMany(voidFilter, {
				$set: {
					worldOrCellDesc: WHITERUN.cellOrWorldDesc,
					position: WHITERUN.pos,
					angle: WHITERUN.rot,
				},
			});
			console.log("    APPLIED: moved " + result.modifiedCount + " doc(s) to " + WHITERUN.cellOrWorldDesc);
		}

		console.log("");
		if (!args.apply) {
			console.log("DRY-RUN complete. Nothing was written. Re-run with --apply (server stopped) to repair.");
		} else {
			console.log("APPLY complete. Start the game server again only after verifying the output above.");
		}
	} finally {
		await client.close();
	}
}

main().catch((e) => {
	console.error("cleanup failed:", e && e.message ? e.message : e);
	process.exit(1);
});
