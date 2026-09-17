import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { createToneBudget, toneFromBytes, toneFromSvg, toneRenderStats } from "./tone";

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

  it("measures opacity as mean alpha, not as a count of fully opaque pixels", async () => {
    // Every pixel is 99 percent opaque: no pixel is fully opaque, yet the tile needs no background.
    expect(await toneFromBytes(await png(() => [255, 255, 255, 252]), "image/png")).toBe("opaque");
    expect(await toneFromBytes(await png(() => [255, 255, 255, 230]), "image/png")).toBe("light");
    // 97 percent of the pixels opaque, the rest transparent: under the threshold either way.
    expect(await toneFromBytes(await png((x, y) => (y === 0 && x < 31 ? [0, 0, 0, 0] : [255, 255, 255, 255])), "image/png")).toBe("light");
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
  /**
   * An SVG that takes a while to render (about 1.4 ms per copy on an M-series Mac) in little markup, as a hostile page's
   * SVGs are within `svgMaxBytes`: `copies` uses of a group of 100 blurred squares.
   */
  const heavy = (copies: number) => {
    const squares = Array.from({ length: 100 }, (_, i) => `<rect x="${(i * 37) % 200}" y="${(i * 53) % 200}" width="60" height="60" fill-opacity="0.5" filter="url(#b)"/>`).join("");
    const uses = Array.from({ length: copies }, (_, i) => `<use href="#g" x="${(i * 7) % 1800}" y="${(i * 11) % 1800}"/>`).join("");
    return `<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="2000"><defs><filter id="b"><feGaussianBlur stdDeviation="20"/></filter><g id="g">${squares}</g></defs>${uses}</svg>`;
  };
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
    expect(await createToneBudget({ budgetMs: 50 }).svg(heavy(400))).toBe("unknown");
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("keeps two renders in flight across budgets, renders a spent budget gave up on included, and starts no more", async () => {
    await expect.poll(() => toneRenderStats().active, { timeout: 30_000 }).toBe(0);
    const before = toneRenderStats().started;
    let most = 0;
    const sampler = setInterval(() => (most = Math.max(most, toneRenderStats().active)), 1);
    try {
      const markup = heavy(400);
      const budgets = [createToneBudget({ budgetMs: 50 }), createToneBudget({ budgetMs: 50 })];
      const tones = await Promise.all(budgets.flatMap((budget) => Array.from({ length: 4 }, () => budget.svg(markup))));
      expect(tones).toEqual(Array(8).fill("unknown"));
      // The two renders the budgets gave up on still hold their slots until they end.
      expect(toneRenderStats().active).toBe(2);
      await expect.poll(() => toneRenderStats().active, { timeout: 30_000 }).toBe(0);
      expect(toneRenderStats().started - before).toBe(2);
      expect(most).toBeLessThanOrEqual(2);
    } finally {
      clearInterval(sampler);
    }
  });

  it("starts nothing once its signal aborts, and skips SVGs over the markup cap", async () => {
    const before = toneRenderStats().started;
    const stopped = new AbortController();
    stopped.abort();
    const budget = createToneBudget({ signal: stopped.signal });
    expect(await budget.svg(svg)).toBe("unknown");
    expect(await budget.raster(await png(() => [255, 255, 255, 255]), "image/png")).toBe("unknown");
    expect(await createToneBudget({ maxSvgBytes: 10 }).svg(svg)).toBe("unknown");
    expect(await createToneBudget({ maxSvgBytes: 10 }).raster(Buffer.from(svg), "image/svg+xml")).toBe("unknown");
    expect(toneRenderStats().started).toBe(before);
  });

  it("stops starting renders once the budget is spent, however many were asked for at once", async () => {
    const markup = heavy(40);
    // The budget is sized from this machine's render time, so the test holds on fast and slow machines alike: two
    // renders' worth per render slot leaves most of the 80 renders unstarted.
    let renderMs = Infinity;
    for (let i = 0; i < 3; i++) {
      const start = performance.now();
      expect(await toneFromSvg(markup)).not.toBe("unknown");
      renderMs = Math.min(renderMs, performance.now() - start);
    }
    const budgetMs = Math.max(1, Math.round(renderMs * 2));
    const budget = createToneBudget({ budgetMs });
    expect(await budget.svg(svg)).toBe("opaque");
    const started = performance.now();
    const tones = await Promise.all(Array.from({ length: 80 }, () => budget.svg(markup)));
    expect(performance.now() - started).toBeLessThan(budgetMs + 1_000);
    expect(tones.at(-1)).toBe("unknown");
    expect(tones.filter((tone) => tone === "unknown").length).toBeGreaterThan(40);
  });
});
