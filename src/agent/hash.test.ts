import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { MAX_INPUT_PIXELS, renderStats } from "@/server/scan/post/render-slot";
import { agentLimits } from "./limits";
import {
  DHASH_BITS,
  DHASH_CHARS,
  type ImageFingerprint,
  MIN_HASH_BITS,
  canonicalizeSvg,
  THUMB_SIDE,
  fingerprint,
  hammingDistance,
  sameVisual,
  sha1,
  thumbnailRmse,
} from "./hash";
import { templateCardImage } from "./testing";

/** A smooth deterministic pattern: it survives a resize and changes when it is mirrored. */
const pattern = (width: number, height: number, phase = 0): Promise<Buffer> => {
  const raw = Buffer.alloc(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = 128 + 110 * Math.sin((x / width) * 7 + phase) * Math.cos((y / height) * 3);
      raw[y * width + x] = Math.max(0, Math.min(255, Math.round(value)));
    }
  }
  return sharp(raw, { raw: { width, height, channels: 1 } }).png().toBuffer();
};

/** A wordmark, the case a 64 bit hash could not tell apart: dark text on a white or a transparent canvas. */
const wordmark = (text: string, background: "white" | "transparent"): Promise<Buffer> =>
  sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="200">` +
        `<rect width="800" height="200" fill="${background === "white" ? "#ffffff" : "none"}"/>` +
        `<text x="40" y="140" font-family="sans-serif" font-size="110" fill="#000">${text}</text></svg>`,
    ),
  )
    .png()
    .toBuffer();

/** A page with one horizontal band: plenty of contrast, none of it horizontal, so there is nothing to hash. */
const band = (top: boolean): Promise<Buffer> =>
  sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900"><rect width="1200" height="900" fill="#ffffff"/>` +
        `<rect y="${top ? 0 : 860}" width="1200" height="40" fill="#111111"/></svg>`,
    ),
  )
    .png()
    .toBuffer();

const printOf = async (buffer: Buffer): Promise<ImageFingerprint> => {
  const print = await fingerprint(buffer);
  if (print === null) throw new Error("expected a fingerprint");
  return print;
};

const distance = async (a: Buffer, b: Buffer): Promise<number> => hammingDistance((await printOf(a)).hash, (await printOf(b)).hash);

describe("fingerprint", () => {
  it("returns a 256 bit hash, the aspect ratio and a square thumbnail", async () => {
    const print = await printOf(await pattern(256, 192));
    expect(print.hash).toMatch(new RegExp(`^[0-9a-f]{${DHASH_CHARS}}$`));
    expect(print.aspect).toBeCloseTo(256 / 192);
    expect(print.thumbnail).toHaveLength(THUMB_SIDE * THUMB_SIDE);
  });

  it("survives a resize to half the size", async () => {
    expect(await distance(await pattern(256, 192), await sharp(await pattern(256, 192)).resize(128, 96).png().toBuffer())).toBeLessThanOrEqual(6);
  });

  it("changes when the image is mirrored", async () => {
    expect(await distance(await pattern(256, 192), await sharp(await pattern(256, 192)).flop().png().toBuffer())).toBeGreaterThanOrEqual(48);
  });

  it("flattens alpha onto white instead of dropping it", async () => {
    // Regression: sharp's greyscale drops the alpha channel, so a mark on a transparent canvas decoded to a near
    // uniform field and every transparent logo hashed to the same thing.
    const print = await printOf(await wordmark("ACME", "transparent"));
    expect(await printOf(await wordmark("ACME", "white"))).toEqual(print);
    expect(await distance(await wordmark("ACME", "transparent"), await wordmark("GLOBEX", "transparent"))).toBeGreaterThan(
      agentLimits.nearDuplicateDistance,
    );
  });

  it("gives no fingerprint to a field with no horizontal contrast", async () => {
    // Regression: both of these hashed to all zero bits, which made every flat page a duplicate of every other.
    expect(await fingerprint(await band(true))).toBeNull();
    expect(await fingerprint(await band(false))).toBeNull();
    expect(MIN_HASH_BITS).toBeGreaterThan(0);
  });

  it("returns null for bytes that are not an image", async () => {
    expect(await fingerprint(Buffer.from("<html>not an image</html>"))).toBeNull();
    expect(await fingerprint(Buffer.alloc(0))).toBeNull();
  });

  /**
   * The two guards v1 documents as necessary, which this call used to drop: `limitInputPixels` was sharp's 268 MP default
   * instead of `MAX_INPUT_PIXELS`, and `failOn: "none"` decoded bytes v1 refuses (review issue 3). A solid image just
   * over the cap is 211 KB on the wire and 268 MB decoded, so the wire caps guard nothing here.
   */
  it("refuses an image over the pixel cap the scan engine applies", async () => {
    const side = 8_193; // 8193 * 8193 is just over MAX_INPUT_PIXELS (8192 * 8192)
    const huge = await sharp(Buffer.alloc(side * side, 200), { raw: { width: side, height: side, channels: 1 } }).png().toBuffer();
    expect(huge.byteLength).toBeLessThan(agentLimits.maxDownloadBytes);
    expect(await sharp(huge, { limitInputPixels: false }).metadata()).toMatchObject({ width: side, height: side });
    expect(MAX_INPUT_PIXELS).toBe(8_192 * 8_192);

    expect(await fingerprint(huge)).toBeNull();
  }, 30_000);

  it("refuses bytes a lenient decoder would accept, the way the scan engine does", async () => {
    const png = await pattern(256, 192);
    // A PNG cut in half: `failOn: "none"` decodes what it has, `failOn: "error"` refuses it.
    const truncated = png.subarray(0, Math.floor(png.length / 2));
    expect(await sharp(truncated, { failOn: "none" }).greyscale().resize(8, 8, { fit: "fill" }).raw().toBuffer()).toBeInstanceOf(Buffer);

    expect(await fingerprint(truncated)).toBeNull();
  });

  it("never runs more sharp calls at once than the process-wide gate allows", async () => {
    const images = await Promise.all(Array.from({ length: 12 }, (_, index) => pattern(512, 384, index)));
    let most = 0;
    const sampler = setInterval(() => (most = Math.max(most, renderStats().active)), 1);
    try {
      await Promise.all(images.map((image) => fingerprint(image)));
    } finally {
      clearInterval(sampler);
    }
    expect(most).toBeGreaterThan(0);
    expect(most).toBeLessThanOrEqual(2);
    expect(renderStats().active).toBe(0);
  }, 30_000);
});

