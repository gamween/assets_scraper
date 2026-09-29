import { inflateSync } from "node:zlib";

/**
 * WOFF (version 1) to the sfnt it wraps, which is what the font installer writes (spec 5.2). wawoff2 only reads WOFF2,
 * so a family a page serves as `.woff` alone was reported installable by the scan summary and then always failed to
 * install with `conversion-failed`.
 *
 * WOFF 1 is the sfnt with each table optionally zlib compressed (W3C WOFF File Format 1.0): the header names the sfnt
 * flavor, and every directory entry gives a table's tag, its offset and compressed length in the WOFF file, and its
 * original length and checksum. Undoing it is rebuilding the sfnt table directory and inflating each table back to its
 * original length, so the result holds the very bytes the font was made of, checksums included.
 */

const WOFF_SIGNATURE = 0x774f4646; // "wOFF"
const HEADER_BYTES = 44;
const ENTRY_BYTES = 20;
const SFNT_HEADER_BYTES = 12;
const SFNT_ENTRY_BYTES = 16;
/** More tables than any real font has, and a bound on the directory a hostile file can make this walk. */
const MAX_TABLES = 1_024;

/**
 * `length` rounded up to the 4 byte boundary every sfnt table starts on. Plain arithmetic, not `(length + 3) & ~3`: a
 * directory entry is a 32 bit unsigned length, and the bitwise form wraps a length near 4 GB to 0 or below, which let
 * such a table past the bound and into an inflate with a 4 GB ceiling.
 */
const padded = (length: number): number => Math.ceil(length / 4) * 4;

interface Table {
  tag: number;
  checksum: number;
  data: Buffer;
  /** Where the table sits in the WOFF file, which is the order the sfnt lays the tables out in too. */
  offset: number;
}

/**
 * The sfnt bytes of a WOFF file, or null when it is not one this can read: a bad signature or directory, a table outside
 * the file, a compressed stream that does not inflate to exactly its original length, or more than `maxBytes` of sfnt.
 * The bound is checked from the directory before anything is allocated, and again on every inflate.
 */
export function woffToSfnt(source: Buffer, maxBytes: number): Buffer | null {
  if (source.length < HEADER_BYTES || source.readUInt32BE(0) !== WOFF_SIGNATURE) return null;
  const flavor = source.readUInt32BE(4);
  const count = source.readUInt16BE(12);
  if (count === 0 || count > MAX_TABLES || source.length < HEADER_BYTES + count * ENTRY_BYTES) return null;

  let total = SFNT_HEADER_BYTES + count * SFNT_ENTRY_BYTES;
  const entries: { tag: number; offset: number; compLength: number; origLength: number; checksum: number }[] = [];
  for (let index = 0; index < count; index += 1) {
    const at = HEADER_BYTES + index * ENTRY_BYTES;
    const entry = {
      tag: source.readUInt32BE(at),
      offset: source.readUInt32BE(at + 4),
      compLength: source.readUInt32BE(at + 8),
      origLength: source.readUInt32BE(at + 12),
      checksum: source.readUInt32BE(at + 16),
    };
    // A table is stored as it is or compressed smaller, never larger, and always inside the file.
    if (entry.compLength > entry.origLength || entry.offset + entry.compLength > source.length) return null;
    total += padded(entry.origLength);
    if (total > maxBytes) return null;
    entries.push(entry);
  }
  if (new Set(entries.map((entry) => entry.tag)).size !== entries.length) return null;

  const tables: Table[] = [];
  for (const entry of entries) {
    const stored = source.subarray(entry.offset, entry.offset + entry.compLength);
    let data: Buffer;
    if (entry.compLength === entry.origLength) {
      data = stored;
    } else {
      try {
        data = inflateSync(stored, { maxOutputLength: Math.max(1, entry.origLength) });
      } catch {
        return null;
      }
      if (data.length !== entry.origLength) return null;
    }
    tables.push({ tag: entry.tag, checksum: entry.checksum, data, offset: entry.offset });
  }

  const sfnt = Buffer.alloc(total);
  const selector = Math.floor(Math.log2(count));
  const searchRange = 2 ** selector * SFNT_ENTRY_BYTES;
  sfnt.writeUInt32BE(flavor, 0);
  sfnt.writeUInt16BE(count, 4);
  sfnt.writeUInt16BE(searchRange, 6);
  sfnt.writeUInt16BE(selector, 8);
  sfnt.writeUInt16BE(count * SFNT_ENTRY_BYTES - searchRange, 10);

  // The directory is sorted by tag, as the sfnt format requires; the table data keeps the order it had in the file.
  const byTag = [...tables].sort((a, b) => a.tag - b.tag);
  const placed = new Map<Table, number>();
  let cursor = SFNT_HEADER_BYTES + count * SFNT_ENTRY_BYTES;
  for (const table of [...tables].sort((a, b) => a.offset - b.offset)) {
    table.data.copy(sfnt, cursor);
    placed.set(table, cursor);
    cursor += padded(table.data.length);
  }
  byTag.forEach((table, index) => {
    const at = SFNT_HEADER_BYTES + index * SFNT_ENTRY_BYTES;
    sfnt.writeUInt32BE(table.tag, at);
    sfnt.writeUInt32BE(table.checksum, at + 4);
    sfnt.writeUInt32BE(placed.get(table) ?? 0, at + 8);
    sfnt.writeUInt32BE(table.data.length, at + 12);
  });
  return sfnt;
}
