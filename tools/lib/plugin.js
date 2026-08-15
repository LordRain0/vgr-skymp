// Minimal Skyrim SE plugin (esm/esp/esl) parser: walks GRUP groups, yields
// target records with their EDID and FULL (raw). Handles zlib-compressed
// records. Does not resolve strings or formIds - callers do that with the
// load-order slot map.
'use strict';
const fs = require('fs');
const zlib = require('zlib');

const REC_HEADER = 24; // SSE record header size
const GRUP_HEADER = 24;

// flags
const FLAG_COMPRESSED = 0x00040000;
const TES4_LOCALIZED = 0x00000080;
const TES4_LIGHT = 0x00000200;

// Parse just the TES4 header: masters[], localized, light.
function parseHeader(buf, isEslExt) {
  if (buf.toString('ascii', 0, 4) !== 'TES4') throw new Error('not a plugin (no TES4)');
  const dataSize = buf.readUInt32LE(4);
  const flags = buf.readUInt32LE(8);
  const masters = [];
  let o = REC_HEADER;
  const end = REC_HEADER + dataSize;
  while (o < end) {
    const type = buf.toString('ascii', o, o + 4);
    const size = buf.readUInt16LE(o + 4);
    const dataStart = o + 6;
    if (type === 'MAST') {
      let e = dataStart;
      while (e < dataStart + size && buf[e] !== 0) e++;
      masters.push(buf.toString('latin1', dataStart, e));
    }
    o = dataStart + size;
  }
  return {
    masters,
    localized: (flags & TES4_LOCALIZED) !== 0,
    light: isEslExt || (flags & TES4_LIGHT) !== 0,
    headerEnd: REC_HEADER + dataSize
  };
}

// Read EDID + FULL subrecords out of a record's (decompressed) field block.
// When collectTypes (a Set of 4-char tags) is given, also returns fields:
// [{type, data}] for every matching subrecord IN ORDER (order matters for
// EFID/EFIT effect pairs).
function readEdidFull(fieldBuf, collectTypes) {
  let o = 0;
  let editorId = null;
  let full = null; // Buffer of the FULL field (4 bytes if localized, else zstring)
  let overrideSize = 0;
  const fields = collectTypes ? [] : null;
  while (o + 6 <= fieldBuf.length) {
    const type = fieldBuf.toString('ascii', o, o + 4);
    let size = fieldBuf.readUInt16LE(o + 4);
    let dataStart = o + 6;
    if (type === 'XXXX') {
      overrideSize = fieldBuf.readUInt32LE(dataStart);
      o = dataStart + size;
      continue;
    }
    if (overrideSize) { size = overrideSize; overrideSize = 0; }
    if (type === 'EDID') {
      let e = dataStart;
      while (e < dataStart + size && fieldBuf[e] !== 0) e++;
      editorId = fieldBuf.toString('latin1', dataStart, e);
    } else if (type === 'FULL') {
      full = fieldBuf.subarray(dataStart, dataStart + size);
    }
    if (collectTypes && collectTypes.has(type)) {
      fields.push({ type, data: fieldBuf.subarray(dataStart, dataStart + size) });
    }
    o = dataStart + size;
    if (!collectTypes && editorId !== null && full !== null) break;
  }
  return { editorId, full, fields };
}

// Walk the file, invoking cb(record) for each record whose type is in `types`.
// record = { type, formId (local), editorId, full (Buffer|null) }
// opts.collectFields: {RECTYPE: Set(subrecord tags)} - when the record type has
// an entry, cb receives rec.fields = ordered [{type, data}] for those tags.
function walkRecords(buf, types, cb, opts) {
  const wanted = new Set(types);
  const collectFor = (opts && opts.collectFields) || null;
  const fileEnd = buf.length;

  function walkGroup(start, end) {
    let o = start;
    while (o + REC_HEADER <= end) {
      const tag = buf.toString('ascii', o, o + 4);
      if (tag === 'GRUP') {
        const groupSize = buf.readUInt32LE(o + 4); // includes header
        walkGroup(o + GRUP_HEADER, o + groupSize);
        o += groupSize;
      } else {
        const dataSize = buf.readUInt32LE(o + 4);
        const flags = buf.readUInt32LE(o + 8);
        const formId = buf.readUInt32LE(o + 12);
        const dataStart = o + REC_HEADER;
        if (wanted.has(tag)) {
          let fieldBuf = buf.subarray(dataStart, dataStart + dataSize);
          if (flags & FLAG_COMPRESSED) {
            // compressed record: uint32 decompSize + zlib stream
            try { fieldBuf = zlib.inflateSync(buf.subarray(dataStart + 4, dataStart + dataSize)); }
            catch (e) { fieldBuf = Buffer.alloc(0); }
          }
          const collect = collectFor && collectFor[tag];
          const { editorId, full, fields } = readEdidFull(fieldBuf, collect);
          cb({ type: tag, formId, editorId, full, fields });
        }
        o = dataStart + dataSize;
      }
    }
  }

  // Top level: skip the TES4 header record, then walk top groups.
  const tes4Size = buf.readUInt32LE(4);
  walkGroup(REC_HEADER + tes4Size, fileEnd);
}

function loadPlugin(pluginPath) {
  const buf = fs.readFileSync(pluginPath);
  const isEslExt = /\.esl$/i.test(pluginPath);
  const header = parseHeader(buf, isEslExt);
  return { buf, header };
}

module.exports = { loadPlugin, walkRecords, readEdidFull };
