import { readFileSync } from "node:fs";
import path from "node:path";
import { brotliDecompressSync, deflateSync } from "node:zlib";
import * as fontkit from "fontkit";
import { describe, expect, it, vi } from "vitest";
import { parseFontBinary, sniffFontFormat, withinDecompressionLimits } from "./binary";

vi.mock("fontkit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fontkit")>();
  return { ...actual, create: vi.fn(actual.create) };
});

const asset = (name: string) => readFileSync(path.join(process.cwd(), "tests/fixtures/site/assets", name));
const MIB = 1024 * 1024;

/** 256 MiB of zeros in 211 bytes: `brotliCompressSync(Buffer.alloc(2 ** 28))` with a 24-bit window. */
const BROTLI_256_MIB_OF_ZEROS = Buffer.from(
  "z///f/gnAOKxQCD3/p/////wTwDEYQGA7v0/////4Z8AiMMiAN37f/7//8M/ARCHBQC69//8//+HfwIgDgsAdO//+f//D/8EQBwWAOje//P//x/+CYA4LADQvf/n//8//BMAcVgAoHv/z///f/gnAOKwAED3/p/////wTwDEYQGA7v0/////4Z8AiMMCAN37f/7//8M/ARCHBQC69//8//+HfwIgDgsAdO//+f//D/8EQBwWAOje//P//x/+CYA4LADQvf/P//9//BMAcVgAoHv/Dw==",
  "base64",
);

const base128 = (value: number): number[] => {
  const digits = [value % 128];
  for (let rest = Math.floor(value / 128); rest > 0; rest = Math.floor(rest / 128)) digits.unshift((rest % 128) | 0x80);
  return digits;
};

/** A WOFF2 file with one untransformed `name` table of `length` bytes, over `payload` as its brotli stream. */
function woff2Declaring(length: number, payload: Buffer, totalSfntSize = length): Buffer {
  const directory = Buffer.from([5, ...base128(length)]);
  const header = Buffer.alloc(48);
  header.write("wOF2", 0, "latin1");
  header.writeUInt32BE(0x00010000, 4);
  header.writeUInt32BE(header.length + directory.length + payload.length, 8);
  header.writeUInt16BE(1, 12);
  header.writeUInt32BE(totalSfntSize, 16);
  header.writeUInt32BE(payload.length, 20);
  return Buffer.concat([header, directory, payload]);
}

interface Sfnt {
  flavor: number;
  totalSfntSize: number;
  tables: { tag: string; data: Buffer }[];
}

const KNOWN_WOFF2_TAGS = "cmap head hhea hmtx maxp name OS/2 post cvt fpgm glyf loca prep CFF VORG EBDT EBLC gasp hdmx kern LTSH PCLT VDMX vhea vmtx BASE GDEF GPOS GSUB"
  .split(" ")
  .map((tag) => tag.padEnd(4));

/** The tables of a WOFF2 file without transformed tables, such as the CFF-flavored ss3.woff2, with native brotli. */
function readWoff2(woff2: Buffer): Sfnt {
  let pos = 48;
  const readBase128 = () => {
    let value = 0;
    for (;;) {
      const byte = woff2[pos++];
      value = value * 128 + (byte & 0x7f);
      if (byte < 0x80) return value;
    }
  };
  const entries = Array.from({ length: woff2.readUInt16BE(12) }, () => {
    const flags = woff2[pos++];
    const tag = KNOWN_WOFF2_TAGS[flags & 0x3f];
    if (!tag || flags >>> 6 !== 0 || tag === "glyf" || tag === "loca") throw new Error("unsupported WOFF2 table");
    return { tag, length: readBase128() };
  });
  const data = brotliDecompressSync(woff2.subarray(pos, pos + woff2.readUInt32BE(20)));
  let offset = 0;
  const tables = entries.map(({ tag, length }) => ({ tag, data: data.subarray(offset, (offset += length)) }));
  return { flavor: woff2.readUInt32BE(4), totalSfntSize: woff2.readUInt32BE(16), tables };
}

