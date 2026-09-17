import { EventEmitter } from "node:events";
import type { Page, Response } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startCapture } from "./capture";

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

  it("keeps scheduling cheap with thousands of reads waiting for the total cap", async () => {
    const page = new EventEmitter();
    const capture = startCapture(page as unknown as Page, { signal: new AbortController().signal, toneFromBytes: async () => "unknown", bodyReadMs: 60_000 });
    const count = 4_000;
    let reads = 0;
    let allStarted = () => {};
    const started = new Promise<void>((resolve) => (allStarted = resolve));
    const began = performance.now();
    // Without a declared length each read reserves the 15 MB body cap, so 16 fit in the 250 MB total: every completion
    // walks the rest of the queue.
    for (let i = 0; i < count; i += 1) page.emit("response", imageResponse(`https://example.com/${i}.png`, () => ++reads === count && setImmediate(allStarted)));
    await started;
    const network = await capture.settle(60_000);
    expect(network.images.filter((image) => image.sha1)).toHaveLength(count);
    // About 150 ms here; reading the limits on every step of the walk took about 10 s.
    expect(performance.now() - began).toBeLessThan(2_000);
  }, 60_000);
});
