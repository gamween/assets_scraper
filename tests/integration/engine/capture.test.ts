import { createHash } from "node:crypto";
import type http from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import type { Page, Response } from "playwright-core";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Tone } from "@/lib/contract";
import { withBrowser } from "@/server/browser/launch";
import { startCapture } from "@/server/scan/capture";
import { serveFixture, type FixtureServer } from "../../fixtures/serve";
import { delay, startTestProxy, type TestProxy } from "./helpers";

const ASSETS = path.join(import.meta.dirname, "../../fixtures/site/assets");
let fixture: FixtureServer;
let proxy: TestProxy;

/** A PNG of noise, about 60 KB (noise does not compress). */
const noisePng = sharp(Buffer.from(Array.from({ length: 140 * 140 * 3 }, () => Math.floor(Math.random() * 256))), { raw: { width: 140, height: 140, channels: 3 } }).png().toBuffer();

/** Headers at once, the body a little later with no declared length: the reads of all eight overlap. */
const slowImages = Object.fromEntries(
  Array.from({ length: 8 }, (_, i): [string, http.RequestListener] => [
    `/slow/${i}.png`,
    (_req, res) => {
      res.writeHead(200, { "content-type": "image/png" });
      res.flushHeaders();
      void noisePng.then((png) => setTimeout(() => res.end(png), 400));
    },
  ]),
);

/** The same noise PNGs sent gzip-encoded with their compressed length declared, the body a little later. */
const slowGzipImages = Object.fromEntries(
  Array.from({ length: 8 }, (_, i): [string, http.RequestListener] => [
    `/slow-gzip/${i}.png`,
    (_req, res) => {
      void noisePng.then((png) => {
        const body = gzipSync(png);
        res.writeHead(200, { "content-type": "image/png", "content-encoding": "gzip", "content-length": String(body.length) });
        res.flushHeaders();
        setTimeout(() => res.end(body), 400);
      });
    },
  ]),
);

/**
 * Responses of `/held.png`: headers and the PNG signature at once (Chrome reports an image response only once body
 * bytes arrive), the rest of the body only once the test calls `endHeld`.
 */
const held: http.ServerResponse[] = [];
const PNG_SIGNATURE_BYTES = 8;
const endHeld = async () => {
  const png = await noisePng;
  for (const res of held.splice(0)) res.end(png.subarray(PNG_SIGNATURE_BYTES));
};

const gzipped = (contentType: string, text: string) => (_req: http.IncomingMessage, res: http.ServerResponse) => {
  const body = gzipSync(text);
  res.writeHead(200, { "content-type": contentType, "content-encoding": "gzip", "content-length": String(body.length) });
  res.end(body);
};
/** Bodies of `/font/<name>.woff2`: a hostile page controls the bytes (and the number) of the font files it requests. */
const MiB = 1024 * 1024;
const fontBodies = new Map<string, Buffer>([["big", randomBytes(5 * MiB + 1)], ...Array.from({ length: 50 }, (_, i): [string, Buffer] => [String(i), randomBytes(1_024)])]);
/** Requests `/font/<name>.woff2` for each name, one after the other, and reads each body in the page. */
const fetchFonts = (page: Page, names: string[]) =>
  page.evaluate(async (list) => {
    for (const name of list) await fetch(`/font/${name}.woff2`).then((response) => response.arrayBuffer());
  }, names);
const fontNames = (count: number) => Array.from({ length: count }, (_, i) => String(i));

/** Base64 of random bytes: gzip saves only about a quarter of it. */
const bigSvg = `<svg xmlns="http://www.w3.org/2000/svg"><!-- ${randomBytes(90_000).toString("base64")} --></svg>`;
const smallSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>';

