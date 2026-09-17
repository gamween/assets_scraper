import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright-core";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Tone } from "@/lib/contract";
import { withBrowser } from "@/server/browser/launch";
import { startCapture } from "@/server/scan/capture";
import { serveFixture, type FixtureServer } from "../../fixtures/serve";
import { startTestProxy, type TestProxy } from "./helpers";

const ASSETS = path.join(import.meta.dirname, "../../fixtures/site/assets");
let fixture: FixtureServer;
let proxy: TestProxy;

beforeAll(async () => {
  fixture = await serveFixture({
    "/hang.html": (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end('<!doctype html><title>Hang</title><img src="/hang.png"><img src="/moved.png"><link rel="stylesheet" href="/assets/style.css">');
    },
    "/hang.png": (_req, res) => {
      res.writeHead(200, { "content-type": "image/png" });
      res.write(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    },
    "/moved.png": (_req, res) => {
      res.writeHead(302, { location: "/assets/touch.png" });
      res.end();
    },
  });
  proxy = await startTestProxy({ allow: [fixture.host] });
});

afterAll(async () => {
  await proxy.close();
  await fixture.close();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const onBrowser = <T>(fn: (page: Page) => Promise<T>) => withBrowser({ egressPort: proxy.port, signal: new AbortController().signal }, ({ page }) => fn(page));
const sha1 = (buffer: Buffer) => createHash("sha1").update(buffer).digest("hex");
const failing = () => {
  throw new Error("Not implemented");
};

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
});
