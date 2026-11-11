import { crc32, deflateRawSync, deflateSync } from "node:zlib";
import sharp from "sharp";
import type { Asset, AssetRole, FontFamily, FontFile, Palette, Wordmark } from "@/lib/contract";
import type { AgentScan, SelectionBudget } from "./types";

/** Factories the agent tests build scans with. Not bundled into the CLI or the MCP server. */

/**
 * The tools the MCP server registers: the eight of spec section 6, and the brand file download, in their order.
 * src/agent/mcp.test.ts holds the server to it, and src/components/agents/content.test.ts the `/agents` page.
 */
export const MCP_TOOL_NAMES = [
  "scan_page",
  "list_assets",
  "download_assets",
  "download_brand_files",
  "read_svg",
  "get_palette",
  "install_fonts",
  "list_installed_fonts",
  "uninstall_fonts",
];

/** What a stubbed download reports when the test is not about the byte rules: no budget, nothing measured. */
export const noBudget: SelectionBudget = { maxTotalBytes: 0, maxFileBytes: 0, keptBytes: 0 };

export function testAsset(patch: Partial<Asset> & { id: string }): Asset {
  const format = patch.format ?? (patch.kind === "svg" ? "svg" : "png");
  return {
    kind: format === "svg" ? "svg" : "image",
    role: "image",
    name: patch.id,
    filename: `${patch.id}.${format}`,
    format,
    foundIn: ["img"],
    visible: true,
    declaredOnly: false,
    order: 0,
    score: 50,
    usedCount: 1,
    tone: "unknown",
    display: { url: `https://cdn.example.com/${patch.id}.${format}`, proxy: "", format },
    original: null,
    ...patch,
  };
}

export function testFontFile(patch: Partial<FontFile> = {}): FontFile {
  return { url: "https://cdn.example.com/inter.woff2", proxy: "", format: "woff2", coversLatin: true, ...patch };
}

export function testFontFamily(patch: Partial<FontFamily> & { name: string }): FontFamily {
  return {
    id: patch.name.toLowerCase(),
    cssFamilies: [patch.name],
    source: "self-hosted",
    sourceHost: "cdn.example.com",
    license: { kind: "open", text: "SIL Open Font License" },
    convertible: true,
    downloadable: true,
    usedOnPage: true,
    usage: 0.5,
    faces: [{ weight: "400", style: "normal", loaded: true, files: [testFontFile()] }],
    ...patch,
  };
}

/** investirday.fr's lockup as a scan reports it: "Investir" over "Day" beside its monogram, drawn at 36x36. */
export function testWordmark(patch: Partial<Wordmark> = {}): Wordmark {
  return {
    text: "Investir\nDay",
    family: "Inter",
    weight: 700,
    size: 12,
    letterSpacing: 1.2,
    transform: "uppercase",
    runs: [
      { text: "Investir\n", hex: "#130d21" },
      { text: "Day", hex: "#fb2189" },
    ],
    withLogo: { id: "asset-0", width: 36, height: 36 },
    ...patch,
  };
}

const palette: Palette = {
  brand: [
    { hex: "#635bff", role: "primary" },
    { hex: "#0a2540", role: "accent" },
  ],
  neutrals: [
    { hex: "#ffffff", role: "background" },
    { hex: "#f6f9fc", role: "surface" },
    { hex: "#425466", role: "text" },
  ],
};

export function testScan(patch: Partial<AgentScan> = {}): AgentScan {
  const roles: AssetRole[] = ["site-logo", "logo", "logo", "social", "illustration", "image", "icon", "favicon"];
  const assets = Array.from({ length: 236 }, (_, index) =>
    testAsset({
      id: `asset-${index}`,
      role: roles[index % roles.length],
      order: index,
      score: 100 - index,
      width: 1200,
      height: 800,
    }),
  );
  return {
    scanId: "scan-1",
    scannedAt: "2026-09-27T10:00:00.000Z",
    source: "local",
    page: { url: "https://stripe.com", finalUrl: "https://stripe.com/", host: "stripe.com", title: "Stripe", siteName: "Stripe" },
    assets,
    fonts: [testFontFamily({ name: "Inter" }), testFontFamily({ name: "Söhne", license: { kind: "commercial", text: "Copyright Klim Type Foundry" } })],
    palette,
    stats: { assets: assets.length, svg: 40, images: 196, fonts: 2, hidden: { tracker: 3, pixel: 9 }, durationMs: 12_345 },
    warnings: [],
    ...patch,
  };
}

