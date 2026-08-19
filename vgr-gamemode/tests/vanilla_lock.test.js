"use strict";

const assert = require("assert");
const test = require("node:test");
const installAccessControl = require("../gamemode_extensions/vgr_access_control");

// Synthetic XLOC subrecord: uint8 lock level at offset 0, 3 padding bytes,
// uint32LE local key formId at offset 4, uint32LE flags at offset 8.
function xlocBytes(lockLevel, localKeyId, flags) {
  const buffer = Buffer.alloc(12);
  buffer.writeUInt8(lockLevel & 0xff, 0);
  buffer.writeUInt32LE((localKeyId || 0) >>> 0, 4);
  buffer.writeUInt32LE((flags || 0) >>> 0, 8);
  return new Uint8Array(buffer);
}

function install(options) {
  const opts = options || {};
  const calls = { lookups: 0 };
  const config = Object.assign({ adminProfileIds: [1] }, opts.config || {});
  const mp = {
    getServerSettings: () => ({ vgrAccessControl: config }),
    makeProperty: () => {},
    makeEventSource: () => {},
    on: () => {},
    getDescFromId: (id) => String(id) + ":Test.esp",
    getIdFromDesc: () => 0,
    get: opts.get || (() => null),
    set: () => {},
    callPapyrusFunction: () => {},
    lookupEspmRecordById: (formId) => {
      calls.lookups += 1;
      return opts.lookup ? opts.lookup(formId) : {};
    },
  };
  installAccessControl(mp);
  return { mp, api: mp._vgrAccessControlApi, calls };
}

test("getVanillaLock parses XLOC and converts the local key id to global", () => {
  const { api, calls } = install({
    lookup: () => ({
      record: {
        id: 0x1234,
        type: "REFR",
        fields: [
          { type: "EDID", data: new Uint8Array([0x41, 0x00]) },
          { type: "XLOC", data: xlocBytes(255, 0x0000abcd, 0) },
        ],
      },
      fileIndex: 5,
      toGlobalRecordId: (localId) => (0x05000000 | localId) >>> 0,
    }),
  });

  const lock = api.getVanillaLock(0x1234);
  assert.deepEqual(lock, { lockLevel: 255, keyFormId: 0x0500abcd });

  // REFR lock data is static, so the second call must hit the cache.
  assert.deepEqual(api.getVanillaLock(0x1234), lock);
  assert.equal(calls.lookups, 1);
});

test("records without XLOC cache as null", () => {
  const { api, calls } = install({
    lookup: () => ({
      record: { id: 0x2222, type: "REFR", fields: [{ type: "XTEL", data: new Uint8Array(32) }] },
      toGlobalRecordId: (localId) => localId,
    }),
  });

  assert.equal(api.getVanillaLock(0x2222), null);
  assert.equal(api.getVanillaLock(0x2222), null);
  assert.equal(calls.lookups, 1);
});

test("truncated XLOC data is rejected defensively", () => {
  const { api } = install({
    lookup: () => ({
      record: { id: 0x3333, type: "REFR", fields: [{ type: "XLOC", data: new Uint8Array([255, 0, 0, 0]) }] },
      toGlobalRecordId: (localId) => localId,
    }),
  });

  assert.equal(api.getVanillaLock(0x3333), null);
});

test("keyOnly policy blocks only key-required locks", () => {
  const doors = {
    100: xlocBytes(50, 0, 0),
    200: xlocBytes(255, 0x0000abcd, 0),
  };
  const { api } = install({
    lookup: (formId) => ({
      record: { id: formId, type: "REFR", fields: [{ type: "XLOC", data: doors[formId] }] },
      toGlobalRecordId: (localId) => (0x05000000 | localId) >>> 0,
    }),
  });

  assert.equal(api.isVanillaLockBlocked(100, 900), false);
  assert.equal(api.isVanillaLockBlocked(200, 900), true);
});

test("holding the key in the server-side inventory bypasses the block", () => {
  const { api } = install({
    lookup: () => ({
      record: { id: 0x4444, type: "REFR", fields: [{ type: "XLOC", data: xlocBytes(255, 0x0000abcd, 0) }] },
      toGlobalRecordId: (localId) => (0x05000000 | localId) >>> 0,
    }),
    get: (formId, prop) => {
      if (prop === "inventory" && formId === 900) return { entries: [{ baseId: 0x0500abcd, count: 1 }] };
      if (prop === "inventory" && formId === 901) return { entries: [{ baseId: 0x0500abcd, count: 0 }] };
      return null;
    },
  });

  assert.equal(api.isVanillaLockBlocked(0x4444, 900), false);
  assert.equal(api.isVanillaLockBlocked(0x4444, 901), true);
  assert.equal(api.isVanillaLockBlocked(0x4444, 902), true);
});

test("all policy blocks every locked door and off disables enforcement", () => {
  const lookup = (formId) => ({
    record: { id: formId, type: "REFR", fields: [{ type: "XLOC", data: xlocBytes(25, 0, 0) }] },
    toGlobalRecordId: (localId) => localId,
  });

  const all = install({ config: { vanillaLockPolicy: "all" }, lookup });
  assert.equal(all.api.isVanillaLockBlocked(300, 900), true);

  const off = install({ config: { vanillaLockPolicy: "off" }, lookup });
  assert.equal(off.api.isVanillaLockBlocked(300, 900), false);
});
