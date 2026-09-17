import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { brotliCompressSync, brotliDecompressSync, constants, deflateSync } from "node:zlib";
import * as fontkit from "fontkit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseFontBinary, sniffFontFormat, withinParseLimits } from "./binary";

vi.mock("fontkit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fontkit")>();
  return { ...actual, create: vi.fn(actual.create) };
});

const asset = (name: string) => readFileSync(path.join(process.cwd(), "tests/fixtures/site/assets", name));
const KIB = 1024;
const MIB = 1024 * KIB;
const create = vi.mocked(fontkit.create);

beforeEach(() => {
  create.mockClear();
});

/** Whether `parseFontBinary` refuses the file before fontkit sees it. */
const refusedBeforeFontkit = (file: Buffer) => {
  create.mockClear();
  const meta = parseFontBinary(file);
  return meta === null && create.mock.calls.length === 0 && !withinParseLimits(file);
};

/** 256 MiB of zeros in 211 bytes: `brotliCompressSync(Buffer.alloc(2 ** 28))` with a 24-bit window. */
const BROTLI_256_MIB_OF_ZEROS = Buffer.from(
  "z///f/gnAOKxQCD3/p/////wTwDEYQGA7v0/////4Z8AiMMiAN37f/7//8M/ARCHBQC69//8//+HfwIgDgsAdO//+f//D/8EQBwWAOje//P//x/+CYA4LADQvf/n//8//BMAcVgAoHv/z///f/gnAOKwAED3/p/////wTwDEYQGA7v0/////4Z8AiMMCAN37f/7//8M/ARCHBQC69//8//+HfwIgDgsAdO//+f//D/8EQBwWAOje//P//x/+CYA4LADQvf/P//9//BMAcVgAoHv/Dw==",
  "base64",
);

const u16 = (value: number) => Buffer.from([value >> 8, value & 0xff]);
const u32 = (value: number) => Buffer.from([value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]);

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

/** `font` with the table `tag` replaced, or added last. */
function withTable(font: Sfnt, tag: string, data: Buffer): Sfnt {
  const tables = font.tables.some((table) => table.tag === tag)
    ? font.tables.map((table) => (table.tag === tag ? { tag, data } : table))
    : [...font.tables, { tag, data }];
  return { ...font, tables };
}

/** An OpenType or TrueType file of `font`, its table offsets counted from `base` (for a collection header before it). */
function toSfnt(font: Sfnt, base = 0): Buffer {
  const directory = Buffer.alloc(12 + font.tables.length * 16);
  directory.writeUInt32BE(font.flavor, 0);
  directory.writeUInt16BE(font.tables.length, 4);
  const bodies: Buffer[] = [];
  let offset = base + directory.length;
  font.tables.forEach(({ tag, data }, index) => {
    directory.write(tag, 12 + index * 16, "latin1");
    directory.writeUInt32BE(offset, 12 + index * 16 + 8);
    directory.writeUInt32BE(data.length, 12 + index * 16 + 12);
    bodies.push(data, Buffer.alloc(-data.length & 3));
    offset += data.length + (-data.length & 3);
  });
  return Buffer.concat([directory, ...bodies]);
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

/** A WOFF2 file of `font` with untransformed tables and an explicit tag where no index is known, padded to `fileBytes`. */
function toWoff2(font: Sfnt, fileBytes = 0): Buffer {
  const directory = Buffer.concat(
    font.tables.map(({ tag, data }) => {
      const index = KNOWN_WOFF2_TAGS.indexOf(tag);
      return Buffer.from([...(index >= 0 ? [index] : [0x3f, ...Buffer.from(tag, "latin1")]), ...base128(data.length)]);
    }),
  );
  const stream = brotliCompressSync(Buffer.concat(font.tables.map(({ data }) => data)), { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } });
  const header = Buffer.alloc(48);
  header.write("wOF2", 0, "latin1");
  header.writeUInt32BE(font.flavor, 4);
  header.writeUInt16BE(font.tables.length, 12);
  header.writeUInt32BE(font.totalSfntSize, 16);
  header.writeUInt32BE(stream.length, 20);
  const file = Buffer.concat([header, directory, stream, Buffer.alloc(Math.max(0, fileBytes - header.length - directory.length - stream.length))]);
  file.writeUInt32BE(file.length, 8);
  return file;
}

