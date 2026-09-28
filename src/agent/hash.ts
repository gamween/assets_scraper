import { createHash } from "node:crypto";
import sharp from "sharp";
import { MAX_INPUT_PIXELS, withRenderSlot } from "@/server/scan/post/render-slot";

/**
 * Hashes used to drop the same image twice (spec 4.4, 4.5): SHA-1 of the bytes for an exact duplicate, and a
 * perceptual fingerprint for a visual one (the same logo at two sizes, the same photo from two CDNs).
 *
 * A 64 bit difference hash was not enough signal to tell two graphics apart: four black-on-white wordmarks set only 4
 * to 6 of its 64 bits, so unrelated marks landed inside any useful distance. The fingerprint here answers that in
 * three ways: alpha is flattened onto white before the greyscale, so a mark on a transparent canvas is not read as an
 * empty field; the hash is 256 bits, so a distinct visual is tens of bits away rather than a handful; and a candidate
 * pair is only a duplicate once the aspect ratios agree and a greyscale comparison says the pixels do too.
 *
 * The hash decides which pairs are worth comparing, never which pairs are the same picture. Sibling assets cut from one
 * template (six blog cards, four headshots on one backdrop) sit 2 to 5 bits apart, closer than a genuine resize of one
 * of them, so the pixel comparison is the whole answer and it needs enough pixels to carry the difference: measured on
 * such a set, a 16x16 comparison puts duplicates at up to 4.60 and distinct siblings from 3.33, and 32x32 at 6.70
 * against 4.24, both overlapping, while 64x64 puts duplicates at up to 1.52 and distinct siblings from 5.38.
 */

/** Greyscale field the hash is read from: one extra column, so each row yields 16 comparisons. */
export const FIELD_WIDTH = 17;
export const FIELD_HEIGHT = 16;

/** Side of the greyscale thumbnail the confirmation check compares, in pixels. */
export const THUMB_SIDE = 64;

/** Bits a fingerprint hash has, and so the distance of two hashes that have nothing in common. */
export const DHASH_BITS = (FIELD_WIDTH - 1) * FIELD_HEIGHT;

/** Hex characters of a fingerprint hash. */
export const DHASH_CHARS = DHASH_BITS / 4;

/**
 * Set bits a hash needs to carry a visual at all. A field with no horizontal contrast (a flat colour, a page with one
 * band across it) sets almost none of them, and grouping on such a hash merges anything: below the floor, or above its
 * mirror, the image gets no fingerprint and is never grouped, which keeps the file rather than losing it.
 */
export const MIN_HASH_BITS = DHASH_BITS / 16;
export const MAX_HASH_BITS = DHASH_BITS - MIN_HASH_BITS;

/** How far two aspect ratios may differ, as a share of the larger, before the pair is a different picture. */
export const MAX_ASPECT_DRIFT = 0.15;

/**
 * Root mean square difference of two `THUMB_SIDE` greyscale thumbnails, on the 0 to 255 scale, that still reads as the
 * same picture. A resize or a lossy re-encode of one image measures under 2 at this size; sibling assets from one
 * template measure 5 and up, and two different wordmarks tens. The gate sits below the distinct band rather than in the
 * middle of it: a duplicate a harsh re-encode pushes past it is one extra file on disk, while a distinct asset merged
 * away is a file the caller asked for and never gets.
 */
export const MAX_THUMB_RMSE = 3;

/** Alpha is composited onto white, the background a logo is drawn for, instead of being dropped. */
const FLATTEN_BACKGROUND = { r: 255, g: 255, b: 255 } as const;

export interface ImageFingerprint {
  /** The difference hash: `DHASH_BITS` bits as `DHASH_CHARS` hex characters. */
  hash: string;
  /** Width divided by height of the decoded raster. */
  aspect: number;
  /** A `THUMB_SIDE` square greyscale thumbnail, one byte per pixel, the confirmation check compares. */
  thumbnail: Buffer;
}

export const sha1 = (buffer: Buffer): string => createHash("sha1").update(buffer).digest("hex");

