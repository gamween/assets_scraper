import { inflateRawSync } from "node:zlib";
import * as fontkit from "fontkit";
import type { FontFormat } from "@/lib/contract";
import type { FontBinaryMeta } from "../types";
import { CONTROL_CHARS } from "./names";

type NameRecords = Partial<Record<string, Partial<Record<string, unknown>>>>;

const KIB = 1024;
const MIB = 1024 * KIB;
/**
 * Bounds on what fontkit may decompress for one WOFF or WOFF2 file. fontkit allocates the table sizes a file declares
 * and decompresses them synchronously in JavaScript, where neither the scan deadline nor an abort signal can stop it:
 * a WOFF2 file of 265 bytes can declare 256 MiB. Web fonts decompress to less than 4 times their file size.
 */
const MAX_DECOMPRESSED_BYTES = 32 * MIB;
const MAX_EXPANSION = 16;
const MIN_DECOMPRESSED_ALLOWANCE = 16 * KIB;

const WOFF_HEADER_BYTES = 44;
const WOFF_TABLE_ENTRY_BYTES = 20;
const WOFF2_HEADER_BYTES = 48;
/** WOFF2 table directory flags: known tag indexes of `glyf` and `loca`, and the index of an explicit tag. */
const WOFF2_GLYF = 10;
const WOFF2_LOCA = 11;
const WOFF2_CUSTOM_TAG = 0x3f;

/** Font format from the file signature, whatever the URL or content type says. */
export function sniffFontFormat(buffer: Buffer): FontFormat {
  if (buffer.length >= 4) {
    const tag = buffer.toString("latin1", 0, 4);
    if (tag === "wOF2") return "woff2";
    if (tag === "wOFF") return "woff";
    if (tag === "OTTO") return "otf";
    if (tag === "true" || tag === "typ1" || buffer.readUInt32BE(0) === 0x00010000) return "ttf";
  }
  // EOT: MagicNumber 0x504C at offset 34, little-endian
  if (buffer.length >= 36 && buffer.readUInt16LE(34) === 0x504c) return "eot";
  return "other";
}

/**
 * Whether fontkit can open the file without decompressing more than the file could reasonably hold. Uncompressed
 * formats always can. A WOFF or WOFF2 file must declare at most 16 times its own size (16 KiB for tiny files) and at
 * most 32 MiB, counted from its header and table directory as fontkit reads them. Each zlib-compressed WOFF table must
 * also inflate completely within its declared size: native zlib checks that first, because fontkit's JavaScript
 * inflate keeps decoding past the output it allocated and never returns on a truncated stream. WOFF2 needs no such
 * check: fontkit's brotli decoder throws as soon as its output passes the declared size.
 */
export function withinDecompressionLimits(buffer: Buffer): boolean {
  const format = sniffFontFormat(buffer);
  if (format !== "woff" && format !== "woff2") return true;
  const allowance = Math.min(MAX_DECOMPRESSED_BYTES, Math.max(MIN_DECOMPRESSED_ALLOWANCE, buffer.length * MAX_EXPANSION));
  return format === "woff2" ? woff2WithinLimits(buffer, allowance) : woffWithinLimits(buffer, allowance);
}

/** WOFF2: `totalSfntSize` and the sum fontkit decompresses, each table's `transformLength` or else `origLength`. */
function woff2WithinLimits(buffer: Buffer, allowance: number): boolean {
  if (buffer.length < WOFF2_HEADER_BYTES || buffer.readUInt32BE(16) > allowance) return false;
  let pos = WOFF2_HEADER_BYTES;
  // UIntBase128 with fontkit's 32-bit arithmetic, so a length reads as the same number. -1 when fontkit throws.
  const readBase128 = (): number => {
    let result = 0;
    for (let i = 0; i < 5 && pos < buffer.length; i += 1) {
      const code = buffer[pos++];
      if (result & 0xe0000000) return -1;
      result = (result << 7) | (code & 0x7f);
      if (!(code & 0x80)) return result;
    }
    return -1;
  };
  let total = 0;
  for (let tables = buffer.readUInt16BE(12); tables > 0; tables -= 1) {
    if (pos >= buffer.length) return false;
    const flags = buffer[pos++];
    const index = flags & 0x3f;
    let glyfOrLoca = index === WOFF2_GLYF || index === WOFF2_LOCA;
    if (index === WOFF2_CUSTOM_TAG) {
      const tag = buffer.toString("latin1", pos, pos + 4);
      glyfOrLoca = tag === "glyf" || tag === "loca";
      pos += 4;
    }
    const origLength = readBase128();
    // `glyf` and `loca` are transformed with transform version 0, other tables with any other version
    const transformed = glyfOrLoca ? flags >>> 6 === 0 : flags >>> 6 !== 0;
    const size = transformed ? readBase128() : origLength;
    if (origLength < 0 || size < 0) return false;
    total += size;
    if (total > allowance) return false;
  }
  return true;
}

