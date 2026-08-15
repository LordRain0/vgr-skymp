"use strict";

const assert = require("assert");
const test = require("node:test");
const identity = require("../gamemode_extensions/vgr_access_identity");

test("identity permissions use profileId owner and user matches", () => {
  const doc = {
    locked: true,
    owner: { profileId: 10, displayName: "Owner" },
    users: [{ profileId: 11, displayName: "User" }],
  };

  assert.equal(identity.isOwner(doc, 10), true);
  assert.equal(identity.isUser(doc, 11), true);
  assert.equal(identity.canAccess(doc, { profileId: 12 }, false), false);
  assert.equal(identity.canAccess(doc, { profileId: 11 }, false), false);
  assert.equal(identity.canAccess(doc, { profileId: 10 }, false), false);
  assert.equal(identity.canAccess(doc, { profileId: 12 }, true), false);
  assert.equal(identity.canManage(doc, { profileId: 10 }, false), true);
  assert.equal(identity.canManage(doc, { profileId: 11 }, false), false);
  assert.equal(identity.canManage(doc, { profileId: 12 }, true), true);
  assert.equal(identity.canToggleLock(doc, { profileId: 10 }, false), true);
  assert.equal(identity.canRemoveUser(doc, { profileId: 10 }, false), true);
  assert.equal(identity.canAddUser(doc, { profileId: 10 }, false), false);
  assert.equal(identity.canAddUser(doc, { profileId: 12 }, true), true);
  assert.equal(identity.canManageOwner(doc, { profileId: 10 }, false), false);
  assert.equal(identity.canManageOwner(doc, { profileId: 12 }, true), true);
});

test("unlocked objects are accessible but not manageable", () => {
  const doc = {
    locked: false,
    owner: { profileId: 10, displayName: "Owner" },
    users: [],
  };

  assert.equal(identity.canAccess(doc, { profileId: 22 }, false), true);
  assert.equal(identity.canManage(doc, { profileId: 22 }, false), false);
});

test("door pair ids are canonical regardless of side", () => {
  const mp = {
    getDescFromId(id) {
      return id === 1 ? "aaa:Skyrim.esm" : "bbb:Skyrim.esm";
    },
    getIdFromDesc(desc) {
      return desc.indexOf("aaa") === 0 ? 1 : 2;
    },
  };
  const doorPair = require("../gamemode_extensions/vgr_access_door_pair")(mp);

  assert.equal(
    doorPair.canonicalPairId("aaa:Skyrim.esm", "bbb:Skyrim.esm"),
    doorPair.canonicalPairId("bbb:Skyrim.esm", "aaa:Skyrim.esm")
  );
});

test("public character normalizes profileId and name", () => {
  assert.deepEqual(identity.publicCharacter({ profileId: "42", name: "Ada" }), {
    profileId: 42,
    displayName: "Ada",
  });
  assert.equal(identity.publicCharacter({ profileId: -1, name: "Bad" }), null);
});