describe("canonicalizeSvg", () => {
  /** The verified case: one React component rendered twice, `useId` the only difference (review issue 8). */
  const accor = (id: string): string =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40">` +
      `<defs><linearGradient id="${id}"><stop offset="0" stop-color="#0a2540"/></linearGradient>` +
      `<clipPath id="${id}H1"><rect width="120" height="40"/></clipPath></defs>` +
      `<g clip-path="url(#${id}H1)"><path d="M0 0h120v40H0z" fill="url(#${id})"/><use xlink:href="#${id}H1"/></g></svg>`;

  it("folds two renders of one component onto the same bytes", () => {
    expect(canonicalizeSvg(accor(":Rij1mr6l6:"))).toBe(canonicalizeSvg(accor(":Ril1mr6l6:")));
    expect(sha1(Buffer.from(canonicalizeSvg(accor(":Rij1mr6l6:"))))).toBe(sha1(Buffer.from(canonicalizeSvg(accor(":Ril1mr6l6:")))));
    expect(accor(":Rij1mr6l6:")).not.toBe(accor(":Ril1mr6l6:"));
  });

  it("leaves colours alone, so two marks that differ only in colour stay two files", () => {
    const mark = (hex: string) => `<svg xmlns="http://www.w3.org/2000/svg"><rect width="118" height="32" rx="4" fill="${hex}"/></svg>`;
    expect(canonicalizeSvg(mark("#101D51"))).not.toBe(canonicalizeSvg(mark("#635bff")));
    expect(canonicalizeSvg(mark("#101D51"))).toBe(mark("#101D51"));
  });

  it("keeps two genuinely different drawings apart", () => {
    const one = '<svg xmlns="http://www.w3.org/2000/svg"><path id="a" d="M0 0h10v10H0z"/></svg>';
    const two = '<svg xmlns="http://www.w3.org/2000/svg"><path id="a" d="M0 0h20v10H0z"/></svg>';
    expect(canonicalizeSvg(one)).not.toBe(canonicalizeSvg(two));
  });
});