interface TableEdit {
  origLength?: (length: number) => number;
  stream?: (compressed: Buffer) => Buffer;
}

/** A WOFF 1.0 file of `font`, tables zlib-compressed when that is smaller, with edits to named tables. */
function toWoff(font: Sfnt, edits: Record<string, TableEdit> = {}): Buffer {
  const directory = Buffer.alloc(font.tables.length * 20);
  const bodies: Buffer[] = [];
  let offset = 44 + directory.length;
  font.tables.forEach(({ tag, data }, index) => {
    const edit = edits[tag] ?? {};
    const deflated = deflateSync(data);
    const stored = deflated.length < data.length ? (edit.stream ?? ((bytes: Buffer) => bytes))(deflated) : data;
    directory.write(tag, index * 20, "latin1");
    directory.writeUInt32BE(offset, index * 20 + 4);
    directory.writeUInt32BE(stored.length, index * 20 + 8);
    directory.writeUInt32BE((edit.origLength ?? ((length: number) => length))(data.length), index * 20 + 12);
    bodies.push(stored, Buffer.alloc(-stored.length & 3));
    offset += stored.length + (-stored.length & 3);
  });
  const header = Buffer.alloc(44);
  header.write("wOFF", 0, "latin1");
  header.writeUInt32BE(font.flavor, 4);
  header.writeUInt32BE(offset, 8);
  header.writeUInt16BE(font.tables.length, 12);
  header.writeUInt32BE(font.totalSfntSize, 16);
  header.writeUInt16BE(1, 20);
  return Buffer.concat([header, directory, ...bodies]);
}

describe("parseFontBinary", () => {
  it("reads names, licence records, axes and Latin coverage from a variable WOFF2", () => {
    const meta = parseFontBinary(asset("__inter.woff2"));
    expect(meta).toMatchObject({
      format: "woff2",
      familyName: "Inter",
      nameId1: "Inter",
      subfamilyName: "Regular",
      postscriptName: "Inter-Regular",
      fullName: "Inter Regular",
      licenseUrl: "https://openfontlicense.org",
      weightClass: 400,
      coversLatin: true,
    });
    expect(meta?.copyright).toContain("Inter Project Authors");
    expect(meta?.typoFamily).toBeUndefined();
    expect(meta?.axes).toContainEqual({ tag: "wght", min: 100, max: 900, default: 400 });
  });

  it("prefers the typographic family and reports missing Latin glyphs", () => {
    const meta = parseFontBinary(asset("jbm-cyr.woff2"));
    expect(meta).toMatchObject({
      familyName: "JetBrains Mono",
      typoFamily: "JetBrains Mono",
      nameId1: "JetBrains Mono Medium",
      subfamilyName: "Medium",
      coversLatin: false,
      weightClass: 500,
    });
    expect(meta?.axes).toBeUndefined();
  });

  it("reads the licence description of a static font", () => {
    const meta = parseFontBinary(asset("ss3.woff2"));
    expect(meta?.familyName).toBe("Source Sans 3");
    expect(meta?.licenseDescription).toMatch(/SIL Open Font License, Version 1\.1/);
    expect(meta?.licenseUrl).toBe("http://scripts.sil.org/OFL");
  });

  it("gives null for bytes that are not a font", () => {
    expect(parseFontBinary(Buffer.from("definitely not a font file, just text"))).toBeNull();
    expect(parseFontBinary(Buffer.from([0x77, 0x4f, 0x46, 0x32, 1, 2, 3]))).toBeNull();
    expect(parseFontBinary(asset("__inter.woff2").subarray(0, 2000))).toBeNull();
    expect(parseFontBinary(Buffer.alloc(0))).toBeNull();
  });
});

