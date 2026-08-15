"use strict";

const assert = require("assert");
const test = require("node:test");
const installActivationService = require("../gamemode_extensions/vgr_activation_service");

test("activation handlers run by priority and can block fallback activation", () => {
  const calls = [];
  const mp = {
    onActivate() {
      calls.push("fallback");
      return true;
    },
  };

  installActivationService(mp);
  mp.vgrRegisterActivateHandler("late", 100, () => {
    calls.push("late");
  });
  mp.vgrRegisterActivateHandler("early", 0, () => {
    calls.push("early");
    return false;
  });

  assert.equal(mp.onActivate(10, 20), false);
  assert.deepEqual(calls, ["early"]);
});

test("activation blockers run before feature handlers and can be queried directly", () => {
  const calls = [];
  const mp = {
    onActivate() {
      calls.push("fallback");
      return true;
    },
  };

  installActivationService(mp);
  mp.vgrRegisterActivateHandler("feature", 100, () => {
    calls.push("feature");
  });
  mp.vgrRegisterActivationBlocker("restraint", 0, () => {
    calls.push("restraint");
    return false;
  });

  assert.equal(mp.vgrIsActivationBlocked(10, 20), true);
  assert.equal(mp.onActivate(10, 20), false);
  assert.deepEqual(calls, ["restraint", "restraint"]);
});

test("default activation pass bypasses registered VGR handlers once", () => {
  const calls = [];
  let reentrantResult = null;
  const mp = {
    onActivate() {
      calls.push("fallback");
      return true;
    },
    getDescFromId(formId) {
      return String(formId);
    },
    callPapyrusFunction() {
      calls.push("papyrus");
      reentrantResult = mp.onActivate(10, 20);
    },
  };

  installActivationService(mp);
  mp.vgrRegisterActivateHandler("blocker", 0, () => {
    calls.push("blocker");
    return false;
  });

  mp.vgrRunDefaultActivate(10, 20);

  assert.equal(reentrantResult, true);
  assert.deepEqual(calls, ["papyrus", "fallback"]);
});
