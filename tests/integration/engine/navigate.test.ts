import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { withBrowser } from "@/server/browser/launch";
import { ScanFailure } from "@/server/errors";
import { loadAndScroll, openPage, prepareForCollection, readPageFacts } from "@/server/scan/navigate";
import { serveFixture, type FixtureServer } from "../../fixtures/serve";
import { startTestProxy, type TestProxy } from "./helpers";

let fixture: FixtureServer;
let proxy: TestProxy;

const html = (body: string) => (_req: unknown, res: import("node:http").ServerResponse) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><head><title>Test</title></head><body style="margin:0">${body}</body></html>`);
};

beforeAll(async () => {
  const inter = await readFile(path.join(import.meta.dirname, "../../fixtures/site/assets/__inter.woff2"));
  fixture = await serveFixture({
    "/lazy.html": html(`<div style="height:6000px">Tall page</div><div id="target" style="height:10px"></div>
      <script>new IntersectionObserver((entries, observer) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        const img = new Image(); img.id = "lazy"; img.src = "/assets/lazy.jpg"; document.body.append(img);
      }).observe(document.getElementById("target"));</script>`),
    "/smooth.html": html(`<style>html { scroll-behavior: smooth }</style><div style="height:5000px"></div><img loading="lazy" id="bottom" src="/assets/og.png">`),
    "/animated.html": html(`<style>
        @font-face { font-family: Slow; src: url(/slow.woff2) format("woff2"); }
        @keyframes fade { from { opacity: 0 } to { opacity: 1 } }
        @keyframes spin { to { transform: rotate(360deg) } }
        #box { animation: fade 10s linear; width: 10px; height: 10px }
        #spinner { animation: spin 1s linear infinite; width: 10px; height: 10px }
      </style><div id="box"></div><div id="spinner"></div><p style="font-family: Slow">Slow font</p>`),
    "/slow.woff2": (_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "font/woff2" });
        res.end(inter);
      }, 800);
    },
    "/loop.html": html(`<div style="height:6000px">Busy page</div><script>setTimeout(() => { for (;;) {} }, 1000)</script>`),
    "/never.html": () => {},
    "/heavy.html": (_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      const rows = Array.from({ length: 6000 }, (_, i) => `<div class="row" data-note="${"n".repeat(200)}">Row ${i}</div>`).join("");
      res.end(`<!doctype html><html><head><title>Heavy</title><script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script><script>window._pxAppId = "PX123";</script></head><body>${rows}<script>/* ${"x".repeat(50_000)} */</script><div id="px-captcha"></div></body></html>`);
    },
    "/patched.html": html(`<div>One</div><div>Two</div><script>document.getElementsByTagName = () => ({ length: 1e9 }); Object.defineProperty(document, "title", { get: () => "Just a moment..." });</script>`),
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

const idle = () => new AbortController().signal;
const onBrowser = <T>(fn: (page: Page) => Promise<T>) => withBrowser({ egressPort: proxy.port, signal: idle() }, ({ page }) => fn(page));

describe("openPage", () => {
  it("navigates and reports status, title, final URL, headers, element count and an HTML sample", async () => {
    await onBrowser(async (page) => {
      const result = await openPage(page, `${fixture.origin}/`, { signal: idle() });
      expect(result.status).toBe(200);
      expect(result.title).toBe("Fixture Co");
      expect(result.finalUrl).toBe(`${fixture.origin}/`);
      expect(result.headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(result.elementCount).toBeGreaterThan(30);
    });
  });

  it("maps a failed connection to connect and a slow page to timeout", async () => {
    await onBrowser(async (page) => {
      const refused = await openPage(page, "https://unreachable.example/", { signal: idle() }).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(ScanFailure);
      expect((refused as ScanFailure).code).toBe("connect");

      vi.stubEnv("GOTO_MS", "700");
      const slow = await openPage(page, `${fixture.origin}/never.html`, { signal: idle() }).catch((error: unknown) => error);
      expect(slow).toBeInstanceOf(ScanFailure);
      expect((slow as ScanFailure).code).toBe("timeout");
    });
  });
});

describe("readPageFacts", () => {
  it("reads the element count and a markup sample bounded in size, from the start of the document", async () => {
    await onBrowser(async (page) => {
      await openPage(page, `${fixture.origin}/heavy.html`, { signal: idle() });
      const facts = await readPageFacts(page, { signal: idle(), sampleChars: 4000 });
      expect(facts?.title).toBe("Heavy");
      expect(facts?.elementCount).toBeGreaterThan(6000);
      expect(facts?.htmlSample.length).toBeLessThanOrEqual(4000);
      expect(facts?.htmlSample).toContain('<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js">');
      expect(facts?.htmlSample).toContain('window._pxAppId = "PX123"');
      expect(facts?.htmlSample).not.toContain("px-captcha");
    });
  });

  it("is not fooled by a page that patches the DOM API in its own world", async () => {
    await onBrowser(async (page) => {
      await openPage(page, `${fixture.origin}/patched.html`, { signal: idle() });
      const facts = await readPageFacts(page, { signal: idle() });
      expect(facts).toMatchObject({ title: "Test" });
      expect(facts?.elementCount).toBeLessThan(20);
    });
  });

  it("gives null when the page is stuck, and rejects when the signal aborts", async () => {
    await onBrowser(async (page) => {
      await openPage(page, `${fixture.origin}/loop.html`, { signal: idle() });
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const started = Date.now();
      expect(await readPageFacts(page, { signal: idle() })).toBeNull();
      expect(Date.now() - started).toBeLessThan(5000);
      const controller = new AbortController();
      setTimeout(() => controller.abort(new Error("scan deadline")), 200);
      await expect(readPageFacts(page, { signal: controller.signal })).rejects.toThrow("scan deadline");
    });
  });
});

describe("loadAndScroll", () => {
  it("runs onLoaded once the page has loaded, before it scrolls, and stops when onLoaded rejects", async () => {
    await onBrowser(async (page) => {
      await openPage(page, `${fixture.origin}/lazy.html`, { signal: idle() });
      const steps: string[] = [];
      const onLoaded = async () => {
        steps.push(`loaded ${await page.evaluate(() => document.readyState)}`);
      };
      await loadAndScroll(page, { signal: idle(), onStep: (step, state) => steps.push(`${step} ${state}`), onLoaded });
      expect(steps).toEqual(["load start", "load done", "loaded complete", "scroll start", "scroll done"]);

      steps.length = 0;
      const blocked = loadAndScroll(page, { signal: idle(), onStep: (step, state) => steps.push(`${step} ${state}`), onLoaded: () => Promise.reject(new Error("blocked")) });
      await expect(blocked).rejects.toThrow("blocked");
      expect(steps).toEqual(["load start", "load done"]);
    });
  });

  it("reports its steps and scrolls lazy content into view, then back to the top", async () => {
    await onBrowser(async (page) => {
      await openPage(page, `${fixture.origin}/lazy.html`, { signal: idle() });
      const steps: string[] = [];
      await loadAndScroll(page, { signal: idle(), onStep: (step, state) => steps.push(`${step} ${state}`) });
      expect(steps).toEqual(["load start", "load done", "scroll start", "scroll done"]);
      const after = await page.evaluate(() => ({ loaded: (document.getElementById("lazy") as HTMLImageElement | null)?.naturalWidth ?? 0, top: document.scrollingElement?.scrollTop ?? -1 }));
      expect(after.loaded).toBeGreaterThan(0);
      expect(after.top).toBe(0);
    });
  });

  it("reaches the bottom of pages with smooth scrolling and loads lazy images", async () => {
    await onBrowser(async (page) => {
      await openPage(page, `${fixture.origin}/smooth.html`, { signal: idle() });
      await loadAndScroll(page, { signal: idle(), onStep: () => {} });
      expect(await page.evaluate(() => (document.getElementById("bottom") as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    });
  });
});

describe("prepareForCollection", () => {
  it("finishes finite animations, leaves infinite ones and waits for fonts", async () => {
    await onBrowser(async (page) => {
      await openPage(page, `${fixture.origin}/animated.html`, { signal: idle() });
      expect(Number(await page.evaluate(() => getComputedStyle(document.getElementById("box") as Element).opacity))).toBeLessThan(0.5);
      await prepareForCollection(page);
      expect(
        await page.evaluate(() => ({
          opacity: getComputedStyle(document.getElementById("box") as Element).opacity,
          running: document.getAnimations().length,
          fonts: document.fonts.status,
          slow: [...document.fonts].find((face) => face.family === "Slow")?.status,
        })),
      ).toEqual({ opacity: "1", running: 1, fonts: "loaded", slow: "loaded" });
    });
  });
});

describe("on a page stuck in a script", () => {
  it("rejects on abort and keeps every helper within its cap", async () => {
    await onBrowser(async (page) => {
      const nav = await openPage(page, `${fixture.origin}/loop.html`, { signal: idle() });
      expect(nav.status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 1500));

      const controller = new AbortController();
      setTimeout(() => controller.abort(new Error("scan deadline")), 3000);
      const started = Date.now();
      await expect(loadAndScroll(page, { signal: controller.signal, onStep: () => {} })).rejects.toThrow("scan deadline");
      expect(Date.now() - started).toBeLessThan(12_000);

      const prepared = Date.now();
      await prepareForCollection(page);
      expect(Date.now() - prepared).toBeLessThan(4000);
    });
  });
});
