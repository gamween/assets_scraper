import { readFileSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Palette, type Swatch } from "@/lib/contract";
import { PALETTE_SOURCE } from "@/server/scan/inpage/generated/palette";
import { extractPalette } from "@/server/scan/palette";
import { buildPalette, toContractPalette } from "@/server/scan/palette/build";
import { hexToRgb, oklabDistance, rgbToOklab } from "@/server/scan/palette/color";
import { decodePng } from "@/server/scan/palette/png";
import { readSignals } from "@/server/scan/palette/signals";
import type { SafeFetch } from "@/server/scan/types";
import { serveFixture, type FixtureServer } from "../../fixtures/serve";

const CHROME =
  process.env.CHROME_EXECUTABLE_PATH ??
  (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/google-chrome");
const CONSENT_HTML = readFileSync(path.join(import.meta.dirname, "../../fixtures/palette/consent.html"));

/** SafeFetch stand-in (Track A owns the real one): plain fetch against the local fixture server, recording URLs. */
const fetched: string[] = [];
const fakeFetch: SafeFetch = async (url, options = {}) => {
  fetched.push(url);
  const res = await fetch(url, { method: options.method ?? "GET", headers: options.headers, signal: options.signal });
  const bytes = Buffer.from(await res.arrayBuffer());
  return {
    url: res.url,
    status: res.status,
    headers: res.headers,
    redirected: res.redirected,
    stream: () => new Response(bytes).body!,
    buffer: async () => bytes,
    text: async () => bytes.toString("utf8"),
    json: async <T>() => JSON.parse(bytes.toString("utf8")) as T,
    cancel: async () => {},
  };
};

const distance = (x: string, y: string) => oklabDistance(rgbToOklab(hexToRgb(x)), rgbToOklab(hexToRgb(y)));
const near = (swatches: Swatch[], hex: string, max = 0.08) => swatches.some((s) => distance(s.hex, hex) <= max);
const hiddenState = (page: Page) =>
  page.evaluate(() => ({
    attributes: document.querySelectorAll("[data-palette-hidden]").length,
    style: !!document.getElementById("__palette_hide_style"),
  }));

let server: FixtureServer;
let browser: Browser;
let context: BrowserContext;
let page: Page;
const signal = new AbortController().signal;

beforeAll(async () => {
  server = await serveFixture({
    "/consent.html": (_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(CONSENT_HTML);
    },
  });
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

beforeEach(async () => {
  fetched.length = 0;
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  page = await context.newPage();
});

afterEach(() => context.close());

describe("extractPalette", () => {
  it("extracts the fixture brand and text colors and leaves the DOM as it was", async () => {
    await page.goto(`${server.origin}/`, { waitUntil: "load" });
    await page.evaluate(PALETTE_SOURCE);

    const started = performance.now();
    const palette = await extractPalette(page, { fetch: fakeFetch, signal, timeBudgetMs: 3000 });
    const elapsed = performance.now() - started;

    expect(palette).not.toBeNull();
    expect(Palette.parse(palette)).toEqual(palette);
    expect(near(palette!.brand, "#ff3366") || near(palette!.brand, "#ee3333")).toBe(true);
    expect(near(palette!.neutrals, "#141e28")).toBe(true);
    expect(elapsed).toBeLessThan(2000);
    expect(await hiddenState(page)).toEqual({ attributes: 0, style: false });
    // icon and manifest requests go through the injected fetch
    expect(fetched).toContain(`${server.origin}/assets/touch.png`);
  });

  it("injects the in-page source itself and ignores a consent banner", async () => {
    await page.goto(`${server.origin}/consent.html`, { waitUntil: "load" });

    const palette = await extractPalette(page, { fetch: fakeFetch, signal, timeBudgetMs: 3000 });

    expect(palette).not.toBeNull();
    expect(near(palette!.brand, "#2f5bea")).toBe(true);
    expect(near([...palette!.brand, ...palette!.neutrals], "#00ff00")).toBe(false);
    expect(await hiddenState(page)).toEqual({ attributes: 0, style: false });
    expect(await page.locator("#onetrust-banner-sdk").isVisible()).toBe(true);
  });

  it("would pick the banner color without overlay hiding (fixture control)", async () => {
    await page.goto(`${server.origin}/consent.html`, { waitUntil: "load" });
    await page.evaluate(PALETTE_SOURCE);
    const signals = readSignals(await page.evaluate("globalThis.__assetsScraperPalette.collect({ hideOverlays: false })"));
    const pixels = decodePng(await page.screenshot({ type: "png" }));
    const palette = toContractPalette(buildPalette(signals!, pixels));
    expect(near(palette.brand, "#00ff00")).toBe(true);
  });

  it("returns null and restores the overlays when the time budget runs out during collection", async () => {
    await page.goto(`${server.origin}/consent.html`, { waitUntil: "load" });
    // Slow style reads make the in-page collection outlast the budget, after it has hidden the banner
    await page.evaluate(() => {
      const w = window as unknown as { __hiddenSeen: boolean };
      w.__hiddenSeen = false;
      new MutationObserver(() => {
        if (document.getElementById("onetrust-banner-sdk")?.hasAttribute("data-palette-hidden")) w.__hiddenSeen = true;
      }).observe(document.documentElement, { attributes: true, subtree: true, attributeFilter: ["data-palette-hidden"] });
      const original = window.getComputedStyle;
      window.getComputedStyle = (element, pseudo) => {
        const end = performance.now() + 40;
        while (performance.now() < end);
        return original(element, pseudo);
      };
    });

    const started = performance.now();
    const palette = await extractPalette(page, { fetch: fakeFetch, signal, timeBudgetMs: 300 });

    expect(palette).toBeNull();
    expect(performance.now() - started).toBeLessThan(1500);
    // queued after the restore, so it sees the page once collection and restore have both run
    expect(await page.evaluate(() => (window as unknown as { __hiddenSeen: boolean }).__hiddenSeen)).toBe(true);
    expect(await hiddenState(page)).toEqual({ attributes: 0, style: false });
    expect(await page.locator("#onetrust-banner-sdk").isVisible()).toBe(true);
  });

  it("returns null without touching the page when the scan is already aborted", async () => {
    await page.goto(`${server.origin}/consent.html`, { waitUntil: "load" });
    const controller = new AbortController();
    controller.abort();
    expect(await extractPalette(page, { fetch: fakeFetch, signal: controller.signal, timeBudgetMs: 3000 })).toBeNull();
    expect(await page.evaluate(() => typeof (globalThis as { __assetsScraperPalette?: unknown }).__assetsScraperPalette)).toBe("undefined");
    expect(fetched).toEqual([]);
  });

  it("returns null when the page is gone", async () => {
    await page.goto(`${server.origin}/`, { waitUntil: "load" });
    await page.close();
    expect(await extractPalette(page, { fetch: fakeFetch, signal, timeBudgetMs: 3000 })).toBeNull();
  });
});
