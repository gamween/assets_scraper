import { EventEmitter } from "node:events";
import type { Page, Response } from "playwright-core";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startCapture } from "./capture";
import { LINEAR_OP_GROWTH_BOUND, opGrowth } from "./fonts/testing";

/**
 * Reads of a limit, counted. Each one parses the environment, which is why the capture reads them once per step rather
 * than once per queued read, and `opGrowth` checks that it still does.
 */
const limitReads = vi.hoisted(() => ({ count: 0 }));
vi.mock("@/server/config/limits", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/config/limits")>();
  const limits = new Proxy(actual.limits, {
    get(target, key, receiver) {
      limitReads.count += 1;
      return Reflect.get(target, key, receiver) as unknown;
    },
  });
  return { ...actual, limits };
});

// Counts the image header reads, and how many run at once
const metadataCalls = vi.hoisted(() => ({ total: 0, active: 0, peak: 0 }));
vi.mock("sharp", async (importOriginal) => {
  const actual = (await importOriginal<typeof import("sharp")>()).default;
  const wrapped = (...args: Parameters<typeof actual>) => {
    const instance = actual(...args);
    const metadata = instance.metadata.bind(instance);
    instance.metadata = (async () => {
      metadataCalls.total++;
      metadataCalls.peak = Math.max(metadataCalls.peak, ++metadataCalls.active);
      try {
        return await metadata();
      } finally {
        metadataCalls.active--;
      }
    }) as typeof instance.metadata;
    return instance;
  };
  return { default: Object.assign(wrapped, actual) };
});

/** A response the way the capture sees it, for an image served without a declared length. */
function imageResponse(url: string, onRead: () => void): Response {
  return {
    url: () => url,
    status: () => 200,
    headers: () => ({ "content-type": "image/png" }),
    request: () => ({ resourceType: () => "image" }),
    body: () => {
      onRead();
      return new Promise<Buffer>((resolve) => setImmediate(() => resolve(Buffer.alloc(8))));
    },
  } as unknown as Response;
}

const META = { format: "woff2" as const, familyName: "Fixture" };

/**
 * Emits one font response per entry of `sizes` (declared length and body of that many bytes), waits until every body
 * was read, then settles. Returns the captured fonts and how many times the parser ran.
 */
async function captureFonts(sizes: number[], parse: () => typeof META = () => META) {
  const page = new EventEmitter();
  let parsed = 0;
  let reads = 0;
  let allRead = () => {};
  const done = new Promise<void>((resolve) => (allRead = resolve));
  const capture = startCapture(page as unknown as Page, {
    signal: new AbortController().signal,
    parseFontBinary: () => {
      parsed += 1;
      return parse();
    },
  });
  sizes.forEach((bytes, i) => {
    const response = {
      url: () => `https://example.com/f${i}.woff2`,
      status: () => 200,
      headers: () => ({ "content-type": "font/woff2", "content-length": String(bytes) }),
      request: () => ({ resourceType: () => "font" }),
      body: () => {
        // Settling drops reads still queued behind bodyConcurrency, so settle only once the last read has run.
        if (++reads === sizes.length) setImmediate(allRead);
        return Promise.resolve(Buffer.alloc(bytes));
      },
    } as unknown as Response;
    page.emit("response", response);
  });
  await done;
  const network = await capture.settle(10_000);
  return { fonts: network.fonts, parsed };
}