/** The card fixture's pixel size, so a test can declare the asset dimensions that go with the bytes. */
export const TEMPLATE_CARD_WIDTH = 800;
export const TEMPLATE_CARD_HEIGHT = 600;

/**
 * One card of a set cut from a single template: identical chrome (a white ground, a title bar, two lines of body and a
 * button) and a hero photo whose fine detail is the only thing that changes. This is the case a 16x16 greyscale
 * comparison could not tell from a resize of one card, because the detail washes out at that size: the cards measure a
 * root mean square difference under 0.5 at 16x16 and a Hamming distance of 1 to 5 of 256, closer than a genuine resize,
 * while at 64x64 they measure 14 and up.
 */
export function templateCardImage(index: number): Promise<Buffer> {
  const pixels = Buffer.alloc(TEMPLATE_CARD_WIDTH * TEMPLATE_CARD_HEIGHT, 255);
  const bar = (left: number, top: number, right: number, bottom: number, value: number): void => {
    for (let y = top; y < bottom; y += 1) pixels.fill(value, y * TEMPLATE_CARD_WIDTH + left, y * TEMPLATE_CARD_WIDTH + right);
  };
  const wave = (2 * Math.PI) / 40;
  for (let y = 40; y < 340; y += 1) {
    for (let x = 40; x < 760; x += 1) {
      const gradient = 80 + ((x - 40) / 720) * 120;
      const detail = 45 * Math.sin((x - 40) * wave + index * 1.1) * Math.cos((y - 40) * wave * 0.8 + index * 2.1);
      pixels[y * TEMPLATE_CARD_WIDTH + x] = Math.max(0, Math.min(255, Math.round(gradient + detail)));
    }
  }
  bar(40, 380, 688, 406, 26);
  bar(40, 430, 540, 448, 74);
  bar(40, 470, 470, 488, 74);
  bar(40, 530, 180, 564, 26);
  return sharp(pixels, { raw: { width: TEMPLATE_CARD_WIDTH, height: TEMPLATE_CARD_HEIGHT, channels: 1 } }).png().toBuffer();
}

/**
 * A WOFF (version 1) file wrapping `sfnt`, the way a font tool writes one: the sfnt directory in tag order, each table
 * zlib compressed when that makes it smaller, the data in the order the sfnt stored it and padded to 4 bytes.
 */
export function woffFromSfnt(sfnt: Buffer): Buffer {
  const count = sfnt.readUInt16BE(4);
  const tables = Array.from({ length: count }, (_, index) => {
    const at = 12 + index * 16;
    const offset = sfnt.readUInt32BE(at + 8);
    const data = sfnt.subarray(offset, offset + sfnt.readUInt32BE(at + 12));
    const compressed = deflateSync(data);
    return { tag: sfnt.readUInt32BE(at), checksum: sfnt.readUInt32BE(at + 4), offset, data, stored: compressed.length < data.length ? compressed : data };
  });
  const pad = (length: number): number => (length + 3) & ~3;
  const placed = new Map<(typeof tables)[number], number>();
  let cursor = 44 + count * 20;
  for (const table of [...tables].sort((a, b) => a.offset - b.offset)) {
    placed.set(table, cursor);
    cursor += pad(table.stored.length);
  }
  const woff = Buffer.alloc(cursor);
  woff.write("wOFF", 0, "latin1");
  woff.writeUInt32BE(sfnt.readUInt32BE(0), 4);
  woff.writeUInt32BE(cursor, 8);
  woff.writeUInt16BE(count, 12);
  woff.writeUInt32BE(12 + count * 16 + tables.reduce((total, table) => total + pad(table.data.length), 0), 16);
  woff.writeUInt16BE(1, 20);
  tables.forEach((table, index) => {
    const at = 44 + index * 20;
    const offset = placed.get(table) ?? 0;
    woff.writeUInt32BE(table.tag, at);
    woff.writeUInt32BE(offset, at + 4);
    woff.writeUInt32BE(table.stored.length, at + 8);
    woff.writeUInt32BE(table.data.length, at + 12);
    woff.writeUInt32BE(table.checksum, at + 16);
    table.stored.copy(woff, offset);
  });
  return woff;
}

