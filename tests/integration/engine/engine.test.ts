import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Asset, ScanEvent, type Palette } from "@/lib/contract";
import { BusyError, withBrowser } from "@/server/browser/launch";
import { NotImplementedError } from "@/server/errors";
import { SafeFetchError } from "@/server/net/safe-fetch";
import { createScanEngine, type ScanEngineDeps } from "@/server/scan/engine";
import { buildFontFamilies } from "@/server/scan/fonts";
import { COLLECTOR_SOURCE } from "@/server/scan/inpage/generated/collector";
import { assembleAssets } from "@/server/scan/post/assemble";
import type { AssetsOutput, FontsOutput, PostInput } from "@/server/scan/types";
import { serveFixture, type FixtureServer } from "../../fixtures/serve";
import { createFakeFetch, createFakeSigner, isProcessAlive, startTestProxy, type TestProxy } from "./helpers";

const FAKE_COLLECTOR = `globalThis.__assetsScraper = {
  async collect(options) {
    const links = [...document.querySelectorAll("a[href]")].filter((a) => a.host === location.host && /press|brand/i.test(a.href + a.textContent));
    return {
      page: { title: document.title, siteName: options.siteName || undefined, baseUrl: location.href, elementCount: document.getElementsByTagName("*").length },
      candidates: [], svgs: [], fontFaces: [], fontStatuses: [], fontUsage: [], unreadableSheets: [], blobs: [],
      brandLinks: links.slice(0, options.maxBrandLinks).map((a) => ({ href: a.href, text: a.textContent.trim() })),
      noise: { "unreferenced-symbol": 1 },
      stats: { elements: document.getElementsByTagName("*").length, ms: 1, truncated: false },
    };
  },
};`;

const HANGING_COLLECTOR = "globalThis.__assetsScraper = { collect: () => new Promise(() => {}) };";
const THROWING_COLLECTOR = 'globalThis.__assetsScraper = { async collect() { throw new Error("Not implemented: C: collector"); } };';
/** Tells the test it runs (through the fixture route `/collector-started`), then never answers. */
const REPORTING_COLLECTOR = 'globalThis.__assetsScraper = { collect: () => { fetch("/collector-started"); return new Promise(() => {}); } };';

const PALETTE: Palette = { brand: [{ hex: "#ff3366", role: "primary" }], neutrals: [{ hex: "#141e28" }] };

let fixture: FixtureServer;
let victim: FixtureServer;
let onCollectorStarted = () => {};
let victimHits = 0;
let downloadHits = 0;
const downloadName = `assets-scraper-test-${randomUUID()}.bin`;

