"use strict";

module.exports = (mp) => {
  const hex = (value) => (Number(value) >>> 0).toString(16).toUpperCase().padStart(8, "0");

  function formDescFromNumericId(id, fileHint) {
    try {
      const desc = mp.getDescFromId(id);
      if (desc) return String(desc);
    } catch (e) {
      // Fall back below.
    }
    if (fileHint) return hex(id).replace(/^0+/, "").toLowerCase() + ":" + fileHint;
    return null;
  }

  function toByteArray(data) {
    if (data == null) return null;
    if (Array.isArray(data)) return data.map((b) => Number(b) & 0xff);
    if (typeof Buffer !== "undefined" && Buffer.isBuffer(data)) return Array.from(data);
    if (typeof data === "object") {
      const keys = Object.keys(data).filter((key) => /^\d+$/.test(key)).sort((a, b) => Number(a) - Number(b));
      if (keys.length) return keys.map((key) => Number(data[key]) & 0xff);
    }
    return null;
  }

  function readUint32LE(bytes, offset) {
    return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
  }

  function readFloatLE(bytes, offset) {
    if (typeof Buffer !== "undefined") return Buffer.from(bytes.slice(offset, offset + 4)).readFloatLE(0);
    const view = new DataView(Uint8Array.from(bytes.slice(offset, offset + 4)).buffer);
    return view.getFloat32(0, true);
  }

  function parseXtelBytes(bytes, fileHint) {
    if (!bytes || bytes.length < 32) return { error: "XTEL data too short", byteLength: bytes ? bytes.length : 0 };
    const destFormId = readUint32LE(bytes, 0);
    return {
      destFormId,
      destFormIdHex: hex(destFormId),
      destFormDesc: formDescFromNumericId(destFormId, fileHint),
      position: [readFloatLE(bytes, 4), readFloatLE(bytes, 8), readFloatLE(bytes, 12)],
      rotation: [readFloatLE(bytes, 16), readFloatLE(bytes, 20), readFloatLE(bytes, 24)],
      flags: readUint32LE(bytes, 28),
    };
  }

  function fieldTypeName(field, index) {
    if (!field || typeof field !== "object") return "field" + index;
    return String(field.type || field.magic || field.name || field.recordType || "field" + index);
  }

  function extractXtelFromRecord(record, fileHint) {
    if (!record || !Array.isArray(record.fields)) return null;

    for (let i = 0; i < record.fields.length; i++) {
      const field = record.fields[i];
      const type = fieldTypeName(field, i).toUpperCase();
      const bytes = toByteArray(field.data);
      if (type === "XTEL" && bytes) {
        const parsed = parseXtelBytes(bytes, fileHint);
        if (!parsed.error) return parsed;
      }
    }

    for (let i = 0; i < record.fields.length; i++) {
      const bytes = toByteArray(record.fields[i] && record.fields[i].data);
      if (!bytes || bytes.length < 32) continue;
      const candidate = parseXtelBytes(bytes, fileHint);
      if (candidate.error) continue;
      const dest = candidate.destFormId || 0;
      const valid =
        dest > 0x100 &&
        dest < 0xf00000 &&
        candidate.position.every((n) => Number.isFinite(n) && Math.abs(n) < 100000) &&
        candidate.rotation.every((n) => Number.isFinite(n) && Math.abs(n) <= Math.PI * 2 + 0.01);
      if (valid) return candidate;
    }

    return null;
  }

  function lookupXtelForFormDesc(formDesc) {
    const desc = String(formDesc || "");
    const fileHint = desc.split(":")[1] || "Skyrim.esm";
    try {
      const lookup = mp.lookupEspmRecordById(mp.getIdFromDesc(desc));
      if (!lookup || !lookup.record) return { error: "ESPM record not found" };
      const xtel = extractXtelFromRecord(lookup.record, fileHint);
      if (!xtel || xtel.error) return { error: "No XTEL teleport link on this door" };
      if (!xtel.destFormDesc) return { error: "Could not resolve paired door formDesc" };
      return { xtel, fileHint };
    } catch (e) {
      return { error: String(e && e.message ? e.message : e) };
    }
  }

  function canonicalPairId(formDescA, formDescB) {
    const a = String(formDescA || "");
    const b = String(formDescB || "");
    return a < b ? "door:" + a + "|" + b : "door:" + b + "|" + a;
  }

  function numericIdFromFormDesc(formDesc) {
    const desc = String(formDesc || "");
    try {
      return mp.getIdFromDesc(desc);
    } catch (e) {
      return parseInt(desc.split(":")[0], 16) || 0;
    }
  }

  function buildRefEntry(formDesc, getObjectMeta, runtimeFormId) {
    const desc = String(formDesc || "");
    let numericId = numericIdFromFormDesc(desc);
    if (runtimeFormId != null && runtimeFormId !== 0) {
      try {
        if (String(mp.getDescFromId(runtimeFormId) || "").toLowerCase() === desc.toLowerCase()) numericId = runtimeFormId;
      } catch (e) {
        // Keep numericId from descriptor.
      }
    }

    let worldOrCellDesc = "";
    let position = [0, 0, 0];
    try {
      const meta = getObjectMeta(numericId) || {};
      worldOrCellDesc = meta.worldOrCellDesc || "";
      position = Array.isArray(meta.position) ? meta.position : [0, 0, 0];
    } catch (e) {
      // Runtime metadata is best effort for the inactive side of teleport pairs.
    }

    return { formDesc: desc, formIdHex: hex(numericId), worldOrCellDesc, position };
  }

  function resolveDoorPassage(targetFormId, getObjectMeta) {
    let sourceFormDesc = "";
    try {
      sourceFormDesc = String(mp.getDescFromId(targetFormId) || "");
    } catch (e) {
      return { error: "Could not resolve door formDesc" };
    }
    if (!sourceFormDesc) return { error: "Could not resolve door formDesc" };

    const link = lookupXtelForFormDesc(sourceFormDesc);
    if (link.error) {
      return {
        objectId: "door:" + sourceFormDesc,
        refs: [buildRefEntry(sourceFormDesc, getObjectMeta, targetFormId)],
        teleport: false,
        linksBack: false,
        activatedFormDesc: sourceFormDesc,
        error: link.error,
      };
    }

    const destFormDesc = link.xtel.destFormDesc;
    const reverse = lookupXtelForFormDesc(destFormDesc);
    const linksBack = !reverse.error &&
      reverse.xtel &&
      String(reverse.xtel.destFormDesc || "").toLowerCase() === sourceFormDesc.toLowerCase();

    return {
      objectId: canonicalPairId(sourceFormDesc, destFormDesc),
      refs: [
        buildRefEntry(sourceFormDesc, getObjectMeta, targetFormId),
        buildRefEntry(destFormDesc, getObjectMeta),
      ],
      teleport: true,
      linksBack,
      activatedFormDesc: sourceFormDesc,
      pairedFormDesc: destFormDesc,
    };
  }

  return {
    buildRefEntry,
    canonicalPairId,
    extractXtelFromRecord,
    hex,
    lookupXtelForFormDesc,
    resolveDoorPassage,
  };
};