/** WOFF: `totalSfntSize`, the sum of `origLength`, and a bounded native inflate of each compressed table. */
function woffWithinLimits(buffer: Buffer, allowance: number): boolean {
  if (buffer.length < WOFF_HEADER_BYTES || buffer.readUInt32BE(16) > allowance) return false;
  const tables = buffer.readUInt16BE(12);
  if (buffer.length < WOFF_HEADER_BYTES + tables * WOFF_TABLE_ENTRY_BYTES) return false;
  let total = 0;
  for (let index = 0; index < tables; index += 1) {
    const entry = WOFF_HEADER_BYTES + index * WOFF_TABLE_ENTRY_BYTES;
    const offset = buffer.readUInt32BE(entry + 4);
    const compLength = buffer.readUInt32BE(entry + 8);
    const origLength = buffer.readUInt32BE(entry + 12);
    total += origLength;
    if (total > allowance) return false;
    // fontkit reads a table stored uncompressed in place
    if (compLength >= origLength) continue;
    try {
      // fontkit skips the 2-byte zlib header and inflates the rest of `compLength` bytes into `origLength` bytes
      inflateRawSync(buffer.subarray(offset + 2, offset + compLength), { maxOutputLength: origLength });
    } catch {
      return false;
    }
  }
  return true;
}

const safely = <T>(read: () => T): T | undefined => {
  try {
    return read();
  } catch {
    return undefined;
  }
};

/**
 * Reads what the scan needs from a font file with fontkit: name records 0, 1, 2, 4, 6, 13, 14, 16, 17 and 21,
 * `fvar` axes, `OS/2` weight class and whether "A" and "a" have glyphs. Returns null when the bytes are not a font
 * fontkit can read (EOT, truncated or corrupt files, anything else), and for WOFF and WOFF2 files that declare more
 * decompressed bytes than `withinDecompressionLimits` allows (decompression bombs).
 */
export function parseFontBinary(buffer: Buffer): FontBinaryMeta | null {
  try {
    if (!withinDecompressionLimits(buffer)) return null;
    const created = fontkit.create(buffer);
    const font = "fonts" in created ? created.fonts[0] : created;
    if (!font) return null;
    // `name` and `maxp` are required tables. fontkit swallows some decoding errors (a truncated WOFF2 gives a font
    // without tables), so a file where either cannot be read is not a font. `name` is not in the fontkit typings.
    const nameTable = (font as unknown as { name?: { records?: NameRecords } }).name;
    if (!nameTable || !(font.numGlyphs > 0)) return null;
    const records: NameRecords = nameTable.records ?? {};
    const pick = (key: string): string | undefined => {
      const record = records[key];
      if (!record) return undefined;
      const value = record.en ?? record["en-US"] ?? Object.values(record)[0];
      if (typeof value !== "string") return undefined;
      return value.replace(CONTROL_CHARS, "").trim() || undefined;
    };
    const axes = Object.entries(safely(() => font.variationAxes) ?? {}).flatMap(([tag, axis]) =>
      axis ? [{ tag, min: axis.min, max: axis.max, default: axis.default }] : [],
    );
    const weightClass = safely(() => font["OS/2"]?.usWeightClass);
    const coversLatin = safely(() => font.hasGlyphForCodePoint(0x41) && font.hasGlyphForCodePoint(0x61));
    const typoFamily = pick("preferredFamily");
    const nameId1 = pick("fontFamily");
    const meta: FontBinaryMeta = {
      format: sniffFontFormat(buffer),
      familyName: typoFamily ?? nameId1,
      subfamilyName: pick("preferredSubfamily") ?? pick("fontSubfamily"),
      fullName: pick("fullName"),
      postscriptName: pick("postscriptName"),
      typoFamily,
      wwsFamily: pick("wwsFamilyName"),
      nameId1,
      copyright: pick("copyright"),
      licenseDescription: pick("license"),
      licenseUrl: pick("licenseURL"),
      axes: axes.length ? axes : undefined,
      weightClass: typeof weightClass === "number" ? weightClass : undefined,
      coversLatin,
    };
    return Object.fromEntries(Object.entries(meta).filter(([, value]) => value !== undefined)) as unknown as FontBinaryMeta;
  } catch {
    return null;
  }
}