beforeAll(async () => {
  const html = (status: number, markup: string) => (_req: unknown, res: import("node:http").ServerResponse) => {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
    res.end(markup);
  };
  fixture = await serveFixture({
    "/collector-started": (_req, res) => {
      onCollectorStarted();
      res.writeHead(204).end();
    },
    "/report.pdf": (_req, res) => {
      res.writeHead(200, { "content-type": "application/pdf" });
      res.end("%PDF-1.7 fake");
    },
    "/challenge": html(403, '<!doctype html><html><head><title>Just a moment...</title><link rel="icon" href="/assets/touch.png"></head><body><div id="challenge"></div></body></html>'),
    "/loop.html": html(200, '<!doctype html><title>Busy</title><div style="height:4000px">Busy</div><img src="/assets/photo-small.png"><script>setTimeout(() => { for (;;) {} }, 500)</script>'),
    "/download.html": html(200, `<!doctype html><title>Download</title><a id="file" href="/download.bin" download="${downloadName}">file</a><script>document.getElementById("file").click()</script>`),
    // An unreferenced sprite symbol and a Lottie frame: drops the collector itself counts (spec 8.1, 8.2).
    "/sprites.html": html(
      200,
      `<!doctype html><title>Sprites</title>
      <div class="lottie-player"><svg width="100" height="100"><g id="__lottie_element_1"><rect width="100" height="100"/></g></svg></div>
      <svg style="display:none"><symbol id="used" viewBox="0 0 8 8"><path d="M0 0h8v8z"/></symbol><symbol id="unused" viewBox="0 0 8 8"><circle cx="4" cy="4" r="4"/></symbol></svg>
      <svg width="16" height="16"><use href="#used"/></svg>
      <img src="/assets/photo-small.png" alt="Photo">`,
    ),
    // An app that renders after a data fetch, behind Cloudflare with JavaScript detections: at domcontentloaded it is a
    // near-empty shell holding the challenge-platform script (spec 8.9, medium.com in the lab).
    "/app-shell": html(
      200,
      `<!doctype html><html><head><title>Shell App</title></head><body><div id="root"></div>
      <script>fetch("/api/app-data").then((r) => r.json()).then((items) => {
        document.getElementById("root").innerHTML = items.map((i) => '<section><h2>Item ' + i + '</h2><p>About ' + i + '</p><a href="/items/' + i + '">More</a></section>').join("");
      });</script>
      <script>(function(){var s=document.createElement('script');s.src='/cdn-cgi/challenge-platform/scripts/jsd/main.js';document.head.appendChild(s);})();</script></body></html>`,
    ),
    // A small app shell that loads reCAPTCHA v3 on every page.
    "/recaptcha-shell": html(
      200,
      `<!doctype html><html><head><title>Signup</title><script src="https://www.google.com/recaptcha/api.js?render=site-key"></script></head><body><div id="root"></div>
      <script>fetch("/api/app-data").then((r) => r.json()).then((items) => {
        document.getElementById("root").innerHTML = items.map((i) => '<label>Field ' + i + '<input name="f' + i + '"></label>').join("");
      });</script></body></html>`,
    ),
    "/api/app-data": (_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(Array.from({ length: 40 }, (_, i) => i)));
      }, 300);
    },
    "/cdn-cgi/challenge-platform/scripts/jsd/main.js": (_req, res) => {
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end("");
    },
    // A PerimeterX wall that stays a nearly empty page once loaded, with a normal title and status.
    "/px-wall": html(200, '<!doctype html><html><head><title>Welcome</title></head><body><div id="px-captcha"></div><script>window._pxAppId = "PX123";</script></body></html>'),
    "/wall": (_req, res) => {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("error code: 1010");
    },
    "/cookie-loop": (req, res) => {
      if (!req.headers.cookie?.includes("seen=1")) {
        res.writeHead(302, { location: "/cookie-loop", "set-cookie": "seen=1; Path=/" });
        return res.end();
      }
      html(200, "<!doctype html><title>Welcome back</title><p>Hello</p>")(req, res);
    },
    "/download.bin": (_req, res) => {
      downloadHits += 1;
      res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": `attachment; filename=${downloadName}` });
      res.end("downloaded bytes");
    },
  });
  victim = await serveFixture({
    "/": (_req, res) => {
      victimHits += 1;
      res.end("secret");
    },
  });
});

afterAll(async () => {
  await fixture.close();
  await victim.close();
});

afterEach(() => {
  vi.unstubAllEnvs();
  onCollectorStarted = () => {};
});

const fakeAssets = async (input: PostInput): Promise<AssetsOutput> => {
  const photo = input.network.images.find((image) => image.url.endsWith("/photo-small.png"));
  const url = photo?.url ?? `${input.page.finalUrl}fallback.png`;
  const source = { url, proxy: input.signer.sign(url), format: "png" as const };
  const asset: Asset = {
    id: "photo", kind: "image", role: "image", name: "Photo", filename: "fixture-photo.png", format: "png", foundIn: ["network"], visible: true, declaredOnly: false,
    order: 0, score: 100, usedCount: 1, tone: photo?.tone ?? "unknown", display: source, original: source,
  };
  // Like the real assembleAssets, hidden holds the collector's drops and adds what post-processing drops.
  return { assets: [asset], hidden: { ...input.collector.noise, spacer: 2 }, warnings: [] };
};
const fakeFonts = async (): Promise<FontsOutput> => ({ families: [], hidden: {} });

/** Injected network, signing and post-processing fakes, plus a spy on the browser. */
function testDeps(overrides: Partial<ScanEngineDeps> = {}) {
  const pids: number[] = [];
  const launches = vi.fn();
  const proxies = vi.fn();
  const deps: Partial<ScanEngineDeps> = {
    fetch: createFakeFetch({ allow: [fixture.host] }),
    startEgressProxy: async () => {
      proxies();
      return startTestProxy({ allow: [fixture.host] });
    },
    withBrowser: (options, fn) => {
      launches();
      return withBrowser(options, (session) => {
        if (session.pid) pids.push(session.pid);
        return fn(session);
      });
    },
    createSigner: () => createFakeSigner(),
    assembleAssets: fakeAssets,
    buildFontFamilies: fakeFonts,
    extractPalette: async () => PALETTE,
    collectorSource: FAKE_COLLECTOR,
    ...overrides,
  };
  return { deps, pids, launches, proxies };
}