/**
 * The perceptual fingerprint of a raster, or null when there is nothing to compare: bytes sharp cannot decode, a size
 * it cannot report, or a hash with too little signal to group on. Both greyscale fields come from one input.
 *
 * The decode is opened with the two guards v1 documents as necessary (`render-slot.ts`, `post/tone.ts`): `limitInputPixels`
 * at `MAX_INPUT_PIXELS` rather than sharp's 268 MP default, and `failOn: "error"` rather than decoding bytes v1 refuses.
 * A 783 KB solid 16383x16383 PNG decodes to 268 MP and cost 736 ms and most of a gigabyte of peak RSS per file, on the
 * same function that drives Chromium; it is now refused, and the caller reads that as "no fingerprint", which keeps the
 * file rather than losing it. The call also waits for a render slot, so 60 of them cannot saturate the thread pool that
 * `dns.lookup` shares (review issue 3).
 */
export function fingerprint(buffer: Buffer, signal?: AbortSignal): Promise<ImageFingerprint | null> {
  return withRenderSlot(() => fingerprintInSlot(buffer), null, signal);
}

async function fingerprintInSlot(buffer: Buffer): Promise<ImageFingerprint | null> {
  let field: Buffer;
  let thumbnail: Buffer;
  let width: number | undefined;
  let height: number | undefined;
  try {
    const image = sharp(buffer, { failOn: "error", animated: false, limitInputPixels: MAX_INPUT_PIXELS });
    ({ width, height } = await image.metadata());
    const greyscale = (columns: number, rows: number): Promise<Buffer> =>
      image
        .clone()
        .flatten({ background: FLATTEN_BACKGROUND })
        .greyscale()
        .resize(columns, rows, { fit: "fill", kernel: "cubic" })
        .raw({ depth: "uchar" })
        .toBuffer();
    // One pipeline at a time: they are two decodes of the same input, and the slot this runs in is for one sharp call.
    field = await greyscale(FIELD_WIDTH, FIELD_HEIGHT);
    thumbnail = await greyscale(THUMB_SIDE, THUMB_SIDE);
  } catch {
    return null;
  }
  // One byte per pixel and nothing else: a field of any other shape would be read at the wrong offsets, and a hash
  // nobody can trust is worse than no hash, which only costs one file kept.
  if (!width || !height) return null;
  if (field.length !== FIELD_WIDTH * FIELD_HEIGHT || thumbnail.length !== THUMB_SIDE * THUMB_SIDE) return null;
  const hash = differenceHash(field);
  return hash === null ? null : { hash, aspect: width / height, thumbnail };
}

/** One bit per pair of neighbouring pixels, read row by row. Null when the field carries too little contrast. */
function differenceHash(field: Buffer): string | null {
  const bytes = Buffer.alloc(DHASH_BITS / 8);
  let set = 0;
  for (let y = 0; y < FIELD_HEIGHT; y += 1) {
    for (let x = 0; x < FIELD_WIDTH - 1; x += 1) {
      if (field[y * FIELD_WIDTH + x] <= field[y * FIELD_WIDTH + x + 1]) continue;
      const bit = y * (FIELD_WIDTH - 1) + x;
      bytes[bit >> 3] |= 1 << (7 - (bit & 7));
      set += 1;
    }
  }
  return set < MIN_HASH_BITS || set > MAX_HASH_BITS ? null : bytes.toString("hex");
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

/** Root mean square difference of two thumbnails, or 255 (as far apart as possible) when they cannot be compared. */
export function thumbnailRmse(a: Buffer, b: Buffer): number {
  if (a.length === 0 || a.length !== b.length) return 255;
  let total = 0;
  for (let index = 0; index < a.length; index += 1) {
    const difference = a[index] - b[index];
    total += difference * difference;
  }
  return Math.sqrt(total / a.length);
}

/**
 * Whether two fingerprints are the same picture: the hashes are within `maxDistance` bits, the aspect ratios agree,
 * and the thumbnails agree. The hash alone answers "worth comparing"; the last two answer "the same visual", which is
 * what keeps sibling assets cut from one template, and two different marks that happen to hash alike, as two files.
 */
export function sameVisual(a: ImageFingerprint, b: ImageFingerprint, maxDistance: number): boolean {
  if (hammingDistance(a.hash, b.hash) > maxDistance) return false;
  const drift = Math.abs(a.aspect - b.aspect) / Math.max(a.aspect, b.aspect);
  if (!Number.isFinite(drift) || drift > MAX_ASPECT_DRIFT) return false;
  return thumbnailRmse(a.thumbnail, b.thumbnail) <= MAX_THUMB_RMSE;
}