describe("decompression limits", () => {
  const ss3 = readWoff2(asset("ss3.woff2"));

  it("reads a WOFF file whose tables inflate within their declared sizes", () => {
    const woff = toWoff(ss3);
    expect(withinDecompressionLimits(woff)).toBe(true);
    expect(parseFontBinary(woff)).toEqual({ ...parseFontBinary(asset("ss3.woff2")), format: "woff" });
  });

  it("rejects a WOFF2 decompression bomb without handing it to fontkit", () => {
    // fontkit alone allocates 256 MiB and spends about half a second decoding either file
    const bombs = [woff2Declaring(2 ** 28, BROTLI_256_MIB_OF_ZEROS), woff2Declaring(2 ** 28, BROTLI_256_MIB_OF_ZEROS, 1_000)];
    const create = vi.mocked(fontkit.create);
    for (const bomb of bombs) {
      expect(bomb.length).toBeLessThan(300);
      create.mockClear();
      expect(parseFontBinary(bomb)).toBeNull();
      expect(create).not.toHaveBeenCalled();
      expect(withinDecompressionLimits(bomb)).toBe(false);
    }
    create.mockClear();
    expect(parseFontBinary(asset("ss3.woff2"))).not.toBeNull();
    expect(create).toHaveBeenCalledOnce();
  });

  it("allows 16 times the file size, at least 16 KiB and at most 32 MiB", () => {
    const sized = (length: number, fileBytes: number) => woff2Declaring(length, Buffer.alloc(fileBytes - woff2Declaring(length, Buffer.alloc(0)).length));
    expect(withinDecompressionLimits(sized(16 * 1024, 100))).toBe(true);
    expect(withinDecompressionLimits(sized(16 * 1024 + 1, 100))).toBe(false);
    expect(withinDecompressionLimits(sized(160_000, 10_000))).toBe(true);
    expect(withinDecompressionLimits(sized(160_001, 10_000))).toBe(false);
    expect(withinDecompressionLimits(sized(32 * MIB, 3 * MIB))).toBe(true);
    expect(withinDecompressionLimits(sized(32 * MIB + 1, 3 * MIB))).toBe(false);
    expect(withinDecompressionLimits(asset("ss3.woff2").subarray(0, 40))).toBe(false);
  });

  it("rejects WOFF tables that declare more than the file can hold", () => {
    // fontkit alone allocates the 64 MiB and reads the names
    const woff = toWoff(ss3, { name: { origLength: () => 64 * MIB } });
    expect(withinDecompressionLimits(woff)).toBe(false);
    expect(parseFontBinary(woff)).toBeNull();
  });

  it("rejects WOFF tables whose zlib stream does not end within the declared size", () => {
    const truncated = toWoff(ss3, { name: { stream: (compressed) => compressed.subarray(0, -8) } });
    const overflowing = toWoff(ss3, { name: { origLength: (length) => length - 1 } });
    // fontkit's inflate never returns on the truncated stream, so only the limits are checked for it here
    expect(withinDecompressionLimits(truncated)).toBe(false);
    expect(withinDecompressionLimits(overflowing)).toBe(false);
    expect(parseFontBinary(overflowing)).toBeNull();
  });

  it("does not limit uncompressed formats", () => {
    expect(withinDecompressionLimits(Buffer.from("OTTO0000"))).toBe(true);
    expect(withinDecompressionLimits(Buffer.from("not a font"))).toBe(true);
  });
});

describe("sniffFontFormat", () => {
  it("recognizes font signatures", () => {
    expect(sniffFontFormat(asset("ss3.woff2"))).toBe("woff2");
    expect(sniffFontFormat(Buffer.from("wOFF0000"))).toBe("woff");
    expect(sniffFontFormat(Buffer.from([0, 1, 0, 0, 0, 0]))).toBe("ttf");
    expect(sniffFontFormat(Buffer.from("true0000"))).toBe("ttf");
    expect(sniffFontFormat(Buffer.from("OTTO0000"))).toBe("otf");
    const eot = Buffer.alloc(40);
    eot.writeUInt16LE(0x504c, 34);
    expect(sniffFontFormat(eot)).toBe("eot");
    expect(sniffFontFormat(Buffer.from("<html>"))).toBe("other");
  });
});