interface StringRecord {
  length: number;
  offset: number;
}

/**
 * A `name` table of Windows English records (name ID 1 unless given) over `storage`, with `stringOffset` right after
 * the records by default, and version 1 when it has language tags.
 */
function nameTable(records: (StringRecord & { nameId?: number })[], storage: Buffer, options: { stringOffset?: number; langTags?: StringRecord[] } = {}): Buffer {
  const { langTags } = options;
  const tagBytes = langTags ? [u16(langTags.length), ...langTags.flatMap(({ length, offset }) => [u16(length), u16(offset)])] : [];
  const headerLength = 6 + records.length * 12 + tagBytes.reduce((sum, bytes) => sum + bytes.length, 0);
  return Buffer.concat([
    u16(langTags ? 1 : 0),
    u16(records.length),
    u16(options.stringOffset ?? headerLength),
    ...records.flatMap(({ nameId = 1, length, offset }) => [u16(3), u16(1), u16(0x409), u16(nameId), u16(length), u16(offset)]),
    ...tagBytes,
    storage,
  ]);
}

/** A `name` table giving `family` as name ID 1, its storage padded with zeros to `tableBytes`. */
function familyNameTable(family: string, tableBytes = 0): Buffer {
  const string = Buffer.from(family, "utf16le").swap16();
  const table = nameTable([{ length: string.length, offset: 0 }], string);
  return Buffer.concat([table, Buffer.alloc(Math.max(0, tableBytes - table.length))]);
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

describe("parse limits", () => {
  const ss3 = readWoff2(asset("ss3.woff2"));
  const ss3Meta = parseFontBinary(asset("ss3.woff2"));

  it("reads OpenType, TrueType and WOFF files", () => {
    expect(ss3Meta).not.toBeNull();
    expect(parseFontBinary(toSfnt(ss3))).toEqual({ ...ss3Meta, format: "otf" });
    for (const flavor of [0x00010000, 0x74727565]) expect(parseFontBinary(toSfnt({ ...ss3, flavor }))).toEqual({ ...ss3Meta, format: "ttf" });
    expect(parseFontBinary(toWoff(ss3))).toEqual({ ...ss3Meta, format: "woff" });
    expect(parseFontBinary(toWoff2(ss3))).toEqual(ss3Meta);
    expect(create).toHaveBeenCalledTimes(5);
  });

  it("never hands fontkit a TrueType collection or another format", () => {
    // fontkit builds a font for each offset a collection lists, and probes unknown bytes as a DFont resource map
    const collection = Buffer.concat([Buffer.from("ttcf"), u32(0x00010000), u32(1), u32(16), toSfnt(ss3, 16)]);
    expect("fonts" in fontkit.create(collection)).toBe(true);
    const eot = Buffer.alloc(40);
    eot.writeUInt16LE(0x504c, 34);
    for (const file of [collection, toSfnt({ ...ss3, flavor: 0x74797031 }), eot, Buffer.concat([u32(256), u32(512), toSfnt(ss3)])]) {
      expect(refusedBeforeFontkit(file)).toBe(true);
    }
  });

  it("refuses files without a name table or with a table listed twice", () => {
    expect(refusedBeforeFontkit(toSfnt({ ...ss3, tables: ss3.tables.filter((table) => table.tag !== "name") }))).toBe(true);
    const name = ss3.tables.find((table) => table.tag === "name")!;
    const twice = { ...ss3, tables: [...ss3.tables, name] };
    for (const file of [toSfnt(twice), toWoff(twice), toWoff2(twice)]) expect(refusedBeforeFontkit(file)).toBe(true);
  });

  it("rejects a WOFF2 decompression bomb without handing it to fontkit", () => {
    // fontkit alone allocates 256 MiB and spends about half a second decoding each file: its brotli decoder grows its
    // output past the declared size, so declaring 1,000 bytes does not stop it either
    const bombs = [
      woff2Declaring(2 ** 28, BROTLI_256_MIB_OF_ZEROS),
      woff2Declaring(2 ** 28, BROTLI_256_MIB_OF_ZEROS, 1_000),
      woff2Declaring(1_000, BROTLI_256_MIB_OF_ZEROS),
    ];
    for (const bomb of bombs) {
      expect(bomb.length).toBeLessThan(300);
      expect(refusedBeforeFontkit(bomb)).toBe(true);
    }
  });

  it("allows 16 times the file size, at least 16 KiB and at most 30 MiB", () => {
    // A WOFF2 file of `fileBytes` whose one table, an empty `name` table, declares and decompresses to `length` bytes
    const sized = (length: number, fileBytes: number) =>
      toWoff2({ flavor: 0x00010000, totalSfntSize: length, tables: [{ tag: "name", data: nameTable([], Buffer.alloc(length - 6)) }] }, fileBytes);
    expect(withinParseLimits(sized(16 * KIB, 100))).toBe(true);
    expect(withinParseLimits(sized(16 * KIB + 1, 100))).toBe(false);
    expect(withinParseLimits(sized(160_000, 10_000))).toBe(true);
    expect(withinParseLimits(sized(160_001, 10_000))).toBe(false);
    expect(withinParseLimits(sized(30 * MIB, 2 * MIB))).toBe(true);
    expect(withinParseLimits(sized(30 * MIB + 1, 3 * MIB))).toBe(false);
    expect(withinParseLimits(asset("ss3.woff2").subarray(0, 40))).toBe(false);
  });

  it("refuses a WOFF2 whose table directory or header declares more than 30 MiB, whatever its stream holds", () => {
    // woff2, which converts the fonts the proxy serves as TTF, returns 30 MiB at most. fontkit alone allocates the sum
    // of the lengths the directory declares, and reads the names from this 2 MiB file.
    const name = familyNameTable("Declared");
    const stream = brotliCompressSync(name);
    /** A 2 MiB WOFF2 file declaring `name`, then `post` and `gasp` tables of `padding` bytes, over a stream of `name` only. */
    const declaring = (padding: number[], totalSfntSize = name.length) => {
      const tags = [7, 17];
      const directory = Buffer.from([5, ...base128(name.length), ...padding.flatMap((length, index) => [tags[index], ...base128(length)])]);
      const header = Buffer.alloc(48);
      header.write("wOF2", 0, "latin1");
      header.writeUInt32BE(0x00010000, 4);
      header.writeUInt32BE(2 * MIB, 8);
      header.writeUInt16BE(1 + padding.length, 12);
      header.writeUInt32BE(totalSfntSize, 16);
      header.writeUInt32BE(stream.length, 20);
      return Buffer.concat([header, directory, stream], 2 * MIB);
    };
    const rest = 30 * MIB - name.length;
    expect(withinParseLimits(declaring([rest]))).toBe(true);
    expect(withinParseLimits(declaring([rest / 2, rest / 2], 30 * MIB))).toBe(true);
    expect(refusedBeforeFontkit(declaring([rest + 1]))).toBe(true);
    expect(refusedBeforeFontkit(declaring([rest / 2, rest / 2 + 1]))).toBe(true);
    expect(refusedBeforeFontkit(declaring([], 30 * MIB + 1))).toBe(true);
  });

  it("refuses a WOFF whose table directory or header declares more than 30 MiB, whatever its streams hold", () => {
    // fontkit allocates the declared size of each compressed table before inflating it. At 2 MiB, 16 times the file size
    // is over 30 MiB, so the 30 MiB ceiling decides.
    const name = familyNameTable("Declared");
    const empty = deflateSync(Buffer.alloc(0));
    /** A 2 MiB WOFF file with `name` stored uncompressed, then `post` and `gasp` tables declaring `padding` bytes over empty streams. */
    const declaring = (padding: number[], totalSfntSize = name.length) => {
      const tables = [{ tag: "name", data: name, origLength: name.length }, ...padding.map((origLength, index) => ({ tag: ["post", "gasp"][index], data: empty, origLength }))];
      const directory = Buffer.alloc(tables.length * 20);
      const bodies: Buffer[] = [];
      let offset = 44 + directory.length;
      tables.forEach(({ tag, data, origLength }, index) => {
        directory.write(tag, index * 20, "latin1");
        directory.writeUInt32BE(offset, index * 20 + 4);
        directory.writeUInt32BE(data.length, index * 20 + 8);
        directory.writeUInt32BE(origLength, index * 20 + 12);
        bodies.push(data, Buffer.alloc(-data.length & 3));
        offset += data.length + (-data.length & 3);
      });
      const header = Buffer.alloc(44);
      header.write("wOFF", 0, "latin1");
      header.writeUInt32BE(0x00010000, 4);
      header.writeUInt32BE(2 * MIB, 8);
      header.writeUInt16BE(tables.length, 12);
      header.writeUInt32BE(totalSfntSize, 16);
      return Buffer.concat([header, directory, ...bodies], 2 * MIB);
    };
    const rest = 30 * MIB - name.length;
    expect(withinParseLimits(declaring([rest]))).toBe(true);
    expect(withinParseLimits(declaring([rest / 2, rest / 2], 30 * MIB))).toBe(true);
    expect(refusedBeforeFontkit(declaring([rest + 1]))).toBe(true);
    expect(refusedBeforeFontkit(declaring([rest / 2, rest / 2 + 1]))).toBe(true);
    expect(refusedBeforeFontkit(declaring([], 30 * MIB + 1))).toBe(true);
  });

  it("rejects WOFF tables that declare more than the file can hold", () => {
    // fontkit alone allocates the 64 MiB and reads the names
    expect(refusedBeforeFontkit(toWoff(ss3, { name: { origLength: () => 64 * MIB } }))).toBe(true);
  });

  it("rejects WOFF tables whose zlib stream does not end within the declared size", () => {
    // fontkit's inflate never returns on the truncated stream
    expect(refusedBeforeFontkit(toWoff(ss3, { name: { stream: (compressed) => compressed.subarray(0, -8) } }))).toBe(true);
    expect(refusedBeforeFontkit(toWoff(ss3, { name: { origLength: (length) => length - 1 } }))).toBe(true);
  });

  it("allows 4,096 name records with 256 KiB of strings inside the name table", () => {
    const records = (count: number, length = 0) => Array.from({ length: count }, () => ({ length, offset: 0 }));
    const storage = Buffer.alloc(65_535);
    const within = (table: Buffer) => withinParseLimits(toSfnt(withTable(ss3, "name", table)));
    expect(within(nameTable(records(4_096), storage))).toBe(true);
    expect(within(nameTable(records(4_097), storage))).toBe(false);
    expect(within(nameTable([...records(4, 65_535), { length: 4, offset: 0 }], storage))).toBe(true);
    expect(within(nameTable([...records(4, 65_535), { length: 5, offset: 0 }], storage))).toBe(false);
    // strings past the end of the table
    expect(within(nameTable([{ length: 10, offset: 65_530 }], storage))).toBe(false);
    expect(within(nameTable([{ length: 10, offset: 0 }], Buffer.alloc(100), { stringOffset: 18 + 90 }))).toBe(true);
    expect(within(nameTable([{ length: 10, offset: 0 }], Buffer.alloc(100), { stringOffset: 18 + 91 }))).toBe(false);
    expect(within(nameTable([], Buffer.alloc(0)).subarray(0, 5))).toBe(false);
    // language tags of a version 1 table count as records
    expect(within(nameTable(records(4_000), storage, { langTags: records(96) }))).toBe(true);
    expect(within(nameTable(records(4_000), storage, { langTags: records(97) }))).toBe(false);
    expect(within(nameTable([], storage, { langTags: [{ length: 10, offset: 65_530 }] }))).toBe(false);
  });

  it("refuses a name table whose records all decode the same long string, in every format", () => {
    // fontkit alone decodes 8,000 strings of 32,767 characters from this 96 KB table and takes 600 MB
    const table = nameTable(Array.from({ length: 8_000 }, () => ({ length: 65_535, offset: 0 })), Buffer.alloc(0), { stringOffset: 0 });
    expect(table.length).toBeLessThan(100 * KIB);
    const bomb = withTable(ss3, "name", table);
    for (const file of [toSfnt(bomb), toWoff(bomb), toWoff2(bomb)]) expect(refusedBeforeFontkit(file)).toBe(true);
  });

  it("checks the name table fontkit decodes, where WOFF2 puts integer-like tags first", () => {
    // Directory order: `name` naming Direct, then `1234` of the same size. fontkit lays tables out with `1234` first.
    const size = 2 * KIB;
    const swapped = (other: Buffer) => {
      const [first, ...rest] = withTable(ss3, "name", familyNameTable("Direct", size)).tables.sort((a, b) => Number(b.tag === "name") - Number(a.tag === "name"));
      return toWoff2({ ...ss3, tables: [first, { tag: "1234", data: other }, ...rest] });
    };
    const meta = parseFontBinary(swapped(familyNameTable("Swapped", size)));
    expect(meta).toMatchObject({ familyName: "Swapped" });
    const bomb = nameTable(Array.from({ length: 150 }, () => ({ length: 1_900, offset: 0 })), Buffer.alloc(0), { stringOffset: 0 });
    expect(bomb.length).toBeLessThanOrEqual(size);
    expect(refusedBeforeFontkit(swapped(Buffer.concat([bomb, Buffer.alloc(size - bomb.length)])))).toBe(true);
  });

  it("allows 64 cmap subtables", () => {
    // Mac Roman records, not Unicode ones, all over one format 0 subtable: fontkit decodes it once per record
    const cmap = (count: number) =>
      Buffer.concat([u16(0), u16(count), ...Array.from({ length: count }, () => Buffer.concat([u16(1), u16(0), u32(4 + count * 8)])), u16(0), u16(262), u16(0), Buffer.alloc(256)]);
    expect(parseFontBinary(toSfnt(withTable(ss3, "cmap", cmap(64))))).toMatchObject({ familyName: "Source Sans 3", coversLatin: false });
    expect(refusedBeforeFontkit(toSfnt(withTable(ss3, "cmap", cmap(65))))).toBe(true);
    // fontkit alone takes a second and 300 MB for these 525 KB
    expect(refusedBeforeFontkit(toSfnt(withTable(ss3, "cmap", cmap(65_535))))).toBe(true);
  });

  it("allows 64 variation axes and 1,024 named instances", () => {
    const fvar = (axes: number, instances: number) =>
      Buffer.concat([u32(0x00010000), u16(16), u16(2), u16(axes), u16(20), u16(instances), u16(axes * 4 + 4), Buffer.alloc(axes * 20 + instances * (axes * 4 + 4))]);
    expect(parseFontBinary(toSfnt(withTable(ss3, "fvar", fvar(64, 1_024))))).toMatchObject({ familyName: "Source Sans 3" });
    expect(refusedBeforeFontkit(toSfnt(withTable(ss3, "fvar", fvar(65, 1))))).toBe(true);
    expect(refusedBeforeFontkit(toSfnt(withTable(ss3, "fvar", fvar(1, 1_025))))).toBe(true);
  });
});

describe("fonts module source", () => {
  it("holds no raw control characters, so git diffs every file as text", () => {
    // A NUL byte in a string literal made git show binary.ts as a binary file, with no diff
    const directory = path.join(process.cwd(), "src/server/scan/fonts");
    const files = readdirSync(directory).filter((file) => file.endsWith(".ts"));
    expect(files).toContain("binary.ts");
    for (const file of files) expect(readFileSync(path.join(directory, file), "utf8"), file).not.toMatch(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/);
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
