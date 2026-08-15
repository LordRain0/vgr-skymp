// Parser for Skyrim .STRINGS / .ILSTRINGS / .DLSTRINGS localization tables.
// Returns a Map<stringId, string>. FULL (names) live in .STRINGS; DESC/long
// text live in .IL/.DLSTRINGS - both share the directory format, differing
// only in whether the data block prefixes each string with a uint32 length.
'use strict';

function parseStrings(buf, isLengthPrefixed) {
  const count = buf.readUInt32LE(0);
  const dataSize = buf.readUInt32LE(4);
  const dirStart = 8;
  const dataStart = dirStart + count * 8;
  const map = new Map();
  for (let i = 0; i < count; i++) {
    const p = dirStart + i * 8;
    const stringId = buf.readUInt32LE(p);
    const offset = buf.readUInt32LE(p + 4);
    let s = dataStart + offset;
    if (isLengthPrefixed) {
      const len = buf.readUInt32LE(s); s += 4;
      // len includes the trailing null
      map.set(stringId, buf.toString('latin1', s, s + Math.max(0, len - 1)));
    } else {
      let end = s;
      while (end < buf.length && buf[end] !== 0) end++;
      map.set(stringId, buf.toString('latin1', s, end));
    }
  }
  return map;
}

module.exports = { parseStrings };
