import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { createToneBudget, toneFromBytes, toneFromSvg } from "./tone";

/** A 32x32 PNG: `fill(x, y)` returns RGBA. */
const png = (fill: (x: number, y: number) => [number, number, number, number]) => {
  const data = Buffer.alloc(32 * 32 * 4);
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) data.set(fill(x, y), (y * 32 + x) * 4);
  }
  return sharp(data, { raw: { width: 32, height: 32, channels: 4 } }).png().toBuffer();
};
const inCircle = (x: number, y: number) => (x - 16) ** 2 + (y - 16) ** 2 < 100;

describe("toneFromBytes", () => {
  it("classifies transparent and opaque rasters", async () => {
    expect(await toneFromBytes(await png((x, y) => (inCircle(x, y) ? [255, 255, 255, 255] : [0, 0, 0, 0])), "image/png")).toBe("light");
    expect(await toneFromBytes(await png((x, y) => (inCircle(x, y) ? [0, 0, 0, 255] : [0, 0, 0, 0])), "image/png")).toBe("dark");
    expect(await toneFromBytes(await png(() => [220, 20, 20, 255]), "image/png")).toBe("opaque");
    expect(await toneFromBytes(await png((x) => (x < 16 ? [128, 128, 128, 255] : [0, 0, 0, 0])), "image/png")).toBe("mixed");
  });

  it("stays opaque when downscaling blurs the edges", async () => {
    const data = Buffer.alloc(1000 * 300 * 4, 255);
    const wide = await sharp(data, { raw: { width: 1000, height: 300, channels: 4 } }).png().toBuffer();
    expect(await toneFromBytes(wide, "image/png")).toBe("opaque");
    expect(await toneFromSvg('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="32" style="color: rgb(0, 0, 238)"><path fill="currentColor" d="M0 0h120v32H0z"/></svg>')).toBe("opaque");
    expect(await toneFromSvg('<svg xmlns="http://www.w3.org/2000/svg" width="20000" height="10000"><rect width="20000" height="10000" fill="#fff"/></svg>')).toBe("opaque");
  });

  it("does not decode JPEG", async () => {
    const notReallyJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    expect(await toneFromBytes(notReallyJpeg, "image/jpeg")).toBe("opaque");
    expect(await toneFromBytes(notReallyJpeg, "application/octet-stream")).toBe("opaque");
  });

  it("renders SVG bytes and gives unknown for invalid or empty input", async () => {
    expect(await toneFromBytes(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>'), "image/svg+xml")).toBe("opaque");
    expect(await toneFromBytes(Buffer.from("not an image"), "image/png")).toBe("unknown");
    expect(await toneFromBytes(Buffer.alloc(0), "image/png")).toBe("unknown");
    expect(await toneFromBytes(await png(() => [0, 0, 0, 0]), "image/png")).toBe("unknown");
  });
});

describe("toneFromSvg", () => {
  it("renders the markup", async () => {
    expect(await toneFromSvg('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#fff"/></svg>')).toBe("opaque");
    expect(await toneFromSvg('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><circle cx="5" cy="5" r="4" fill="#fff"/></svg>')).toBe("light");
    expect(await toneFromSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="rgb(20, 30, 40)"/></svg>')).toBe("dark");
    expect(await toneFromSvg("<svg")).toBe("unknown");
  });
});

describe("createToneBudget", () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4"/></svg>';
  /** An SVG that takes a while to render: `circles` translucent circles on a 2000 px canvas. */
  const heavy = (circles: number) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="2000">${Array.from(
      { length: circles },
      (_, i) => `<circle cx="${(i * 37) % 2000}" cy="${(i * 53) % 2000}" r="30" fill="#fff" fill-opacity="0.5"/>`,
    ).join("")}</svg>`;
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it("gives unknown past the count caps and the byte cap", async () => {
    const white = await png(() => [255, 255, 255, 255]);
    const budget = createToneBudget({ maxRasters: 1, maxSvgs: 1, maxBytes: 10_000, budgetMs: 60_000 });
    expect(await budget.raster(white, "image/png")).toBe("opaque");
    expect(await budget.raster(white, "image/png")).toBe("unknown");
    expect(await budget.svg(svg)).toBe("opaque");
    expect(await budget.svg(svg)).toBe("unknown");
    expect(await budget.raster(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg")).toBe("opaque");
    expect(await createToneBudget({ maxBytes: 10 }).raster(white, "image/png")).toBe("unknown");
  });

  it("only counts time spent rendering", async () => {
    const budget = createToneBudget({ budgetMs: 100 });
    await sleep(150);
    expect(await budget.svg(svg)).toBe("opaque");
    await sleep(150);
    expect(await budget.svg(svg)).toBe("opaque");
  });

  it("gives unknown when a render outlives the budget", async () => {
    const started = performance.now();
    expect(await createToneBudget({ budgetMs: 50 }).svg(heavy(20_000))).toBe("unknown");
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("stops starting renders once the budget is spent, however many were asked for at once", async () => {
    const budget = createToneBudget({ budgetMs: 400 });
    expect(await budget.svg(svg)).toBe("opaque");
    const markup = heavy(2_000);
    const started = performance.now();
    const tones = await Promise.all(Array.from({ length: 80 }, () => budget.svg(markup)));
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(tones.at(-1)).toBe("unknown");
    expect(tones.filter((tone) => tone === "unknown").length).toBeGreaterThan(40);
  });
});
