#!/usr/bin/env node
"use strict";

const path = require("path");
const { MongoClient } = require("mongodb");
const {
  finalizeTrade,
  getItemCount,
  VGR_GOLD_BASE_ID,
} = require(path.join(__dirname, "..", "gamemode_extensions", "vgr_trade_helpers"));

// ── Configuration ────────────────────────────────────────────────────────────
const MONGO_URI = "mongodb://localhost:27017";
const DB_NAME = "skymp";
const COLLECTION = "changeForms";

// Set these to your test characters from MongoDB Compass.
const PLAYER_A_QUERY = { formDesc: "b" };
const PLAYER_B_QUERY = { formDesc: "1" };

// Player A gives 1 iron ingot (baseId 10), Player B gives 20 gold.
const OFFER_A = [{ baseId: 10, count: 1 }];
const OFFER_B = [{ baseId: VGR_GOLD_BASE_ID, count: 20 }];

const DRY_RUN = false;
// ─────────────────────────────────────────────────────────────────────────────

function summarizeInv(inv) {
  const entries = Array.isArray(inv && inv.entries) ? inv.entries : [];
  return entries
    .map((e) => "  baseId=" + e.baseId + " count=" + e.count + (e.worn ? " (worn)" : ""))
    .join("\n");
}

async function main() {
  const client = new MongoClient(MONGO_URI);

  try {
    await client.connect();
    const col = client.db(DB_NAME).collection(COLLECTION);

    const docA = await col.findOne(PLAYER_A_QUERY);
    const docB = await col.findOne(PLAYER_B_QUERY);

    if (!docA) {
      console.error("[debug-force-trade] Player A not found:", JSON.stringify(PLAYER_A_QUERY));
      process.exit(1);
    }
    if (!docB) {
      console.error("[debug-force-trade] Player B not found:", JSON.stringify(PLAYER_B_QUERY));
      process.exit(1);
    }

    const invA = docA.inv || { entries: [] };
    const invB = docB.inv || { entries: [] };

    console.log("=== BEFORE ===");
    console.log("Player A (" + (docA.formDesc || docA._id) + "):");
    console.log(summarizeInv(invA) || "  (empty)");
    console.log("Player B (" + (docB.formDesc || docB._id) + "):");
    console.log(summarizeInv(invB) || "  (empty)");

    console.log("\nOffer A:", JSON.stringify(OFFER_A));
    console.log("Offer B:", JSON.stringify(OFFER_B));

    for (const item of OFFER_A) {
      if (getItemCount(invA, item.baseId) < item.count) {
        console.error("[debug-force-trade] Player A lacks baseId " + item.baseId);
        process.exit(1);
      }
    }
    for (const item of OFFER_B) {
      if (getItemCount(invB, item.baseId) < item.count) {
        console.error("[debug-force-trade] Player B lacks baseId " + item.baseId);
        process.exit(1);
      }
    }

    const result = finalizeTrade(invA, invB, OFFER_A, OFFER_B);

    console.log("\n=== AFTER (computed) ===");
    console.log("Player A:");
    console.log(summarizeInv(result.invA) || "  (empty)");
    console.log("Player B:");
    console.log(summarizeInv(result.invB) || "  (empty)");

    if (DRY_RUN) {
      console.log("\n[debug-force-trade] DRY_RUN=true — no database writes.");
      return;
    }

    await col.updateOne(PLAYER_A_QUERY, { $set: { inv: result.invA } });
    await col.updateOne(PLAYER_B_QUERY, { $set: { inv: result.invB } });
    console.log("\n[debug-force-trade] Both documents updated in MongoDB.");
  } catch (err) {
    console.error("[debug-force-trade] Failed:", err.message || err);
    process.exit(1);
  } finally {
    await client.close();
  }
}

main();
