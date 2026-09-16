import { crc32, deflateSync } from "node:zlib";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { decodePng } from "./png";

/** 4x4 RGBA image with a distinct color per pixel, so any filter or offset bug shows up. */
const PIXELS = Uint8Array.from({ length: 64 }, (_, i) => (i % 4 === 3 ? 255 - (i % 7) * 20 : (i * 37 + 11) % 256));

describe("decodePng", () => {
  it("decodes RGBA written by sharp", async () => {
    const png = await sharp(Buffer.from(PIXELS), { raw: { width: 4, height: 4, channels: 4 } })
      .png({ adaptiveFiltering: true, compressionLevel: 9 })
      .toBuffer();
    const decoded = decodePng(png);
    expect(decoded).toMatchObject({ width: 4, height: 4, channels: 4 });
    expect(Array.from(decoded.data)).toEqual(Array.from(PIXELS));
  });

  it("decodes RGB without alpha", async () => {
    const rgb = Uint8Array.from({ length: 48 }, (_, i) => (i * 53 + 7) % 256);
    const png = await sharp(Buffer.from(rgb), { raw: { width: 4, height: 4, channels: 3 } }).png().toBuffer();
    const decoded = decodePng(png);
    expect(decoded).toMatchObject({ width: 4, height: 4, channels: 3 });
    expect(Array.from(decoded.data)).toEqual(Array.from(rgb));
  });

  it("decodes a larger image written by sharp", async () => {
    const width = 300, height = 200;
    const raw = Buffer.alloc(width * height * 4);
    for (let i = 0; i < raw.length; i += 4) raw.set([(i >> 2) % 251, (i >> 3) % 241, (i >> 5) % 239, 255], i);
    const png = await sharp(raw, { raw: { width, height, channels: 4 } }).png({ adaptiveFiltering: true }).toBuffer();
    const decoded = decodePng(png);
    expect(decoded.width).toBe(width);
    expect(Buffer.from(decoded.data).equals(raw)).toBe(true);
  });

  it("undoes all five filter types across several IDAT chunks", () => {
    const width = 7, height = 10, channels = 3, stride = width * channels;
    const pixels = Buffer.from(Array.from({ length: width * height * channels }, (_, i) => (i * 97 + (i >> 3) * 13) % 256));
    const at = (row: number, i: number) => (row >= 0 && i >= 0 ? pixels[row * stride + i] : 0);
    const paeth = (a: number, b: number, c: number) => {
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    };
    const filtered: number[] = [];
    for (let y = 0; y < height; y++) {
      const filter = y % 5;
      filtered.push(filter);
      for (let i = 0; i < stride; i++) {
        const x = at(y, i), a = at(y, i - channels), b = at(y - 1, i), c = at(y - 1, i - channels);
        const predictor = [0, a, b, (a + b) >> 1, paeth(a, b, c)][filter];
        filtered.push((x - predictor + 256) & 255);
      }
    }
    const chunk = (type: string, body: Buffer) => {
      const head = Buffer.alloc(8);
      head.writeUInt32BE(body.length);
      head.write(type, 4, "latin1");
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])));
      return Buffer.concat([head, body, crc]);
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header.set([8, 2, 0, 0, 0], 8);
    const data = deflateSync(Buffer.from(filtered));
    const png = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", header),
      chunk("IDAT", data.subarray(0, 20)),
      chunk("IDAT", data.subarray(20)),
      chunk("IEND", Buffer.alloc(0)),
    ]);
    const decoded = decodePng(png);
    expect(decoded).toMatchObject({ width, height, channels });
    expect(Buffer.from(decoded.data).equals(pixels)).toBe(true);
  });

  it("rejects what it cannot decode", async () => {
    expect(() => decodePng(new Uint8Array([1, 2, 3]))).toThrow();
    const gray = await sharp(Buffer.alloc(16, 128), { raw: { width: 4, height: 4, channels: 1 } })
      .toColourspace("b-w")
      .png()
      .toBuffer();
    expect(() => decodePng(gray)).toThrow(/unsupported/);
    const palette = await sharp(Buffer.from(PIXELS), { raw: { width: 4, height: 4, channels: 4 } }).png({ palette: true }).toBuffer();
    expect(() => decodePng(palette)).toThrow(/unsupported/);
  });
});