beforeAll(async () => {
  fixture = await serveFixture({
    ...slowImages,
    ...slowGzipImages,
    ...Object.fromEntries(
      [...fontBodies].map(([name, body]): [string, http.RequestListener] => [
        `/font/${name}.woff2`,
        (_req, res) => {
          res.writeHead(200, { "content-type": "font/woff2", "content-length": String(body.length) });
          res.end(body);
        },
      ]),
    ),
    "/fonts.html": (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html><title>Fonts</title>");
    },
    "/gzip/big.svg": gzipped("image/svg+xml", bigSvg),
    "/gzip/small.svg": gzipped("image/svg+xml", smallSvg),
    "/gzip.html": (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end('<!doctype html><title>Gzip</title><img src="/gzip/big.svg"><img src="/gzip/small.svg">');
    },
    "/many-gzip.html": (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><title>Many gzip</title>${Array.from({ length: 8 }, (_, i) => `<img src="/slow-gzip/${i}.png">`).join("")}`);
    },
    "/held.png": (_req, res) => {
      void noisePng.then((png) => {
        res.writeHead(200, { "content-type": "image/png" });
        res.write(png.subarray(0, PNG_SIGNATURE_BYTES));
        held.push(res);
      });
    },
    "/after.png": (_req, res) => {
      void noisePng.then((png) => {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(png);
      });
    },
    "/held.html": (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end('<!doctype html><title>Held</title><img src="/held.png">');
    },
    "/hang.html": (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end('<!doctype html><title>Hang</title><img src="/hang.png"><img src="/moved.png"><link rel="stylesheet" href="/assets/style.css">');
    },
    "/hang.png": (_req, res) => {
      res.writeHead(200, { "content-type": "image/png" });
      res.write(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    },
    // An MJPEG webcam: a multipart image stream whose body never ends.
    "/cam.mjpg": (_req, res) => {
      res.writeHead(200, { "content-type": "multipart/x-mixed-replace; boundary=frame" });
      res.write("--frame\r\ncontent-type: image/jpeg\r\n\r\n");
      held.push(res);
    },
    "/cam.html": (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end('<!doctype html><title>Cam</title><img src="/cam.mjpg">');
    },
    "/moved.png": (_req, res) => {
      res.writeHead(302, { location: "/assets/touch.png" });
      res.end();
    },
    "/flood.html": (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><title>Flood</title><link rel="stylesheet" href="/assets/style.css"><script>for (let i = 0; i < 60; i += 1) new Image().src = "/assets/pixel.gif?" + i;</script>`);
    },
    "/many.html": (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><title>Many</title>${Array.from({ length: 8 }, (_, i) => `<img src="/slow/${i}.png">`).join("")}`);
    },
  });
  proxy = await startTestProxy({ allow: [fixture.host] });
});

afterAll(async () => {
  await proxy.close();
  await fixture.close();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await endHeld();
});

/**
 * Chrome reports these image responses only once their bodies are in, so a read takes a few milliseconds and two reads
 * overlap only when their responses happen to land together. A read that starts alone waits (up to a second) until
 * another one runs beside it, so what keeps reads apart in the tests below is the body cap, not timing.
 */
function overlapGate() {
  let open = false;
  let release = () => {};
  const opened = new Promise<void>((resolve) => (release = resolve));
  return {
    started(inFlight: number) {
      if (inFlight < 2) return;
      open = true;
      release();
    },
    wait: () => (open ? undefined : Promise.race([opened, delay(1000)])),
  };
}

const onBrowser = <T>(fn: (page: Page) => Promise<T>) => withBrowser({ egressPort: proxy.port, signal: new AbortController().signal }, ({ page }) => fn(page));
const sha1 = (buffer: Buffer) => createHash("sha1").update(buffer).digest("hex");
const failing = () => {
  throw new Error("Not implemented");
};
/** Loads an image in the page, and resolves once the capture listener has seen its response. */
const loadImage = (page: Page, pathname: string) =>
  Promise.all([
    page.waitForResponse((response) => new URL(response.url()).pathname === pathname),
    page.evaluate((src) => new Promise((resolve, reject) => Object.assign(document.body.appendChild(new Image()), { onload: resolve, onerror: reject, src })), pathname),
  ]);
/** Opens `/held.html` and waits until the capture gave up on the read of `/held.png`. */
async function giveUpHeldRead(page: Page, bodyReadMs: number) {
  await page.goto(`${fixture.origin}/held.html`, { waitUntil: "domcontentloaded" });
  await expect.poll(() => held.length).toBe(1);
  // Nothing marks a read as given up: wait well past its timeout.
  await delay(bodyReadMs * 4);
}

describe("startCapture", () => {
  it("captures images, fonts and stylesheets of the fixture site", async () => {
    const network = await onBrowser(async (page) => {
      const capture = startCapture(page, { signal: new AbortController().signal, toneFromBytes: async () => failing(), parseFontBinary: failing });
      await page.goto(`${fixture.origin}/`, { waitUntil: "load" });
      await page.waitForFunction(() => (document.getElementById("blobimg") as HTMLImageElement | null)?.complete && (document.getElementById("blobimg") as HTMLImageElement).naturalWidth > 0);
      return capture.settle(5000);
    });

    const photoBytes = await readFile(path.join(ASSETS, "photo-small.png"));
    const photoMeta = await sharp(photoBytes).metadata();
    const photo = network.images.find((image) => image.url === `${fixture.origin}/assets/photo-small.png`);
    expect(photo).toEqual({
      url: `${fixture.origin}/assets/photo-small.png`,
      status: 200,
      contentType: "image/png",
      bytes: photoBytes.length,
      sha1: sha1(photoBytes),
      width: photoMeta.width,
      height: photoMeta.height,
      tone: "unknown",
    });

    const logo = network.images.find((image) => image.url.endsWith("/assets/logo.svg"));
    expect(logo?.svgText).toBe(await readFile(path.join(ASSETS, "logo.svg"), "utf8"));
    expect(logo).toMatchObject({ width: 100, height: 30 });

    const blob = network.images.find((image) => image.url.startsWith("blob:"));
    expect(blob?.blobBase64).toBe((await readFile(path.join(ASSETS, "iframe.png"))).toString("base64"));
    expect(network.images.filter((image) => image.blobBase64)).toHaveLength(1);

    const interBytes = await readFile(path.join(ASSETS, "__inter.woff2"));
    expect(network.fonts.find((font) => font.url.endsWith("/assets/__inter.woff2"))).toEqual({
      url: `${fixture.origin}/assets/__inter.woff2`,
      status: 200,
      contentType: "font/woff2",
      bytes: interBytes.length,
      sha1: sha1(interBytes),
      meta: null,
    });

    const sheet = network.sheets.find((entry) => entry.url.endsWith("/assets/style.css"));
    expect(sheet).toEqual({ url: `${fixture.origin}/assets/style.css`, status: 200, cssText: await readFile(path.join(ASSETS, "style.css"), "utf8") });
    expect(network.bodyTimeouts).toBe(0);
    expect(new Set(network.images.map((image) => image.url)).size).toBe(network.images.length);
  });

  it("uses the tone and font parsers when they work", async () => {
    const network = await onBrowser(async (page) => {
      const capture = startCapture(page, {
        signal: new AbortController().signal,
        toneFromBytes: async (_buffer, contentType) => (contentType === "image/png" ? "light" : "opaque"),
        parseFontBinary: (buffer) => ({ format: "woff2", familyName: `bytes ${buffer.length}` }),
      });
      await page.goto(`${fixture.origin}/`, { waitUntil: "load" });
      return capture.settle(5000);
    });
    expect(network.images.find((image) => image.url.endsWith("/photo-small.png"))?.tone).toBe("light");
    expect(network.images.find((image) => image.url.endsWith("/hero.jpg"))?.tone).toBe("opaque");
    expect(network.fonts.find((font) => font.url.endsWith("/__inter.woff2"))?.meta).toEqual({ format: "woff2", familyName: "bytes 48432" });
  });

  it("never parses a font file over 5 MiB", async () => {
    const parsed: number[] = [];
    const network = await onBrowser(async (page) => {
      const capture = startCapture(page, {
        signal: new AbortController().signal,
        parseFontBinary: (buffer) => {
          parsed.push(buffer.length);
          return { format: "woff2" };
        },
      });
      await page.goto(`${fixture.origin}/fonts.html`, { waitUntil: "load" });
      await fetchFonts(page, ["big", "0"]);
      return capture.settle(10_000);
    });
    expect(parsed).toEqual([1_024]);
    const big = network.fonts.find((font) => font.url.endsWith("/font/big.woff2"));
    expect(big).toMatchObject({ bytes: 5 * MiB + 1, sha1: sha1(fontBodies.get("big") as Buffer), meta: null });
    expect(network.fonts.find((font) => font.url.endsWith("/font/0.woff2"))?.meta).toEqual({ format: "woff2" });
  });

  it("parses at most 40 font files", async () => {
    let parsed = 0;
    const network = await onBrowser(async (page) => {
      const capture = startCapture(page, {
        signal: new AbortController().signal,
        parseFontBinary: () => {
          parsed += 1;
          return { format: "woff2" };
        },
      });
      await page.goto(`${fixture.origin}/fonts.html`, { waitUntil: "load" });
      await fetchFonts(page, fontNames(50));
      return capture.settle(10_000);
    });
    const fonts = network.fonts.filter((font) => /\/font\/\d+\.woff2$/.test(font.url));
    expect(fonts).toHaveLength(50);
    // Every file is still read and hashed; past the cap it has no metadata.
    expect(fonts.filter((font) => font.sha1)).toHaveLength(50);
    expect(parsed).toBe(40);
    expect(fonts.filter((font) => font.meta)).toHaveLength(40);
  });

  it("stops parsing font files once parsing took 1.5 s", async () => {
    let parsed = 0;
    const network = await onBrowser(async (page) => {
      const capture = startCapture(page, {
        signal: new AbortController().signal,
        // A slow parse blocks the event loop, like fontkit on a large font.
        parseFontBinary: () => {
          const started = performance.now();
          while (performance.now() - started < 100);
          parsed += 1;
          return { format: "woff2" };
        },
      });
      await page.goto(`${fixture.origin}/fonts.html`, { waitUntil: "load" });
      await fetchFonts(page, fontNames(30));
      return capture.settle(10_000);
    });
    const fonts = network.fonts.filter((font) => /\/font\/\d+\.woff2$/.test(font.url));
    expect(fonts.filter((font) => font.sha1)).toHaveLength(30);
    // 15 parses of at least 100 ms use the budget; on a busy machine each parse can take longer and use it sooner.
    expect(parsed).toBeGreaterThanOrEqual(10);
    expect(parsed).toBeLessThanOrEqual(15);
    expect(fonts.filter((font) => font.meta)).toHaveLength(parsed);
  });

  it("tones SVGs with their own budget and JPEGs for free", async () => {
    vi.stubEnv("TONE_MAX_RASTERS", "1");
    const network = await onBrowser(async (page) => {
      const capture = startCapture(page, { signal: new AbortController().signal, toneFromBytes: async () => "light" });
      await page.goto(`${fixture.origin}/`, { waitUntil: "networkidle" });
      return capture.settle(5000);
    });
    const read = network.images.filter((image) => image.sha1);
    const svgs = read.filter((image) => image.contentType.startsWith("image/svg"));
    const jpegs = read.filter((image) => image.contentType === "image/jpeg");
    const rasters = read.filter((image) => !svgs.includes(image) && !jpegs.includes(image));
    expect(svgs.length).toBeGreaterThan(0);
    expect(jpegs.length).toBeGreaterThan(0);
    expect(rasters.length).toBeGreaterThan(1);
    for (const image of svgs) expect(image.tone).toBe("light");
    for (const image of jpegs) expect(image.tone).toBe("opaque");
    expect(rasters.filter((image) => image.tone !== "unknown")).toHaveLength(1);
  });

  it("stops toning at the tone budget, counted while renders are in flight, and starts none once settled", async () => {
    vi.stubEnv("TONE_BUDGET_MS", "300");
    const signals: AbortSignal[] = [];
    // A render that never ends, as a librsvg render of a hostile SVG can take minutes and cannot be stopped.
    const hung = (_buffer: Buffer, _contentType: string, signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<Tone>(() => {});
    };
    const started = Date.now();
    const network = await onBrowser(async (page) => {
      const capture = startCapture(page, { signal: new AbortController().signal, toneFromBytes: hung });
      await page.goto(`${fixture.origin}/`, { waitUntil: "networkidle" });
      return capture.settle(10_000);
    });
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(signals.length).toBeGreaterThan(0);
    for (const image of network.images) expect(image.tone === "unknown" || image.tone === "opaque").toBe(true);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it("gives no tone to an SVG over the markup cap", async () => {
    vi.stubEnv("SVG_MAX_BYTES", "10");
    const toned: string[] = [];
    const network = await onBrowser(async (page) => {
      const capture = startCapture(page, {
        signal: new AbortController().signal,
        toneFromBytes: async (_buffer, contentType) => {
          toned.push(contentType);
          return "light";
        },
      });
      await page.goto(`${fixture.origin}/`, { waitUntil: "networkidle" });
      return capture.settle(5000);
    });
    const svgs = network.images.filter((image) => image.sha1 && image.contentType.startsWith("image/svg"));
    expect(svgs.length).toBeGreaterThan(0);
    for (const image of svgs) expect(image.tone).toBe("unknown");
    expect(toned.filter((type) => type.includes("svg"))).toEqual([]);
  });

  it("keeps the bytes of the reads in flight within the total body cap", async () => {
    vi.stubEnv("BODY_MAX_BYTES", "100000");
    vi.stubEnv("BODY_TOTAL_BYTES", "250000");
    let restore = () => {};
    let inFlight = 0;
    let maxInFlight = 0;
    const gate = overlapGate();
    try {
      const network = await onBrowser(async (page) => {
        // Registered before the capture listener, so reads made by the capture go through the counter.
        page.once("response", (response) => {
          const prototype = Object.getPrototypeOf(response) as { body: Response["body"] };
          const body = prototype.body;
          prototype.body = async function (this: Response) {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            gate.started(inFlight);
            try {
              await gate.wait();
              return await body.call(this);
            } finally {
              inFlight -= 1;
            }
          };
          restore = () => (prototype.body = body);
        });
        const capture = startCapture(page, { signal: new AbortController().signal, toneFromBytes: async () => "unknown" });
        await page.goto(`${fixture.origin}/many.html`, { waitUntil: "load" });
        return capture.settle(5000);
      });
      // No declared length: each read reserves the 100 KB per-body cap, so at most two fit in 250 KB at a time. Once
      // three bodies are read, a fourth still fits on its own, and the last four go over the total.
      const size = (await noisePng).length;
      expect(size).toBeGreaterThan(50_000);
      expect(maxInFlight).toBe(2);
      expect(network.images.filter((image) => image.sha1).map((image) => image.bytes)).toEqual([size, size, size, size]);
      expect(network.skippedBodies).toBe(4);
    } finally {
      restore();
    }
  });

  it("never reads an encoded body declared over a quarter of the body cap, and reads small encoded bodies decoded", async () => {
    vi.stubEnv("BODY_MAX_BYTES", "100000");
    const reads: string[] = [];
    let restore = () => {};
    try {
      const network = await onBrowser(async (page) => {
        page.once("response", (response) => {
          const prototype = Object.getPrototypeOf(response) as { body: Response["body"] };
          const body = prototype.body;
          prototype.body = function (this: Response) {
            reads.push(new URL(this.url()).pathname);
            return body.call(this);
          };
          restore = () => (prototype.body = body);
        });
        const capture = startCapture(page, { signal: new AbortController().signal, toneFromBytes: async () => "unknown" });
        await page.goto(`${fixture.origin}/gzip.html`, { waitUntil: "load" });
        return capture.settle(5000);
      });
      const big = network.images.find((image) => image.url.endsWith("/gzip/big.svg"));
      // About 90 KB on the wire for 120 KB of markup: the declared length is under the cap, the body is not.
      expect(gzipSync(bigSvg).length).toBeGreaterThan(25_000);
      expect(Buffer.byteLength(bigSvg)).toBeGreaterThan(100_000);
      expect(big).toMatchObject({ status: 200, contentType: "image/svg+xml" });
      expect(big?.sha1).toBeUndefined();
      expect(reads).not.toContain("/gzip/big.svg");
      expect(network.skippedBodies).toBeGreaterThanOrEqual(1);
      const small = network.images.find((image) => image.url.endsWith("/gzip/small.svg"));
      expect(small?.svgText).toBe(smallSvg);
      expect(small?.bytes).toBe(Buffer.byteLength(smallSvg));
    } finally {
      restore();
    }
  });

  it("reserves the per-body cap for an encoded body, whose declared length is only a lower bound", async () => {
    vi.stubEnv("BODY_MAX_BYTES", "400000");
    vi.stubEnv("BODY_TOTAL_BYTES", "1000000");
    let restore = () => {};
    let inFlight = 0;
    let maxInFlight = 0;
    const gate = overlapGate();
    let finished = 0;
    try {
      const network = await onBrowser(async (page) => {
        page.once("response", (response) => {
          const prototype = Object.getPrototypeOf(response) as { body: Response["body"] };
          const body = prototype.body;
          prototype.body = async function (this: Response) {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            gate.started(inFlight);
            try {
              await gate.wait();
              return await body.call(this);
            } finally {
              inFlight -= 1;
              finished += 1;
            }
          };
          restore = () => (prototype.body = body);
        });
        const capture = startCapture(page, { signal: new AbortController().signal, toneFromBytes: async () => "unknown" });
        await page.goto(`${fixture.origin}/many-gzip.html`, { waitUntil: "load" });
        // Reads still queued when capture settles never start: wait for all of them first.
        await expect.poll(() => finished, { timeout: 10_000 }).toBe(8);
        return capture.settle(5000);
      });
      // Each declares about 60 KB, under a quarter of the cap, but reserves 400 KB: two fit in 1 MB at a time.
      const size = (await noisePng).length;
      expect(gzipSync(await noisePng).length).toBeLessThan(100_000);
      expect(maxInFlight).toBe(2);
      expect(network.images.filter((image) => image.url.includes("/slow-gzip/") && image.sha1).map((image) => image.bytes)).toEqual(Array.from({ length: 8 }, () => size));
    } finally {
      restore();
    }
  });

  it("gives up on a body that never ends, skips redirects and settles on time", async () => {
    await onBrowser(async (page) => {
      const capture = startCapture(page, { signal: new AbortController().signal, bodyReadMs: 500 });
      await page.goto(`${fixture.origin}/hang.html`, { waitUntil: "domcontentloaded" });
      await expect.poll(() => page.evaluate(() => document.images[1]?.complete)).toBe(true);
      const started = Date.now();
      const network = await capture.settle(5000);
      expect(Date.now() - started).toBeLessThan(3000);
      expect(network.bodyTimeouts).toBe(1);
      const hang = network.images.find((image) => image.url.endsWith("/hang.png"));
      expect(hang).toMatchObject({ status: 200, contentType: "image/png" });
      expect(hang?.sha1).toBeUndefined();
      expect(network.images.some((image) => image.url.endsWith("/moved.png"))).toBe(false);
      expect(network.images.find((image) => image.url.endsWith("/assets/touch.png"))?.sha1).toBeDefined();
      for (const image of network.images) expect(Tone.options).toContain(image.tone);
    });
  });

  it("never reads a multipart stream, whose body does not end by design", async () => {
    await onBrowser(async (page) => {
      const capture = startCapture(page, { signal: new AbortController().signal, bodyReadMs: 500 });
      await Promise.all([page.waitForResponse((response) => response.url().endsWith("/cam.mjpg")), page.goto(`${fixture.origin}/cam.html`, { waitUntil: "domcontentloaded" })]);
      await delay(1000);
      const network = await capture.settle(5000);
      expect(network.bodyTimeouts).toBe(0);
      expect(network.skippedBodies).toBe(1);
    });
  });

  it("keeps the slot of a read it gave up until Playwright is done with the body", async () => {
    vi.stubEnv("BODY_CONCURRENCY", "1");
    const bodyReadMs = 200;
    const png = await noisePng;
    const network = await onBrowser(async (page) => {
      const toned: number[] = [];
      const capture = startCapture(page, {
        signal: new AbortController().signal,
        bodyReadMs,
        toneFromBytes: async (buffer) => {
          toned.push(buffer.length);
          return "unknown";
        },
      });
      await giveUpHeldRead(page, bodyReadMs);
      await loadImage(page, "/after.png");
      // With its slot free, the read of /after.png would take a few milliseconds.
      await delay(500);
      expect(toned).toEqual([]);
      await endHeld();
      await expect.poll(() => toned, { timeout: 5000 }).toEqual([png.length]);
      return capture.settle(5000);
    });
    expect(network.bodyTimeouts).toBe(1);
    expect(network.images.find((image) => image.url.endsWith("/held.png"))?.sha1).toBeUndefined();
    expect(network.images.find((image) => image.url.endsWith("/after.png"))).toMatchObject({ sha1: sha1(png), bytes: png.length });
  });

  it("counts the body of a read it gave up toward the total once the body lands", async () => {
    const png = await noisePng;
    const touch = await readFile(path.join(ASSETS, "touch.png"));
    // Room for the held body, the small image and half of another noise PNG.
    vi.stubEnv("BODY_TOTAL_BYTES", String(png.length + touch.length + Math.round(png.length / 2)));
    vi.stubEnv("BODY_CONCURRENCY", "1");
    const bodyReadMs = 200;
    const network = await onBrowser(async (page) => {
      const toned: number[] = [];
      const capture = startCapture(page, {
        signal: new AbortController().signal,
        bodyReadMs,
        toneFromBytes: async (buffer) => {
          toned.push(buffer.length);
          return "unknown";
        },
      });
      await giveUpHeldRead(page, bodyReadMs);
      await endHeld();
      // The only slot is free again, so the held body has landed, once the small image is read.
      await loadImage(page, "/assets/touch.png");
      await expect.poll(() => toned, { timeout: 5000 }).toEqual([touch.length]);
      await loadImage(page, "/after.png");
      return capture.settle(5000);
    });
    expect(network.bodyTimeouts).toBe(1);
    expect(network.images.find((image) => image.url.endsWith("/assets/touch.png"))?.sha1).toBe(sha1(touch));
    // The held body took its bytes: another noise PNG no longer fits in the total.
    expect(network.images.find((image) => image.url.endsWith("/after.png"))?.sha1).toBeUndefined();
    expect(network.skippedBodies).toBe(1);
  });

  it("returns from settle at its own timeout while a read is still pending", async () => {
    await onBrowser(async (page) => {
      const capture = startCapture(page, { signal: new AbortController().signal, bodyReadMs: 30_000 });
      await page.goto(`${fixture.origin}/hang.html`, { waitUntil: "domcontentloaded" });
      await expect.poll(() => page.evaluate(() => document.images[1]?.complete)).toBe(true);
      const started = Date.now();
      const network = await capture.settle(300);
      expect(Date.now() - started).toBeLessThan(2500);
      expect(network.bodyTimeouts).toBe(0);
      expect(network.images.find((image) => image.url.endsWith("/hang.png"))?.sha1).toBeUndefined();
    });
  });

  it("skips bodies over the size cap and stops recording once settled or aborted", async () => {
    vi.stubEnv("BODY_MAX_BYTES", "4000");
    await onBrowser(async (page) => {
      const controller = new AbortController();
      const capture = startCapture(page, { signal: controller.signal });
      await page.goto(`${fixture.origin}/`, { waitUntil: "networkidle" });
      controller.abort();
      await page.evaluate(() => fetch("/assets/og.png?after-abort").then((r) => r.blob()));
      const network = await capture.settle(5000);
      expect(network.skippedBodies).toBeGreaterThanOrEqual(2);
      expect(network.images.find((image) => image.url.endsWith("/hero.jpg"))?.sha1).toBeUndefined();
      expect(network.fonts.find((font) => font.url.endsWith("/__inter.woff2"))?.sha1).toBeUndefined();
      expect(network.images.find((image) => image.url.endsWith("/photo-small.png"))?.sha1).toBeDefined();
      expect(network.images.some((image) => image.url.endsWith("after-abort"))).toBe(false);
    });
  });

  it("stops recording new URLs past the record cap and counts what it dropped", async () => {
    const network = await onBrowser(async (page) => {
      const capture = startCapture(page, { signal: new AbortController().signal, maxRecords: 10, toneFromBytes: async () => "unknown" });
      await page.goto(`${fixture.origin}/flood.html`, { waitUntil: "networkidle" });
      return capture.settle(5000);
    });
    const records = network.images.length + network.fonts.length + network.sheets.length;
    expect(records).toBe(10);
    expect(network.sheets.map((sheet) => sheet.url)).toEqual([`${fixture.origin}/assets/style.css`]);
    expect(network.skippedBodies).toBeGreaterThanOrEqual(60 + 1 - 10);
  });
});