describe("sameVisual", () => {
  it("accepts a resize and a lossy re-encode of one picture", async () => {
    const full = await printOf(await pattern(1200, 900));
    const half = await printOf(await sharp(await pattern(1200, 900)).resize(600, 450).png().toBuffer());
    const lossy = await printOf(await sharp(await pattern(1200, 900)).jpeg({ quality: 70 }).toBuffer());
    expect(sameVisual(full, half, agentLimits.nearDuplicateDistance)).toBe(true);
    expect(sameVisual(full, lossy, agentLimits.nearDuplicateDistance)).toBe(true);
  });

  it("refuses two different wordmarks", async () => {
    // Regression: these are the assets a deck download exists to fetch, and a 64 bit hash put them 4 bits apart.
    const marks = await Promise.all(["ACME", "GLOBEX", "INITECH", "UMBRELLA"].map((text) => wordmark(text, "transparent").then(printOf)));
    for (let i = 0; i < marks.length; i += 1) {
      for (let j = i + 1; j < marks.length; j += 1) {
        expect(sameVisual(marks[i], marks[j], agentLimits.nearDuplicateDistance)).toBe(false);
      }
    }
  });

  it("refuses sibling assets cut from one template", async () => {
    // Regression: the confirmation check compared 16x16 thumbnails, where the only thing that separates these cards has
    // washed out, so six distinct cards came back as four files and two "near duplicates". The hash gate does not save
    // them either: these pairs are closer in Hamming distance than a genuine resize of one card, which is asserted here
    // so the test keeps exercising the pixel comparison rather than passing on the prefilter.
    const distance = agentLimits.nearDuplicateDistance;
    const cards = await Promise.all([0, 1, 2, 3, 4, 5].map((index) => templateCardImage(index).then(printOf)));
    for (let i = 0; i < cards.length; i += 1) {
      for (let j = i + 1; j < cards.length; j += 1) {
        expect(hammingDistance(cards[i].hash, cards[j].hash)).toBeLessThanOrEqual(distance);
        expect(sameVisual(cards[i], cards[j], distance)).toBe(false);
      }
    }
    // The same fixture still reads a real copy of one card as one picture.
    const card = await templateCardImage(0);
    for (const copy of [await sharp(card).resize(400, 300).png().toBuffer(), await sharp(card).resize(200, 150).png().toBuffer()]) {
      expect(sameVisual(cards[0], await printOf(copy), distance)).toBe(true);
    }
  });

  it("refuses a pair whose hashes agree but whose pixels do not", async () => {
    const print = await printOf(await pattern(1200, 900));
    const shifted: ImageFingerprint = { ...print, thumbnail: Buffer.from(print.thumbnail.map((byte) => 255 - byte)) };
    expect(hammingDistance(print.hash, shifted.hash)).toBe(0);
    expect(sameVisual(print, shifted, agentLimits.nearDuplicateDistance)).toBe(false);
  });

  it("refuses a pair whose aspect ratios disagree", async () => {
    const wide = await printOf(await pattern(1200, 300));
    const tall: ImageFingerprint = { ...wide, aspect: 0.5 };
    expect(sameVisual(wide, tall, agentLimits.nearDuplicateDistance)).toBe(false);
  });
});

describe("hammingDistance", () => {
  it("is 0 for equal hashes and symmetric", async () => {
    const a = (await printOf(await pattern(256, 192))).hash;
    const b = (await printOf(await pattern(256, 192, 1.7))).hash;
    expect(hammingDistance(a, a)).toBe(0);
    expect(hammingDistance(a, b)).toBe(hammingDistance(b, a));
  });

  it("gives up on hashes it cannot compare", () => {
    expect(hammingDistance("00ff", "00ffaa")).toBe(DHASH_BITS);
    expect(hammingDistance("z".repeat(DHASH_CHARS), "0".repeat(DHASH_CHARS))).toBe(DHASH_BITS);
  });
});

describe("thumbnailRmse", () => {
  it("is 0 for equal thumbnails and 255 for thumbnails it cannot compare", () => {
    expect(thumbnailRmse(Buffer.from([1, 2, 3]), Buffer.from([1, 2, 3]))).toBe(0);
    expect(thumbnailRmse(Buffer.from([0, 0]), Buffer.from([10, 0]))).toBeCloseTo(Math.sqrt(50));
    expect(thumbnailRmse(Buffer.alloc(0), Buffer.alloc(0))).toBe(255);
    expect(thumbnailRmse(Buffer.from([1]), Buffer.from([1, 2]))).toBe(255);
  });
});

describe("sha1", () => {
  it("hashes bytes", () => {
    expect(sha1(Buffer.from("abc"))).toBe("a9993e364706816aba3e25717850c26c9cd0d89d");
  });
});
