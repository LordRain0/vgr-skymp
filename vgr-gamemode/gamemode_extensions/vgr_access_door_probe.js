"use strict";

module.exports = (mp, config, runtime) => {
  const LOG = "[VGR access probe]";
  const enabled = config && config.doorPairProbe && config.doorPairProbe.enabled === true;
  const allowStartup = enabled && Array.isArray(config.doorPairProbe.formDescs);
  const doorPair = require("./vgr_access_door_pair")(mp);

  function probeByFormDesc(formDesc) {
    const desc = String(formDesc || "");
    const report = {
      mode: "formDesc",
      formDesc: desc,
      timestamp: new Date().toISOString(),
      result: null,
    };
    if (!enabled) {
      report.result = { error: "Probe disabled" };
      return report;
    }
    let targetFormId = 0;
    try {
      targetFormId = mp.getIdFromDesc(desc);
    } catch (e) {
      report.result = { error: "Could not resolve formDesc" };
      return report;
    }
    const passage = doorPair.resolveDoorPassage(targetFormId, runtime.getObjectMeta);
    report.result = passage.error ? { error: passage.error } : passage;
    return report;
  }

  function probeByRuntimeFormId(targetFormId) {
    let formDesc = "";
    try {
      formDesc = mp.getDescFromId(targetFormId);
    } catch (e) {
      formDesc = "";
    }
    const report = probeByFormDesc(formDesc);
    report.mode = "runtime";
    report.targetFormId = targetFormId;
    return report;
  }

  function logReport(report) {
    console.log(LOG, JSON.stringify(report, null, 2));
  }

  const api = { probeByFormDesc, probeByRuntimeFormId, logReport };
  mp._vgrAccessDoorProbe = api;

  if (allowStartup) {
    setTimeout(() => {
      for (const formDesc of config.doorPairProbe.formDescs) logReport(probeByFormDesc(formDesc));
    }, Math.max(1000, Number(config.doorPairProbe.startupDelayMs) || 2500));
  }

  return api;
};