async function scan(deps: Partial<ScanEngineDeps>, url: string, options: { signal?: AbortSignal; onEvent?: (event: ScanEvent) => void | "stop" } = {}) {
  const events: ScanEvent[] = [];
  for await (const event of createScanEngine(deps).scan({ url }, { signal: options.signal ?? new AbortController().signal })) {
    events.push(ScanEvent.parse(event));
    if (options.onEvent?.(event) === "stop") break;
  }
  return events;
}

const describeEvent = (event: ScanEvent) => (event.type === "step" ? `step ${event.step} ${event.state}` : event.type === "error" ? `error ${event.code}` : event.type);
const stepsOf = (events: ScanEvent[]) => events.filter((event) => event.type === "step").map(describeEvent);

describe("scan engine", () => {
  it("streams the whole scan of the fixture in order", async () => {
    const { deps, pids } = testDeps();
    const events = await scan(deps, `${fixture.origin}/`);
    expect(events.map(describeEvent)).toEqual([
      "accepted",
      "step open start",
      "page",
      "step open done",
      "step load start",
      "step load done",
      "step scroll start",
      "step scroll done",
      "step collect start",
      "step collect done",
      "step process start",
      "step process done",
      "page",
      "palette",
      "assets",
      "fonts",
      "done",
    ]);

    const [early, final] = events.filter((event) => event.type === "page");
    expect(early).toEqual({ type: "page", page: { requestedUrl: `${fixture.origin}/`, finalUrl: `${fixture.origin}/`, host: "127.0.0.1", title: "Fixture Co", siteName: "Fixture", status: 200, brandLinks: [] } });
    expect(final.type === "page" && final.page.brandLinks).toEqual([{ href: `${fixture.origin}/press`, text: "Press kit" }]);
    expect(events.find((event) => event.type === "palette")).toEqual({ type: "palette", palette: PALETTE });
    expect(events.find((event) => event.type === "assets")).toMatchObject({ items: [{ id: "photo", display: { url: `${fixture.origin}/assets/photo-small.png` } }] });

    const done = events.at(-1);
    if (done?.type !== "done") throw new Error("expected done");
    expect(done.partial).toBe(false);
    // The collector's drop reaches stats.hidden once, through assembleAssets.
    expect(done.stats).toMatchObject({ assets: 1, svg: 0, images: 1, fonts: 0, hidden: { spacer: 2, "unreferenced-symbol": 1 } });
    expect(done.diagnostics).toMatchObject({ collector: "isolated", version: "dev", bodyTimeouts: 0 });
    expect(done.diagnostics.egress.bytes).toBeGreaterThan(0);
    expect(Object.keys(done.diagnostics.phases)).toEqual(expect.arrayContaining(["preflight", "launch", "open", "load", "scroll", "collect", "process"]));
    expect(pids).toHaveLength(1);
    await expect.poll(() => isProcessAlive(pids[0]), { timeout: 5000 }).toBe(false);
  });

  it("answers not-html with the file as its only asset", async () => {
    const { deps, launches } = testDeps();
    const events = await scan(deps, `${fixture.origin}/report.pdf`);
    const last = events.at(-1);
    expect(last).toMatchObject({ type: "error", code: "not-html" });
    expect(last?.type === "error" && last.fallback?.map((asset) => asset.original?.url)).toEqual([`${fixture.origin}/report.pdf`]);
    expect(launches).not.toHaveBeenCalled();
  });

  it("lets the browser try a bot wall that answers the preflight in plain text", async () => {
    const { deps, launches } = testDeps();
    const events = await scan(deps, `${fixture.origin}/wall`);
    expect(launches).toHaveBeenCalledTimes(1);
    // The status rule counts elements, so it waits for the page to load.
    expect(events.map(describeEvent)).toEqual(["accepted", "step open start", "page", "step open done", "step load start", "step load done", "error blocked"]);
    expect(events.at(-1)).toMatchObject({ diagnostics: { blockReason: "http-403" } });
  });

  it("never mistakes an app shell for a bot wall: the markup and captcha rules wait for the page to load", async () => {
    for (const pathname of ["/app-shell", "/recaptcha-shell"]) {
      const { deps } = testDeps();
      const events = await scan(deps, `${fixture.origin}${pathname}`);
      const last = events.at(-1);
      expect(last && describeEvent(last), pathname).toBe("done");
      expect(last).toMatchObject({ partial: false });
    }
  });

  it("reports a wall that stays nearly empty once loaded as blocked", async () => {
    const { deps, pids } = testDeps();
    const events = await scan(deps, `${fixture.origin}/px-wall`);
    expect(events.map(describeEvent)).toEqual(["accepted", "step open start", "page", "step open done", "step load start", "step load done", "error blocked"]);
    expect(events.at(-1)).toMatchObject({ diagnostics: { blockReason: "challenge-markup" } });
    expect(pids).toHaveLength(1);
    await expect.poll(() => isProcessAlive(pids[0]), { timeout: 5000 }).toBe(false);
  });

  it("lets the browser open a page the preflight gave up on after too many redirects", async () => {
    const { deps, launches } = testDeps({
      fetch: createFakeFetch({
        routes: {
          [`${fixture.origin}/cookie-loop`]: () => {
            throw new SafeFetchError("too-many-redirects", "More than 5 redirects");
          },
        },
      }),
    });
    const events = await scan(deps, `${fixture.origin}/cookie-loop`);
    expect(launches).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toMatchObject({ type: "done", partial: false });
    expect(events.find((event) => event.type === "page")).toMatchObject({ page: { title: "Welcome back", status: 200 } });
  });

  it("reports a bot wall as blocked with public-source assets", async () => {
    const icon = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    const { deps } = testDeps({
      fetch: createFakeFetch({
        allow: [fixture.host],
        routes: {
          "https://www.google.com/s2/favicons": () => new Response(new Uint8Array(icon), { headers: { "content-type": "image/png" } }),
          "https://query.wikidata.org/": () => Response.json({ results: { bindings: [] } }),
        },
      }),
    });
    const events = await scan(deps, `${fixture.origin}/challenge`);
    const last = events.at(-1);
    if (last?.type !== "error") throw new Error("expected an error");
    expect(last.code).toBe("blocked");
    expect(last.diagnostics?.blockReason).toBe("challenge-title");
    expect(last.fallback?.map((asset) => [asset.role, asset.original?.url])).toEqual([
      ["favicon", `${fixture.origin}/assets/touch.png`],
      ["favicon", "https://www.google.com/s2/favicons?domain=127.0.0.1&sz=256"],
    ]);
    expect(events.some((event) => event.type === "page")).toBe(false);
  });

  it("returns partial results when the collector hangs", async () => {
    vi.stubEnv("COLLECT_MS", "2000");
    const { deps } = testDeps({ collectorSource: HANGING_COLLECTOR });
    const events = await scan(deps, `${fixture.origin}/`);
    const done = events.at(-1);
    if (done?.type !== "done") throw new Error(`expected done, got ${done && describeEvent(done)}`);
    expect(done.partial).toBe(true);
    expect(events).toContainEqual({ type: "warning", code: "partial" });
    expect(events.find((event) => event.type === "assets")).toMatchObject({ items: [{ id: "photo" }] });
  });

  it("stops a page stuck in a script at the deadline, kills Chrome and ends by the deadline", async () => {
    vi.stubEnv("SCAN_DEADLINE_MS", "15000");
    // Short load waits and a long scroll budget: the deadline stops the scan while it scrolls the stuck page.
    vi.stubEnv("LOAD_MS", "1000");
    vi.stubEnv("NETWORK_IDLE_MS", "1000");
    vi.stubEnv("SCROLL_MS", "60000");
    const { deps, pids } = testDeps({ assembleAssets: () => new Promise<AssetsOutput>(() => {}) });
    const started = Date.now();
    const events = await scan(deps, `${fixture.origin}/loop.html`);
    const done = events.at(-1);
    if (done?.type !== "done") throw new Error(`expected done, got ${done && describeEvent(done)}`);
    expect(done.partial).toBe(true);
    // Post-processing never finishes here: the scan still ends by its deadline with what is ready.
    expect(Date.now() - started).toBeLessThan(16_000);
    expect(events.find((event) => event.type === "assets")).toEqual({ type: "assets", items: [] });
    // Collection never started, so no collect step is reported.
    expect(stepsOf(events)).toEqual(["step open start", "step open done", "step load start", "step load done", "step scroll start", "step process start", "step process done"]);
    expect(pids).toHaveLength(1);
    await expect.poll(() => isProcessAlive(pids[0]), { timeout: 5000 }).toBe(false);
  });

  it("ends without done and kills Chrome when the request is cancelled during scroll", async () => {
    const { deps, pids } = testDeps();
    const controller = new AbortController();
    const events = await scan(deps, `${fixture.origin}/`, {
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === "step" && event.step === "scroll" && event.state === "start") controller.abort(new Error("client went away"));
      },
    });
    expect(events.at(-1)).toEqual({ type: "step", step: "scroll", state: "start" });
    expect(pids).toHaveLength(1);
    await expect.poll(() => isProcessAlive(pids[0]), { timeout: 5000 }).toBe(false);
  });

  it("kills Chrome when the consumer stops reading", async () => {
    const { deps, pids } = testDeps();
    const events = await scan(deps, `${fixture.origin}/`, { onEvent: (event) => (event.type === "step" && event.step === "load" ? "stop" : undefined) });
    expect(events.at(-1)).toEqual({ type: "step", step: "load", state: "start" });
    await expect.poll(() => pids.length === 1 && !isProcessAlive(pids[0]), { timeout: 10_000 }).toBe(true);
  });

  it("never saves a download the page starts", async () => {
    const { deps } = testDeps();
    const events = await scan(deps, `${fixture.origin}/download.html`);
    expect(events.at(-1)).toMatchObject({ type: "done", partial: false });
    expect(downloadHits).toBeGreaterThanOrEqual(1);
    expect(existsSync(path.join(homedir(), "Downloads", downloadName))).toBe(false);
  });

  it("refuses a private address before starting a browser", async () => {
    const { deps, launches, proxies } = testDeps();
    const events = await scan(deps, `http://127.0.0.1:${victim.port}/`);
    expect(events.map(describeEvent)).toEqual(["accepted", "step open start", "error blocked-address"]);
    expect(launches).not.toHaveBeenCalled();
    expect(proxies).not.toHaveBeenCalled();
    expect(victimHits).toBe(0);
  });

  it("turns a busy browser pool into a busy error", async () => {
    const { deps } = testDeps({
      withBrowser: async (options) => {
        options.onQueued?.();
        await new Promise((resolve) => setTimeout(resolve, 200));
        throw new BusyError();
      },
    });
    const events = await scan(deps, `${fixture.origin}/`);
    expect(events.map(describeEvent)).toEqual(["accepted", "step open start", "step queue start", "error busy"]);
    const last = events.at(-1);
    expect(last?.type === "error" && last.diagnostics?.queueMs).toBeGreaterThanOrEqual(150);
  });

  it("ends the queue step when the slot is granted, even when the launch then fails", async () => {
    let proxy: TestProxy | undefined;
    let holding = false;
    let release = () => {};
    try {
      // Another scan holds the only browser slot.
      proxy = await startTestProxy({ allow: [fixture.host] });
      const held = withBrowser({ egressPort: proxy.port, signal: new AbortController().signal }, () => {
        holding = true;
        return new Promise<void>((resolve) => (release = resolve));
      });
      await expect.poll(() => holding, { timeout: 20_000 }).toBe(true);
      // The next browser launch fails its health gate.
      vi.stubEnv("MIN_TMP_FREE_MB", String(2 ** 40));
      const { deps, proxies } = testDeps();
      const events = await scan(deps, `${fixture.origin}/`, {
        onEvent: (event) => {
          if (event.type === "step" && event.step === "queue" && event.state === "start") setTimeout(() => release(), 300);
        },
      });
      await held;
      expect(events.map(describeEvent)).toEqual(["accepted", "step open start", "step queue start", "step queue done", "error busy"]);
      // Neither the wait for the slot nor the refused launch started an egress proxy.
      expect(proxies).not.toHaveBeenCalled();
      const last = events.at(-1);
      expect(last?.type === "error" && last.diagnostics?.queueMs).toBeGreaterThanOrEqual(250);
    } finally {
      release();
      await proxy?.close();
    }
  });

  it("caps the palette phase when extractPalette never answers", async () => {
    vi.stubEnv("SCAN_DEADLINE_MS", "30000");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { deps } = testDeps({ extractPalette: () => new Promise<Palette | null>(() => {}) });
    const events = await scan(deps, `${fixture.origin}/`);
    const logged = warn.mock.calls.map(([message]) => String(message));
    warn.mockRestore();
    const done = events.at(-1);
    if (done?.type !== "done") throw new Error(`expected done, got ${done && describeEvent(done)}`);
    expect(done.partial).toBe(false);
    expect(events.find((event) => event.type === "palette")).toEqual({ type: "palette", palette: null });
    // Aborted at 4 s, then given 1 s to put the page back.
    expect(done.diagnostics.phases.palette).toBeGreaterThanOrEqual(4_900);
    expect(done.diagnostics.phases.palette).toBeLessThan(7_000);
    expect(logged).toContainEqual(expect.stringMatching(/^Scan [0-9a-f-]{36} has no palette \(timeout\)$/));
  });

  it("aborts extractPalette at its cap and lets it restore the page before the collector runs", async () => {
    vi.stubEnv("SCAN_DEADLINE_MS", "30000");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const setMark = (page: Page, mark: string) => page.evaluate((value) => (document.documentElement.dataset.overlays = value), mark);
    let abortedAfter = 0;
    // Like the real palette: hides overlays, honors its signal, and restores them before it returns.
    const extractPalette: ScanEngineDeps["extractPalette"] = async (page, { signal, onNull }) => {
      const started = Date.now();
      await setMark(page, "hidden");
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      abortedAfter = Date.now() - started;
      await new Promise((resolve) => setTimeout(resolve, 300));
      await setMark(page, "restored");
      onNull?.("aborted");
      return null;
    };
    // The collector reports what it saw as the page title.
    const collectorSource = `${FAKE_COLLECTOR}
{
  const collect = globalThis.__assetsScraper.collect;
  globalThis.__assetsScraper.collect = async (options) => {
    const output = await collect(options);
    return { ...output, page: { ...output.page, title: "overlays " + document.documentElement.dataset.overlays } };
  };
}`;
    const events = await scan(testDeps({ extractPalette, collectorSource }).deps, `${fixture.origin}/`);
    const logged = warn.mock.calls.map(([message]) => String(message));
    warn.mockRestore();
    const done = events.at(-1);
    if (done?.type !== "done") throw new Error(`expected done, got ${done && describeEvent(done)}`);
    expect(abortedAfter).toBeGreaterThanOrEqual(3_900);
    expect(abortedAfter).toBeLessThan(4_900);
    expect(events.filter((event) => event.type === "page").at(-1)).toMatchObject({ page: { title: "overlays restored" } });
    expect(events.find((event) => event.type === "palette")).toEqual({ type: "palette", palette: null });
    expect(logged).toContainEqual(expect.stringMatching(/^Scan [0-9a-f-]{36} has no palette \(aborted\)$/));
  });

  it("keeps what page work collected when the browser close hangs past the page deadline", async () => {
    vi.stubEnv("SCAN_DEADLINE_MS", "16000");
    const started = Date.now();
    // Page work stops 5 s before the scan deadline. Collection ends 1 s before that, then the graceful close hangs.
    const pageDeadlineAt = started + 11_000;
    const lateCollector = `${FAKE_COLLECTOR}
{
  const collect = globalThis.__assetsScraper.collect;
  globalThis.__assetsScraper.collect = async (options) => {
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, ${pageDeadlineAt - 1_000} - Date.now())));
    return collect(options);
  };
}`;
    const { deps, pids } = testDeps({
      collectorSource: lateCollector,
      withBrowser: (options, fn) =>
        withBrowser(options, (session) => {
          if (session.pid) pids.push(session.pid);
          const close = session.browser.close.bind(session.browser);
          let calls = 0;
          session.browser.close = (closeOptions) => (calls++ === 0 ? new Promise<void>(() => {}) : close(closeOptions));
          return fn(session);
        }),
    });
    const events = await scan(deps, `${fixture.origin}/`);
    const done = events.at(-1);
    if (done?.type !== "done") throw new Error(`expected done, got ${done && describeEvent(done)}`);
    // The page deadline kills the browser instead of waiting 5 s for the close, so post-processing still has its time.
    expect(Date.now() - started).toBeLessThan(13_000);
    expect(done.partial).toBe(false);
    expect(events.find((event) => event.type === "assets")).toMatchObject({ items: [{ id: "photo" }] });
    expect(done.stats.hidden).toEqual({ spacer: 2, "unreferenced-symbol": 1 });
    expect(pids).toHaveLength(1);
    await expect.poll(() => isProcessAlive(pids[0]), { timeout: 5000 }).toBe(false);
  });

  it("gives what post-processing finished as a partial result when it runs out of time", async () => {
    vi.stubEnv("VERIFY_MS", "100");
    const { deps } = testDeps({ assembleAssets: () => new Promise<AssetsOutput>(() => {}) });
    const events = await scan(deps, `${fixture.origin}/`);
    const done = events.at(-1);
    if (done?.type !== "done") throw new Error(`expected done, got ${done && describeEvent(done)}`);
    expect(done.partial).toBe(true);
    expect(events).toContainEqual({ type: "warning", code: "partial" });
    expect(events.find((event) => event.type === "assets")).toEqual({ type: "assets", items: [] });
    expect(events.find((event) => event.type === "fonts")).toEqual({ type: "fonts", families: [] });
    expect(done.stats.hidden).toEqual({ "unreferenced-symbol": 1 });
    expect(done.diagnostics.phases.process).toBeGreaterThanOrEqual(5_000);
    expect(done.diagnostics.phases.process).toBeLessThan(7_000);
  });

  it("keeps the network results when the collector throws or returns something else, and logs why", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const logged: string[] = [];
    try {
      for (const collectorSource of [THROWING_COLLECTOR, "globalThis.__assetsScraper = { collect: async () => undefined };", 'globalThis.__assetsScraper = { collect: async () => ({ page: "nope" }) };']) {
        logged.push(...log.mock.calls.flat().map(String));
        log.mockClear();
        const events = await scan(testDeps({ collectorSource }).deps, `${fixture.origin}/`);
        const done = events.at(-1);
        if (done?.type !== "done") throw new Error(`expected done, got ${done && describeEvent(done)}`);
        expect(done.partial).toBe(true);
        expect(events).toContainEqual({ type: "warning", code: "partial" });
        expect(events.find((event) => event.type === "assets")).toMatchObject({ items: [{ id: "photo" }] });
        // The client gets no internal detail; the server log does.
        expect(JSON.stringify(events)).not.toContain("Not implemented");
        expect(log).toHaveBeenCalledWith(expect.stringMatching(/^Scan [0-9a-f-]{36} collector failed$/), expect.any(Error));
      }
      expect(logged.join("\n")).toContain("Not implemented: C: collector");
    } finally {
      log.mockRestore();
    }
  });

  it("keeps the network results when the browser dies during collection", async () => {
    vi.stubEnv("COLLECT_MS", "60000");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps, pids } = testDeps({ collectorSource: REPORTING_COLLECTOR });
    let killedAt = 0;
    // An out-of-memory kill between two watchdog readings (spec 7.3, critic R7).
    onCollectorStarted = () => {
      killedAt = Date.now();
      process.kill(pids[0], "SIGKILL");
    };
    try {
      const events = await scan(deps, `${fixture.origin}/`);
      const done = events.at(-1);
      if (done?.type !== "done") throw new Error(`expected done, got ${done && describeEvent(done)}`);
      expect(killedAt).toBeGreaterThan(0);
      expect(Date.now() - killedAt).toBeLessThan(15_000);
      expect(done.partial).toBe(true);
      expect(events.find((event) => event.type === "assets")).toMatchObject({ items: [{ id: "photo" }] });
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/^Scan [0-9a-f-]{36} collector failed$/), expect.anything());
    } finally {
      log.mockRestore();
    }
  });

  it("keeps the network results when the page reloads itself during collection", async () => {
    vi.stubEnv("COLLECT_MS", "60000");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const reloading = "globalThis.__assetsScraper = { collect: () => { setTimeout(() => location.reload(), 200); return new Promise(() => {}); } };";
    const started = Date.now();
    try {
      const events = await scan(testDeps({ collectorSource: reloading }).deps, `${fixture.origin}/`);
      const done = events.at(-1);
      if (done?.type !== "done") throw new Error(`expected done, got ${done && describeEvent(done)}`);
      expect(done.partial).toBe(true);
      expect(Date.now() - started).toBeLessThan(30_000);
      expect(events.find((event) => event.type === "assets")).toMatchObject({ items: [{ id: "photo" }] });
    } finally {
      log.mockRestore();
    }
  });

  it("stops page work when memory runs low, kills Chrome and returns partial results", async () => {
    vi.stubEnv("COLLECT_MS", "60000");
    let collecting = false;
    onCollectorStarted = () => (collecting = true);
    const readings: number[] = [];
    const { deps, pids } = testDeps({
      collectorSource: REPORTING_COLLECTOR,
      readMemAvailableMb: async () => {
        const available = collecting ? 200 : 4_000;
        readings.push(available);
        return available;
      },
    });
    const events = await scan(deps, `${fixture.origin}/`);
    const done = events.at(-1);
    if (done?.type !== "done") throw new Error(`expected done, got ${done && describeEvent(done)}`);
    expect(done.partial).toBe(true);
    expect(readings).toContain(200);
    expect(events.find((event) => event.type === "assets")).toMatchObject({ items: [{ id: "photo" }] });
    expect(pids).toHaveLength(1);
    await expect.poll(() => isProcessAlive(pids[0]), { timeout: 5000 }).toBe(false);
  });

  it("turns post-processing failures into internal errors", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const postFails = await scan(
      testDeps({
        assembleAssets: async () => {
          throw new NotImplementedError("C: assembleAssets");
        },
      }).deps,
      `${fixture.origin}/`,
    );
    expect(postFails.at(-1)).toMatchObject({ type: "error", code: "internal", message: "Something went wrong on our side" });
    log.mockRestore();
  });

  it("reports a post-processing failure after page work reached its deadline as internal, and logs it", async () => {
    vi.stubEnv("SCAN_DEADLINE_MS", "12000");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    // Page work stops 5 s before the scan deadline; this fails just after that, while post-processing still has time.
    const pageDeadlineAt = Date.now() + 7_000;
    const events = await scan(
      testDeps({
        assembleAssets: async () => {
          await new Promise((resolve) => setTimeout(resolve, Math.max(0, pageDeadlineAt - Date.now()) + 500));
          throw new Error("assemble bug");
        },
      }).deps,
      `${fixture.origin}/`,
    );
    const calls = log.mock.calls;
    log.mockRestore();
    expect(events.at(-1)).toMatchObject({ type: "error", code: "internal" });
    expect(calls).toContainEqual([expect.stringMatching(/^Scan [0-9a-f-]{36} failed$/), expect.objectContaining({ message: "assemble bug" })]);
  });

  it("runs the default in-page and post-processing modules end to end", async () => {
    // Only the network, proxy and signer are faked; the real modules run behind pass-through spies.
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps } = testDeps();
    const { fetch, startEgressProxy, withBrowser: browser, createSigner } = deps;
    const stubs: string[] = [];
    const recordStub = (error: unknown) => {
      if (error instanceof NotImplementedError) stubs.push(error.message);
      throw error;
    };
    let collectorNoise: PostInput["collector"]["noise"] = {};
    let assetsOut: AssetsOutput | undefined;
    let fontsOut: FontsOutput | undefined;
    const events = await scan(
      {
        fetch,
        startEgressProxy,
        withBrowser: browser,
        createSigner,
        assembleAssets: async (input) => {
          collectorNoise = input.collector.noise;
          return (assetsOut = await assembleAssets(input).catch(recordStub));
        },
        buildFontFamilies: async (input) => (fontsOut = await buildFontFamilies(input).catch(recordStub)),
      },
      `${fixture.origin}/sprites.html`,
    );
    const logged = log.mock.calls;
    log.mockRestore();
    expect(events.filter((event) => event.type === "done" || event.type === "error")).toHaveLength(1);
    const last = events.at(-1);

    if (COLLECTOR_SOURCE.includes("Not implemented") || stubs.length) {
      // While the collector or a post-processing track is a stub on this branch, the scan fails as an internal error.
      expect(last).toMatchObject({ type: "error", code: "internal", message: "Something went wrong on our side" });
      expect(logged).toContainEqual([expect.stringMatching(/^Scan [0-9a-f-]{36} failed$/), expect.objectContaining({ message: expect.stringContaining("Not implemented") })]);
      return;
    }

    // With the real modules: done, and each drop counted once. assembleAssets reports the collector's drops, and the
    // engine only sums the assets' and the fonts' counts.
    if (last?.type !== "done" || !assetsOut || !fontsOut) throw new Error(`expected done, got ${last && describeEvent(last)}`);
    expect(collectorNoise).toMatchObject({ "unreferenced-symbol": 1 });
    expect(last.stats.hidden["unreferenced-symbol"]).toBe(1);
    for (const [reason, count] of Object.entries(collectorNoise)) expect(assetsOut.hidden[reason as keyof typeof collectorNoise]).toBeGreaterThanOrEqual(count ?? 0);
    const expected: Record<string, number> = {};
    for (const counts of [assetsOut.hidden, fontsOut.hidden]) for (const [reason, count] of Object.entries(counts)) if (count) expected[reason] = (expected[reason] ?? 0) + count;
    expect(last.stats.hidden).toEqual(expected);
  });
});
