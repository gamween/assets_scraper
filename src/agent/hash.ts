import { createHash } from "node:crypto";
import sharp from "sharp";

/**
 * Hashes used to drop the same image twice (spec 4.4, 4.5): SHA-1 of the bytes for an exact duplicate, and a 64 bit
 * difference hash for a visual one (the same logo at two sizes, the same photo from two CDNs).
 */

/** Hex characters of a dHash: 64 bits. */
export const DHASH_CHARS = 16;

/** Bits a dHash has, and so the distance of two hashes that have nothing in common. */
export const DHASH_BITS = 64;

export const sha1 = (buffer: Buffer): string => createHash("sha1").update(buffer).digest("hex");

/**
 * The difference hash of a raster: 9x8 greyscale, one bit per pair of neighbouring pixels, read row by row, so a
 * resize keeps the hash and a different image changes it. Null for bytes sharp cannot decode as a raster.
 */
export async function dHash(buffer: Buffer): Promise<string | null> {
  let raw: Buffer;
  try {
    raw = await sharp(buffer, { failOn: "none", animated: false })
      .greyscale()
      .resize(9, 8, { fit: "fill", kernel: "cubic" })
      .raw()
      .toBuffer();
  } catch {
    return null;
  }
  if (raw.length < 9 * 8) return null;
  const bytes = Buffer.alloc(8);
  for (let y = 0; y < 8; y += 1) {
    let byte = 0;
    for (let x = 0; x < 8; x += 1) if (raw[y * 9 + x] > raw[y * 9 + x + 1]) byte |= 1 << (7 - x);
    bytes[y] = byte;
  }
  return bytes.toString("hex");
}

const POPCOUNT = Uint8Array.from({ length: 256 }, (_, byte) => byte.toString(2).replace(/0/g, "").length);

/**
 * How many bits two hex hashes differ by. Hashes of different lengths, or anything that is not hex, have nothing in
 * common: the answer is `DHASH_BITS`, so such a pair is never a duplicate.
 */
export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length || a.length % 2 !== 0) return DHASH_BITS;
  let distance = 0;
  for (let index = 0; index < a.length; index += 2) {
    const left = Number.parseInt(a.slice(index, index + 2), 16);
    const right = Number.parseInt(b.slice(index, index + 2), 16);
    if (!Number.isInteger(left) || !Number.isInteger(right)) return DHASH_BITS;
    distance += POPCOUNT[left ^ right];
  }
  return distance;
}
