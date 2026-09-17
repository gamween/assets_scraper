import { readFileSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Palette, type Swatch } from "@/lib/contract";
import { PALETTE_SOURCE } from "@/server/scan/inpage/generated/palette";
import { extractPalette, type ExtractPaletteOptions, type PaletteNullReason } from "@/server/scan/palette";
import { buildPalette, toContractPalette } from "@/server/scan/palette/build";
import { hexToRgb, oklabDistance, rgbToOklab } from "@/server/scan/palette/color";
import { decodePng } from "@/server/scan/palette/png";
import { readSignals, type RawPaletteSignals } from "@/server/scan/palette/signals";
import type { SafeFetch } from "@/server/scan/types";
import { serveFixture, type FixtureServer } from "../../fixtures/serve";

const CHROME =
  process.env.CHROME_EXECUTABLE_PATH ??
  (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/google-chrome");
const CONSENT_HTML = readFileSync(path.join(import.meta.dirname, "../../fixtures/palette/consent.html"));
/** Same value as RESTORE_WAIT_MS in extractPalette. */
const RESTORE_WAIT_MS = 500;
/** Slack for wall-clock assertions on a loaded CI runner. */
const MARGIN_MS = 1_000;

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
const html = (target: Page) => target.evaluate(() => document.documentElement.outerHTML);
const hiddenCount = (target: Page) => target.evaluate(() => document.querySelectorAll("[data-palette-hidden]").length);

/** A render-blocking stylesheet that never loads, in front of plain colored content. */
const NO_FRAME_HTML = `<!doctype html><html><head><link rel="stylesheet" href="/never.css"></head>
<body style="margin:0;background:#ffffff;color:#141e28"><header style="background:#2f5bea;height:120px">Brand</header>
<main><button style="background:#2f5bea;color:#fff">Start</button><p>Some text on the page</p></main></body></html>`;
const pending: import("node:http").ServerResponse[] = [];

let server: FixtureServer;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let reasons: PaletteNullReason[];
const signal = new AbortController().signal;
const extract = (target: Page, options: Partial<ExtractPaletteOptions> = {}) =>
  extractPalette(target, { fetch: fakeFetch, signal, timeBudgetMs: 3000, onNull: (reason) => reasons.push(reason), ...options });

beforeAll(async () => {
  server = await serveFixture({
    "/no-frame.html": (_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(NO_FRAME_HTML);
    },
    // Never answers, so the page never renders a frame
    "/never.css": (_req, res) => {
      pending.push(res);
    },
    "/consent.html": (_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(CONSENT_HTML);
    },
  });
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
});

afterAll(async () => {
  for (const res of pending) res.end();
  await browser?.close();
  await server?.close();
});

beforeEach(async () => {
  fetched.length = 0;
  reasons = [];
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  page = await context.newPage();
});

afterEach(() => context.close());

describe("extractPalette", () => {
  it("extracts the fixture brand and text colors and leaves the DOM as it was", async () => {
    await page.goto(`${server.origin}/`, { waitUntil: "load" });
    // Warm-up run (JIT, first screenshot), so the timing below measures a scan and not the test runner
    expect(await extract(page)).not.toBeNull();
    const before = await html(page);

    const started = performance.now();
    const palette = await extract(page);
    const elapsed = performance.now() - started;

    expect(palette).not.toBeNull();
    expect(Palette.parse(palette)).toEqual(palette);
    expect(near(palette!.brand, "#ff3366") || near(palette!.brand, "#ee3333")).toBe(true);
    expect(near(palette!.neutrals, "#141e28")).toBe(true);
    expect(elapsed).toBeLessThan(2000);
    expect(await html(page)).toBe(before);
    expect(reasons).toEqual([]);
    // icon and manifest requests go through the injected fetch
    expect(fetched).toContain(`${server.origin}/assets/touch.png`);
  });

  it("hides a consent banner that has its own !important display, then restores it exactly", async () => {
    await page.goto(`${server.origin}/consent.html`, { waitUntil: "load" });
    const before = await html(page);

    const palette = await extract(page);

    expect(palette).not.toBeNull();
    expect(near(palette!.brand, "#2f5bea")).toBe(true);
    expect(near([...palette!.brand, ...palette!.neutrals], "#00ff00")).toBe(false);
    expect(await html(page)).toBe(before);
    expect(await page.locator("#onetrust-banner-sdk").isVisible()).toBe(true);
    // nothing is installed on the page
    expect(await page.evaluate(() => typeof (globalThis as { __assetsScraperPalette?: unknown }).__assetsScraperPalette)).toBe("undefined");
  });

  it("would pick the banner color without overlay hiding (fixture control)", async () => {
    await page.goto(`${server.origin}/consent.html`, { waitUntil: "load" });
    await page.evaluate(PALETTE_SOURCE);
    const signals = readSignals(await page.evaluate("globalThis.__assetsScraperPalette.collect({ hideOverlays: false })"));
    const pixels = decodePng(await page.screenshot({ type: "png" }));
    const palette = toContractPalette(buildPalette(signals!, pixels));
    expect(near(palette.brand, "#00ff00")).toBe(true);
  });

  it("runs in an isolated world: page globals and overridden built-ins change nothing", async () => {
    await page.goto(`${server.origin}/consent.html`, { waitUntil: "load" });
    await page.evaluate(() => {
      const planted = { collect: () => ({ vw: 1, vh: 1, url: "x".repeat(1_000_000) }), restore() {}, decodeIconColors: async () => [] };
      Object.assign(globalThis, { __assetsScraperPalette: planted });
      window.getComputedStyle = () => {
        throw new Error("tampered");
      };
      CSS.supports = () => {
        throw new Error("tampered");
      };
    });

    const palette = await extract(page);

    expect(reasons).toEqual([]);
    expect(near(palette!.brand, "#2f5bea")).toBe(true);
    expect(near([...palette!.brand, ...palette!.neutrals], "#00ff00")).toBe(false);
    expect(await page.evaluate(() => (globalThis as unknown as { __assetsScraperPalette: { collect(): { vw: number } } }).__assetsScraperPalette.collect().vw)).toBe(1);
    expect(await hiddenCount(page)).toBe(0);
  });

  it("falls back to the main world when an isolated world cannot be created, still ignoring page globals", async () => {
    await page.goto(`${server.origin}/consent.html`, { waitUntil: "load" });
    await page.evaluate(() => {
      const w = window as unknown as { __styleReads: number; __assetsScraperPalette: unknown };
      w.__assetsScraperPalette = { collect: () => ({ vw: 1, vh: 1 }), restore() {}, decodeIconColors: async () => [] };
      w.__styleReads = 0;
      const original = window.getComputedStyle;
      window.getComputedStyle = (element, pseudo) => {
        w.__styleReads++;
        return original(element, pseudo);
      };
    });
    const before = await html(page);
    const withoutCdp = new Proxy(page, {
      get(target, key) {
        if (key === "context") return () => ({ newCDPSession: () => Promise.reject(new Error("CDP unavailable")) });
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const palette = await extract(withoutCdp);

    expect(reasons).toEqual([]);
    expect(near(palette!.brand, "#2f5bea")).toBe(true);
    expect(await page.evaluate(() => (window as unknown as { __styleReads: number }).__styleReads)).toBeGreaterThan(0);
    expect(await html(page)).toBe(before);
  });

  it("returns null within the budget and restores the overlays when collection outlasts it", async () => {
    await page.goto(`${server.origin}/consent.html`, { waitUntil: "load" });
    // A main-world custom element reaction runs synchronously inside the isolated-world hide: collection stalls for 3 s
    // after it has hidden the element
    await page.evaluate(() => {
      const w = window as unknown as { __hiddenSeen: boolean };
      w.__hiddenSeen = false;
      customElements.define(
        "slow-consent",
        class extends HTMLElement {
          static observedAttributes = ["data-palette-hidden"];
          attributeChangedCallback(_name: string, _old: string | null, value: string | null) {
            if (value === null) return;
            w.__hiddenSeen = true;
            const end = performance.now() + 3000;
            while (performance.now() < end);
          }
        },
      );
      const element = document.createElement("slow-consent");
      element.setAttribute("role", "dialog");
      element.setAttribute("style", "display:block;position:fixed;top:0;left:0;width:200px;height:80px");
      element.textContent = "We use cookies";
      document.body.append(element);
    });
    const before = await html(page);
    const timeBudgetMs = 1500;

    const started = performance.now();
    const palette = await extract(page, { timeBudgetMs });

    expect(palette).toBeNull();
    expect(reasons).toEqual(["timeout"]);
    expect(performance.now() - started).toBeLessThan(timeBudgetMs + MARGIN_MS);
    // the restore was queued behind the stalled collection and runs once the page is free
    await expect.poll(() => hiddenCount(page), { timeout: 10_000 }).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __hiddenSeen: boolean }).__hiddenSeen)).toBe(true);
    expect(await html(page)).toBe(before);
    expect(await page.locator("#onetrust-banner-sdk").isVisible()).toBe(true);
  });

  it("keeps the DOM signals when the screenshot times out because the page cannot render a frame", async () => {
    await page.goto(`${server.origin}/no-frame.html`, { waitUntil: "domcontentloaded" });
    const timeBudgetMs = 3000;

    const started = performance.now();
    const palette = await extract(page, { timeBudgetMs });

    expect(reasons).toEqual([]);
    expect(palette).not.toBeNull();
    expect(near(palette!.brand, "#2f5bea")).toBe(true);
    expect(performance.now() - started).toBeLessThan(timeBudgetMs + MARGIN_MS);
  });

  it("returns null without touching the page when the scan is already aborted", async () => {
    await page.goto(`${server.origin}/consent.html`, { waitUntil: "load" });
    const controller = new AbortController();
    controller.abort();
    const before = await html(page);
    expect(await extract(page, { signal: controller.signal })).toBeNull();
    expect(reasons).toEqual(["aborted"]);
    expect(await html(page)).toBe(before);
    expect(fetched).toEqual([]);
  });

  it("handles budgets that are too small, not a number, infinite or beyond timer range", async () => {
    await page.goto(`${server.origin}/consent.html`, { waitUntil: "load" });
    expect(await extract(page, { timeBudgetMs: RESTORE_WAIT_MS })).toBeNull();
    expect(await extract(page, { timeBudgetMs: Number.NaN })).toBeNull();
    expect(await extract(page, { timeBudgetMs: -1 })).toBeNull();
    expect(reasons).toEqual(["timeout", "timeout", "timeout"]);
    expect(fetched).toEqual([]);
    expect(near((await extract(page, { timeBudgetMs: Number.POSITIVE_INFINITY }))!.brand, "#2f5bea")).toBe(true);
    expect(near((await extract(page, { timeBudgetMs: 2 ** 33 }))!.brand, "#2f5bea")).toBe(true);
  });

  it("returns null when the page is gone", async () => {
    await page.goto(`${server.origin}/`, { waitUntil: "load" });
    await page.close();
    expect(await extract(page)).toBeNull();
    expect(reasons).toEqual(["page"]);
  });
});