/** One entry of a test archive. Every field past `name` lets a test write the lie a hostile archive would. */
export interface ZipEntrySpec {
  name: string;
  data?: Buffer | string;
  /** 8 (deflate, the default) or 0 (stored); any other number is written as it is. */
  method?: number;
  /** The raw stream written for the entry, instead of `data` compressed. */
  stream?: Buffer;
  /** The uncompressed size the directory claims, instead of the real one. */
  declaredSize?: number;
  /** Written into the directory with the Unix symlink mode. */
  symlink?: boolean;
  /** The encryption flag. */
  encrypted?: boolean;
  /** The local header this entry's directory record points at, by index, instead of its own. */
  pointsAt?: number;
  /** The UTF-8 flag. Off by default, as macOS writes it. */
  utf8?: boolean;
}

/**
 * A ZIP archive built byte by byte, so a test can hand the reader what no archiver would write: a stream that inflates
 * past its declared size, entries sharing one stream, a `..` name, a symbolic link, a ZIP64 directory.
 */
export function buildZip(specs: ZipEntrySpec[], options: { zip64?: boolean } = {}): Buffer {
  const chunks: Buffer[] = [];
  const locals: { offset: number; crc: number; size: number; compressed: number; method: number }[] = [];
  let offset = 0;
  for (const spec of specs) {
    const data = typeof spec.data === "string" ? Buffer.from(spec.data) : (spec.data ?? Buffer.alloc(0));
    const method = spec.method ?? 8;
    const stream = spec.stream ?? (method === 8 ? deflateRawSync(data) : data);
    const name = Buffer.from(spec.name, "utf8");
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE((spec.encrypted ? 0x0001 : 0) | (spec.utf8 ? 0x0800 : 0), 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt32LE(crc32(data), 14);
    header.writeUInt32LE(stream.length, 18);
    header.writeUInt32LE(spec.declaredSize ?? data.length, 22);
    header.writeUInt16LE(name.length, 26);
    locals.push({ offset, crc: crc32(data), size: spec.declaredSize ?? data.length, compressed: stream.length, method });
    chunks.push(header, name, stream);
    offset += header.length + name.length + stream.length;
  }
  const directoryStart = offset;
  specs.forEach((spec, index) => {
    const local = locals[spec.pointsAt ?? index];
    const name = Buffer.from(spec.name, "utf8");
    const extra = options.zip64 ? Buffer.alloc(4 + 24) : Buffer.alloc(0);
    if (options.zip64) {
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(24, 2);
      extra.writeBigUInt64LE(BigInt(local.size), 4);
      extra.writeBigUInt64LE(BigInt(local.compressed), 12);
      extra.writeBigUInt64LE(BigInt(local.offset), 20);
    }
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(spec.symlink ? (3 << 8) | 20 : 20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE((spec.encrypted ? 0x0001 : 0) | (spec.utf8 ? 0x0800 : 0), 8);
    record.writeUInt16LE(local.method, 10);
    record.writeUInt32LE(local.crc, 16);
    record.writeUInt32LE(options.zip64 ? 0xffffffff : local.compressed, 20);
    record.writeUInt32LE(options.zip64 ? 0xffffffff : local.size, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt16LE(extra.length, 30);
    record.writeUInt32LE((spec.symlink ? 0o120777 : 0o100644) * 0x10000, 38);
    record.writeUInt32LE(options.zip64 ? 0xffffffff : local.offset, 42);
    chunks.push(record, name, extra);
    offset += record.length + name.length + extra.length;
  });
  const directorySize = offset - directoryStart;
  if (options.zip64) {
    const record = Buffer.alloc(56);
    record.writeUInt32LE(0x06064b50, 0);
    record.writeBigUInt64LE(BigInt(44), 4);
    record.writeBigUInt64LE(BigInt(specs.length), 24);
    record.writeBigUInt64LE(BigInt(specs.length), 32);
    record.writeBigUInt64LE(BigInt(directorySize), 40);
    record.writeBigUInt64LE(BigInt(directoryStart), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(offset), 8);
    locator.writeUInt32LE(1, 16);
    chunks.push(record, locator);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(options.zip64 ? 0xffff : specs.length, 8);
  end.writeUInt16LE(options.zip64 ? 0xffff : specs.length, 10);
  end.writeUInt32LE(options.zip64 ? 0xffffffff : directorySize, 12);
  end.writeUInt32LE(options.zip64 ? 0xffffffff : directoryStart, 16);
  chunks.push(end);
  return Buffer.concat(chunks);
}

/** A small SVG and a 1x1 PNG, the logo files of a test kit. */
export const TEST_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
export const TEST_PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000d4944415478da63f8cfc0f01f0005000201" + "e5ab6b6c0000000049454e44ae426082", "hex");

