import * as fontkit from "fontkit";
import type { FontFormat } from "@/lib/contract";
import type { FontBinaryMeta } from "../types";
import { CONTROL_CHARS } from "./names";

type NameRecords = Partial<Record<string, Partial<Record<string, unknown>>>>;

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
 * fontkit can read (EOT, truncated or corrupt files, anything else).
 */
export function parseFontBinary(buffer: Buffer): FontBinaryMeta | null {
  try {
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
