"use strict";

const assert = require("assert");
const test = require("node:test");
const { trade } = require("../gamemode_extensions/vgr_helpers");

test("finalizeTrade swaps offered items and keeps unoffered stacks", () => {
  const invA = { entries: [{ baseId: 0x0000000f, count: 100 }, { baseId: 0x123, count: 2 }] };
  const invB = { entries: [{ baseId: 0x456, count: 1 }] };

  const result = trade.finalizeTrade(invA, invB, [{ baseId: 0x123, count: 2 }], [{ baseId: 0x456, count: 1 }]);

  assert.equal(trade.getItemCount(result.invA, 0x123), 0);
  assert.equal(trade.getItemCount(result.invA, 0x456), 1);
  assert.equal(trade.getItemCount(result.invB, 0x123), 2);
  assert.equal(trade.getItemCount(result.invB, 0x456), 0);
  assert.equal(trade.getItemCount(result.invA, 0x0000000f), 100);
});

test("finalizeTrade rejects an offer the inventory no longer covers", () => {
  const invA = { entries: [{ baseId: 0x123, count: 1 }] };
  const invB = { entries: [] };

  assert.throws(() => trade.finalizeTrade(invA, invB, [{ baseId: 0x123, count: 2 }], []));

  // Neither inventory may change when validation fails.
  assert.deepEqual(invA.entries, [{ baseId: 0x123, count: 1 }]);
  assert.deepEqual(invB.entries, []);
});

test("finalizeTrade moves a partial stack and leaves the remainder", () => {
  const invA = { entries: [{ baseId: 0x123, count: 20 }, { baseId: 0x0000000f, count: 50 }] };
  const invB = { entries: [] };

  const result = trade.finalizeTrade(invA, invB, [{ baseId: 0x123, count: 7 }], []);

  // A keeps 13 of the 20 stack, B receives exactly 7.
  assert.equal(trade.getItemCount(result.invA, 0x123), 13);
  assert.equal(trade.getItemCount(result.invB, 0x123), 7);
  assert.equal(trade.getItemCount(result.invA, 0x0000000f), 50);
  assert.deepEqual(result.invB.entries, [{ baseId: 0x123, count: 7 }]);
});

test("worn items are not counted as tradable at finalize", () => {
  const inv = { entries: [{ baseId: 0x123, count: 1, worn: true }, { baseId: 0x123, count: 1 }] };

  assert.equal(trade.getItemCount(inv, 0x123), 1);
  assert.throws(() => trade.finalizeTrade(inv, { entries: [] }, [{ baseId: 0x123, count: 2 }], []));
});
