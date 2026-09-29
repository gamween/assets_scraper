import fs from "node:fs";
import { fileURLToPath } from "node:url";
import * as fontkit from "fontkit";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { decompress } from "wawoff2";

/** Counts the inflates, so a test can say a hostile file was refused before any table was decompressed. */
const zlibSpy = vi.hoisted(() => ({ inflateSync: vi.fn() }));

vi.mock("node:zlib", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:zlib")>();
  zlibSpy.inflateSync.mockImplementation(actual.inflateSync);
  return { ...actual, default: { ...actual, inflateSync: zlibSpy.inflateSync }, inflateSync: zlibSpy.inflateSync };
});

import { deflateSync } from "node:zlib";
import { woffFromSfnt } from "./testing";
import { woffToSfnt } from "./woff";

const FIXTURE_WOFF2 = fileURLToPath(new URL("../../tests/fixtures/site/assets/__inter.woff2", import.meta.url));

/** The fixture Inter as TrueType, and the same font wrapped as WOFF 1. */
let ttf: Buffer;
let woff: Buffer;

beforeAll(async () => {
  ttf = Buffer.from(await decompress(await fs.promises.readFile(FIXTURE_WOFF2)));
  woff = woffFromSfnt(ttf);
});

describe("woffToSfnt", () => {
  it("gives back the very font a WOFF file wraps", () => {
    expect(woff.toString("latin1", 0, 4)).toBe("wOFF");
    expect(woff.length).toBeLessThan(ttf.length);

    const sfnt = woffToSfnt(woff, 8 * 1024 * 1024);

    expect(sfnt).not.toBeNull();
    expect(sfnt?.equals(ttf)).toBe(true);
    const font = fontkit.create(sfnt as Buffer);
    expect("fonts" in font ? null : font.familyName).toBe("Inter");
  });

  it("refuses what is not a WOFF file it can read", () => {
    const limit = 8 * 1024 * 1024;
    expect(woffToSfnt(ttf, limit)).toBeNull();
    expect(woffToSfnt(Buffer.from("wOFF not really a font"), limit)).toBeNull();

    // A table said to lie past the end of the file.
    const outside = Buffer.from(woff);
    outside.writeUInt32BE(woff.length, 44 + 4);
    expect(woffToSfnt(outside, limit)).toBeNull();

    // A table whose compressed stream is corrupt, or inflates to another length than the directory says.
    const corrupt = Buffer.from(woff);
    const offset = corrupt.readUInt32BE(44 + 4);
    const compLength = corrupt.readUInt32BE(44 + 8);
    const origLength = corrupt.readUInt32BE(44 + 12);
    expect(compLength).toBeLessThan(origLength);
    corrupt.fill(0, offset, offset + compLength);
    expect(woffToSfnt(corrupt, limit)).toBeNull();
    const longer = Buffer.from(woff);
    longer.writeUInt32BE(origLength + 4, 44 + 12);
    expect(woffToSfnt(longer, limit)).toBeNull();
  });

  it("refuses a font whose tables add up to more than the limit, before inflating any", () => {
    expect(woffToSfnt(woff, ttf.length - 1)).toBeNull();
    expect(woffToSfnt(woff, ttf.length)).not.toBeNull();
  });

  /**
   * Regression: the 4 byte padding was computed with 32 bit bitwise operators, so a table declaring an original length
   * near 4 GB padded to 0 (or a negative number), passed the bound, and was inflated with a 4 GB output ceiling: a small
   * zlib stream of zeros served as a `.woff` could make the installer allocate gigabytes before it said no.
   */
  it("refuses a table whose declared length is past the limit, however large, before inflating it", () => {
    const bomb = deflateSync(Buffer.alloc(64 * 1024));
    const hostile = Buffer.alloc(44 + 20 + bomb.length);
    hostile.write("wOFF", 0, "latin1");
    hostile.writeUInt32BE(0x00010000, 4);
    hostile.writeUInt32BE(hostile.length, 8);
    hostile.writeUInt16BE(1, 12);
    bomb.copy(hostile, 64);
    for (const origLength of [0xfffffffd, 0x80000000, 0xfffffffc]) {
      hostile.writeUInt32BE(0x676c7966, 44); // glyf
      hostile.writeUInt32BE(64, 44 + 4);
      hostile.writeUInt32BE(bomb.length, 44 + 8);
      hostile.writeUInt32BE(origLength, 44 + 12);
      zlibSpy.inflateSync.mockClear();

      expect(woffToSfnt(hostile, 8 * 1024 * 1024), origLength.toString(16)).toBeNull();
      expect(zlibSpy.inflateSync, origLength.toString(16)).not.toHaveBeenCalled();
    }
  });
});