describe("in-page collect", () => {
  const collect = (options: object) =>
    page.evaluate(`globalThis.__assetsScraperPalette.collect(${JSON.stringify(options)})`) as Promise<RawPaletteSignals>;

  it("checks the end of a large page for overlays first, and the walk keeps its own budget", async () => {
    await page.goto(`${server.origin}/consent.html`, { waitUntil: "load" });
    await page.evaluate(() => {
      const filler = document.createElement("div");
      filler.innerHTML = "<section><span>a</span><span>b</span><span>c</span><span>d</span></section>".repeat(20_000);
      document.querySelector("main")!.append(filler);
      // Not matched by the consent selectors: found by the fixed-position scan only
      const notice = document.createElement("div");
      notice.id = "notice";
      notice.setAttribute("style", "position:fixed;top:0;right:0;width:320px;height:120px;background:#ff00ff");
      notice.textContent = "This site uses cookies to measure traffic.";
      document.body.append(notice);
    });
    await page.evaluate(PALETTE_SOURCE);

    const signals = await collect({ overlayBudgetMs: 5, walkBudgetMs: 50, maxElements: 4000 });

    expect(await page.evaluate(() => document.getElementById("notice")!.hasAttribute("data-palette-hidden"))).toBe(true);
    expect(signals.stats.visited).toBeGreaterThan(256);
    await page.evaluate("globalThis.__assetsScraperPalette.restore()");
    expect(await hiddenCount(page)).toBe(0);
    expect(await page.evaluate(() => document.getElementById("notice")!.getAttribute("style"))).toBe(
      "position:fixed;top:0;right:0;width:320px;height:120px;background:#ff00ff",
    );
  });

  it("keeps long strings out of the result", async () => {
    await page.goto(`${server.origin}/consent.html`, { waitUntil: "load" });
    await page.evaluate(() => {
      const long = "x".repeat(200_000);
      const style = document.createElement("style");
      style.textContent = `:root { --brand: #2f5bea; ${Array.from({ length: 20 }, (_, i) => `--brand-${long}-${i}: #2f5bea;`).join(" ")} }`;
      document.head.append(style);
      const icon = document.createElement("link");
      icon.rel = "icon";
      icon.href = `/icon-${long}.png`;
      document.head.append(icon);
    });
    await page.evaluate(PALETTE_SOURCE);

    const signals = await collect({ hideOverlays: false });

    expect(signals.vars).toEqual([["--brand", "#2f5bea", 1]]);
    expect(signals.iconUrls.every((url) => url.length <= 2048)).toBe(true);
    expect(JSON.stringify(signals).length).toBeLessThan(50_000);
  });

  it("clamps out of range rgb() channels and ignores malformed ones, like the browser", async () => {
    await page.goto(`${server.origin}/consent.html`, { waitUntil: "load" });
    await page.evaluate(() => {
      const style = document.createElement("style");
      style.textContent = ":root { --brand: rgb(300, 20, 20); --primary: rgb(1.5.5, 20, 20); }";
      document.head.append(style);
    });
    await page.evaluate(PALETTE_SOURCE);

    const signals = await collect({ hideOverlays: false });

    expect(signals.vars).toEqual([["--brand", "#ff1414", 1]]);
  });
});
