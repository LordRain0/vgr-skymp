// Minimal reader for Skyrim SE BSA archives (version 105).
// Supports uncompressed archives (the vanilla string BSAs are uncompressed)
// and per-file zlib compression as a fallback. Enough to extract the
// Strings/*.STRINGS localization files for the catalog generator.
'use strict';
const fs = require('fs');
const zlib = require('zlib');

// Trailing-name hash is not needed for extraction; we rely on the file-name
// block (archive flag bit1) which the vanilla string BSAs include.
function readBsa(bsaPath) {
  const buf = fs.readFileSync(bsaPath);
  let o = 0;
  const magic = buf.toString('ascii', 0, 4); o = 4;
  if (magic !== 'BSA\0') throw new Error('not a BSA: ' + bsaPath);
  const version = buf.readUInt32LE(o); o += 4;
  const folderRecordOffset = buf.readUInt32LE(o); o += 4;
  const archiveFlags = buf.readUInt32LE(o); o += 4;
  const folderCount = buf.readUInt32LE(o); o += 4;
  const fileCount = buf.readUInt32LE(o); o += 4;
  const totalFolderNameLength = buf.readUInt32LE(o); o += 4;
  const totalFileNameLength = buf.readUInt32LE(o); o += 4;
  const fileFlags = buf.readUInt32LE(o); o += 4;

  const includeDirNames = (archiveFlags & 0x1) !== 0;
  const includeFileNames = (archiveFlags & 0x2) !== 0;
  const defaultCompressed = (archiveFlags & 0x4) !== 0;
  if (!includeFileNames) throw new Error('BSA lacks file names, unsupported: ' + bsaPath);

  // Folder records. v105 folder record = uint64 hash, uint32 count, uint32 pad, uint64 offset.
  let fo = folderRecordOffset;
  const folders = [];
  for (let i = 0; i < folderCount; i++) {
    fo += 8; // hash
    const count = buf.readUInt32LE(fo); fo += 4;
    fo += 4; // padding (v105)
    const offset = Number(buf.readBigUInt64LE(fo)); fo += 8;
    folders.push({ count, fileRecordBlockOffset: offset });
  }

  // File record blocks. offset is measured from archive start but includes
  // totalFileNameLength; the actual block sits at offset - totalFileNameLength.
  const files = [];
  for (const folder of folders) {
    let p = folder.fileRecordBlockOffset - totalFileNameLength;
    let folderName = '';
    if (includeDirNames) {
      const len = buf.readUInt8(p); p += 1;
      folderName = buf.toString('latin1', p, p + len - 1); // strip trailing \0
      p += len;
    }
    for (let j = 0; j < folder.count; j++) {
      p += 8; // file name hash
      const rawSize = buf.readUInt32LE(p); p += 4;
      const dataOffset = buf.readUInt32LE(p); p += 4;
      // bit 30 (0x40000000) flips the archive default compression for this file
      const compressFlagged = (rawSize & 0x40000000) !== 0;
      const size = rawSize & 0x3FFFFFFF;
      const compressed = defaultCompressed !== compressFlagged;
      files.push({ folderName, size, dataOffset, compressed });
    }
  }

  // File name block: null-terminated names, one per file, in file order.
  let nameOffset = folderRecordOffset
    + folderCount * 24
    + (includeDirNames ? totalFolderNameLength + folderCount : 0)
    + fileCount * 16;
  for (let i = 0; i < fileCount; i++) {
    let end = nameOffset;
    while (buf[end] !== 0) end++;
    files[i].name = buf.toString('latin1', nameOffset, end);
    nameOffset = end + 1;
  }

  return {
    version, archiveFlags, fileFlags, folderCount, fileCount,
    files,
    extract(file) {
      let p = file.dataOffset;
      // bit8 (0x100) of archiveFlags = names embedded before each file's data
      if ((archiveFlags & 0x100) !== 0) {
        const len = buf.readUInt8(p); p += 1 + len;
      }
      if (file.compressed) {
        const originalSize = buf.readUInt32LE(p); p += 4;
        const comp = buf.subarray(p, file.dataOffset + file.size);
        try { return zlib.inflateSync(comp); }
        catch (e) { throw new Error('zlib inflate failed for ' + file.name + ' (LZ4 not supported): ' + e.message); }
      }
      return buf.subarray(p, p + file.size);
    }
  };
}

module.exports = { readBsa };
