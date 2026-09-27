import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { DHASH_BITS, dHash, hammingDistance, sha1 } from "./hash";

/** A smooth deterministic pattern: it survives a resize and changes when it is mirrored. */
const pattern = (width: number, height: number): Promise<Buffer> => {
  const raw = Buffer.alloc(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = 128 + 110 * Math.sin((x / width) * 7) * Math.cos((y / height) * 3);
      raw[y * width + x] = Math.max(0, Math.min(255, Math.round(value)));
    }
  }
  return sharp(raw, { raw: { width, height, channels: 1 } }).png().toBuffer();
};

const hashOf = async (buffer: Buffer): Promise<string> => {
  const hash = await dHash(buffer);
  if (hash === null) throw new Error("expected a hash");
  return hash;
};

describe("dHash", () => {
  it("returns 16 hex characters for a raster", async () => {
    expect(await hashOf(await pattern(256, 192))).toMatch(/^[0-9a-f]{16}$/);
  });

  it("survives a resize to half the size", async () => {
    const full = await hashOf(await pattern(256, 192));
    const half = await hashOf(await sharp(await pattern(256, 192)).resize(128, 96).png().toBuffer());
    expect(hammingDistance(full, half)).toBeLessThanOrEqual(2);
  });

  it("changes when the image is mirrored", async () => {
    const full = await hashOf(await pattern(256, 192));
    const flipped = await hashOf(await sharp(await pattern(256, 192)).flop().png().toBuffer());
    expect(hammingDistance(full, flipped)).toBeGreaterThanOrEqual(12);
  });

  it("returns null for bytes that are not an image", async () => {
    expect(await dHash(Buffer.from("<html>not an image</html>"))).toBeNull();
    expect(await dHash(Buffer.alloc(0))).toBeNull();
  });
});

describe("hammingDistance", () => {
  it("is 0 for equal hashes and symmetric", async () => {
    const a = await hashOf(await pattern(256, 192));
    const b = await hashOf(await sharp(await pattern(256, 192)).flop().png().toBuffer());
    expect(hammingDistance(a, a)).toBe(0);
    expect(hammingDistance(a, b)).toBe(hammingDistance(b, a));
  });

  it("gives up on hashes it cannot compare", () => {
    expect(hammingDistance("00ff", "00ffaa")).toBe(DHASH_BITS);
    expect(hammingDistance("zzzzzzzzzzzzzzzz", "0000000000000000")).toBe(DHASH_BITS);
  });
});

describe("sha1", () => {
  it("hashes bytes", () => {
    expect(sha1(Buffer.from("abc"))).toBe("a9993e364706816aba3e25717850c26c9cd0d89d");
  });
});
