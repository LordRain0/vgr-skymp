"use strict";

const assert = require("assert");
const test = require("node:test");
const helpers = require("../gamemode_extensions/vgr_player_interaction_helpers");

test("directional introductions reveal only the introduced character", () => {
  const cache = new Set();
  const a = { profileId: 1, displayName: "Aelric" };
  const b = { profileId: 2, displayName: "Bryn" };

  assert.equal(helpers.visibleName(cache, a, b), "Stranger");
  assert.equal(helpers.visibleName(cache, b, a), "Stranger");

  // A introduced themselves to B, so B knows A. A still does not know B.
  cache.add(helpers.introKey("2", "1"));

  assert.equal(helpers.visibleName(cache, b, a), "Aelric");
  assert.equal(helpers.visibleName(cache, a, b), "Stranger");
});

test("known names resolve from the current identity, not the old snapshot", () => {
  const cache = new Set([helpers.introKey("2", "1")]);
  const viewer = { profileId: 2, displayName: "Viewer" };
  const renamed = { profileId: 1, displayName: "New Name" };

  assert.equal(helpers.visibleName(cache, viewer, renamed), "New Name");
});

test("cuff options aggregate only allowlisted base ids", () => {
  const inv = {
    entries: [
      { baseId: 0x00103941, count: 1 },
      { baseId: 0x00103941, count: 2 },
      { baseId: 0x0010E039, count: 1, custom: "metadata" },
      { baseId: 0x0000000f, count: 500 },
    ],
  };

  assert.deepEqual(helpers.findCuffOptions(inv), [
    { baseId: 0x00103941, count: 3 },
    { baseId: 0x0010E039, count: 1 },
  ]);
});

test("taking and adding a cuff preserves unrelated inventory and cuff metadata", () => {
  const source = {
    entries: [
      { baseId: 0x0010E2D8, count: 2, extra: "reserved" },
      { baseId: 0x0000000f, count: 10 },
    ],
  };
  const target = { entries: [{ baseId: 0x0000000f, count: 5 }] };

  const taken = helpers.takeOneCuff(source, 0x0010E2D8);
  assert.deepEqual(taken.inventory.entries, [
    { baseId: 0x0010E2D8, count: 1, extra: "reserved" },
    { baseId: 0x0000000f, count: 10 },
  ]);
  assert.deepEqual(taken.cuffEntry, { baseId: 0x0010E2D8, count: 1, extra: "reserved" });

  const targetNext = helpers.addCuff(target, taken.cuffEntry);
  assert.deepEqual(targetNext.entries, [
    { baseId: 0x0000000f, count: 5 },
    { baseId: 0x0010E2D8, count: 1, extra: "reserved" },
  ]);
});