describe("startCapture", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("parses at most fontParseMaxFiles fonts, the rest are hashed with meta null", async () => {
    vi.stubEnv("FONT_PARSE_MAX_FILES", "5");
    const { fonts, parsed } = await captureFonts(Array(30).fill(16));
    expect(fonts).toHaveLength(30);
    expect(fonts.every((font) => font.sha1)).toBe(true);
    expect(parsed).toBe(5);
    expect(fonts.filter((font) => font.meta)).toHaveLength(5);
    expect(fonts.filter((font) => font.meta === null)).toHaveLength(25);
  });

  it("parses 40 fonts by default out of many responses", async () => {
    const { fonts, parsed } = await captureFonts(Array(60).fill(16));
    expect(fonts).toHaveLength(60);
    expect(parsed).toBe(40);
    expect(fonts.filter((font) => font.meta === null)).toHaveLength(20);
  });

  it("skips parsing a font over fontParseMaxBytes", async () => {
    vi.stubEnv("FONT_PARSE_MAX_BYTES", "100");
    const { fonts, parsed } = await captureFonts([101, 100]);
    expect(parsed).toBe(1);
    expect(fonts.find((font) => font.url.endsWith("f0.woff2"))).toMatchObject({ bytes: 101, meta: null });
    expect(fonts.find((font) => font.url.endsWith("f1.woff2"))?.meta).toEqual(META);
  });

  it("stops parsing once fontParseBudgetMs is spent", async () => {
    vi.stubEnv("FONT_PARSE_BUDGET_MS", "20");
    const slowParse = () => {
      const until = performance.now() + 25;
      while (performance.now() < until);
      return META;
    };
    const { fonts, parsed } = await captureFonts(Array(10).fill(16), slowParse);
    expect(parsed).toBe(1);
    expect(fonts.filter((font) => font.meta === null)).toHaveLength(9);
  });

  it("replaces a failed response with a later good one for the same URL, and keeps the first good one", async () => {
    const page = new EventEmitter();
    const capture = startCapture(page as unknown as Page, { signal: new AbortController().signal, toneFromBytes: async () => "unknown", parseFontBinary: () => META });
    const reads: string[] = [];
    const bodies: Promise<unknown>[] = [];
    const respond = (url: string, status: number, type: "image" | "font" | "stylesheet", contentType: string, body: string) =>
      page.emit("response", {
        url: () => url,
        status: () => status,
        headers: () => ({ "content-type": contentType }),
        request: () => ({ resourceType: () => type }),
        body: () => {
          reads.push(`${status} ${url}`);
          const read = Promise.resolve(Buffer.from(body));
          bodies.push(read);
          return read;
        },
      } as unknown as Response);
    const image = "https://example.com/upload.png";
    const font = "https://example.com/a.woff2";
    const sheet = "https://example.com/a.css";
    respond(image, 503, "image", "text/html", "busy");
    respond(font, 404, "font", "text/html", "missing");
    respond(sheet, 500, "stylesheet", "text/html", "error");
    respond(image, 200, "image", "image/png", "first good");
    respond(font, 200, "font", "font/woff2", "font bytes");
    respond(sheet, 200, "stylesheet", "text/css", ".a{}");
    // A later answer never replaces a good one, failed or not
    respond(image, 404, "image", "text/html", "gone");
    respond(image, 200, "image", "image/png", "second good");
    await new Promise((resolve) => setImmediate(resolve));
    await Promise.all(bodies);
    const network = await capture.settle(10_000);

    expect(network.images.map(({ url, status, bytes }) => ({ url, status, bytes }))).toEqual([{ url: image, status: 200, bytes: "first good".length }]);
    expect(network.fonts.map(({ url, status, meta }) => ({ url, status, meta }))).toEqual([{ url: font, status: 200, meta: META }]);
    expect(network.sheets).toEqual([{ url: sheet, status: 200, cssText: ".a{}" }]);
    // Failed responses are never read, and a URL is read once
    expect(reads).toEqual([`200 ${image}`, `200 ${font}`, `200 ${sheet}`]);
  });

  it("reads raster headers through the render gate and sizes SVG markup without parsing it", async () => {
    // sharp works on the thread pool the egress proxy's DNS lookups share: up to 24 bodies land at once, and an SVG
    // header read is a whole librsvg parse, about 50 ms for a 1 MB illustration.
    const png = await sharp({ create: { width: 40, height: 30, channels: 4, background: "#123456" } }).png().toBuffer();
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="16"><rect width="64" height="16"/></svg>');
    const page = new EventEmitter();
    const capture = startCapture(page as unknown as Page, { signal: new AbortController().signal, toneFromBytes: async () => "unknown" });
    const bodies: Promise<Buffer>[] = [];
    const respond = (url: string, contentType: string, body: Buffer) =>
      page.emit("response", {
        url: () => url,
        status: () => 200,
        headers: () => ({ "content-type": contentType, "content-length": String(body.length) }),
        request: () => ({ resourceType: () => "image" }),
        body: () => {
          const read = Promise.resolve(body);
          bodies.push(read);
          return read;
        },
      } as unknown as Response);
    metadataCalls.total = metadataCalls.peak = 0;
    for (let i = 0; i < 20; i++) respond(`https://example.com/${i}.png`, "image/png", png);
    for (let i = 0; i < 4; i++) respond(`https://example.com/${i}.svg`, "image/svg+xml", svg);
    await new Promise((resolve) => setImmediate(resolve));
    await Promise.all(bodies);
    const network = await capture.settle(10_000);

    expect(network.images.filter((image) => image.url.endsWith(".png")).every((image) => image.width === 40 && image.height === 30)).toBe(true);
    expect(network.images.filter((image) => image.url.endsWith(".svg")).map(({ width, height }) => [width, height])).toEqual(Array(4).fill([64, 16]));
    expect(metadataCalls.total).toBe(20);
    expect(metadataCalls.peak).toBeLessThanOrEqual(2);
  });

  /**
   * Regression: the queue walk read the limits on every step, and each read parses the environment, so thousands of
   * reads waiting for the total cap took about 10 seconds to schedule. Counted rather than timed: eight times the
   * responses have to read the limits about eight times as often, not sixty four.
   */
  it("keeps scheduling cheap with thousands of reads waiting for the total cap", async () => {
    const run = async (count: number) => {
      const page = new EventEmitter();
      const capture = startCapture(page as unknown as Page, { signal: new AbortController().signal, toneFromBytes: async () => "unknown", bodyReadMs: 60_000 });
      let reads = 0;
      let allStarted = () => {};
      const started = new Promise<void>((resolve) => (allStarted = resolve));
      // Without a declared length each read reserves the 15 MB body cap, so 16 fit in the 250 MB total: every completion
      // walks the rest of the queue.
      for (let i = 0; i < count; i += 1) page.emit("response", imageResponse(`https://example.com/${i}.png`, () => ++reads === count && setImmediate(allStarted)));
      await started;
      const network = await capture.settle(60_000);
      expect(network.images.filter((image) => image.sha1)).toHaveLength(count);
    };
    const { small, factor } = await opGrowth(run, 500, limitReads);
    expect(small).toBeGreaterThan(0);
    expect(factor).toBeLessThan(LINEAR_OP_GROWTH_BOUND);
  }, 60_000);
});
