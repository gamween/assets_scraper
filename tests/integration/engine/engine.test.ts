import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Asset, ScanEvent, type Palette } from "@/lib/contract";
import { BusyError, withBrowser } from "@/server/browser/launch";
import { SafeFetchError } from "@/server/net/safe-fetch";
import { createScanEngine, type ScanEngineDeps } from "@/server/scan/engine";
import { buildFontFamilies } from "@/server/scan/fonts";
import { assembleAssets } from "@/server/scan/post/assemble";
import { createSigner } from "@/server/security/sign";
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
const THROWING_COLLECTOR = 'globalThis.__assetsScraper = { async collect() { throw new Error("collector bug in the page"); } };';
/** Tells the test it runs (through the fixture route `/collector-started`), then never answers. */
const REPORTING_COLLECTOR = 'globalThis.__assetsScraper = { collect: () => { fetch("/collector-started"); return new Promise(() => {}); } };';

const PALETTE: Palette = { brand: [{ hex: "#ff3366", role: "primary" }], neutrals: [{ hex: "#141e28" }] };

let fixture: FixtureServer;
let victim: FixtureServer;
let onCollectorStarted = () => {};
let onCollectorDone = () => {};
/** The options a fake collector posts to /collector-options, so tests can check what the engine passed. */
let postedCollectorOptions: Record<string, unknown> | undefined;
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
    "/collector-options": (req, res) => {
      postedCollectorOptions = JSON.parse(new URL(req.url ?? "/", "http://fixture").searchParams.get("options") ?? "null");
      res.writeHead(204).end();
    },
    "/collector-done": (_req, res) => {
      onCollectorDone();
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
    // Generic challenge title phrases (spec 8.9): a large working page, a small wall that answers 200, and a large wall
    // that answers 403.
    "/one-more-step": html(200, `<!doctype html><html><head><title>One more step to your account</title></head><body>${"<p>Tell us about your team</p>".repeat(400)}</body></html>`),
    "/access-denied": html(200, "<!doctype html><html><head><title>Access denied</title></head><body><p>You do not have access to this page.</p></body></html>"),
    "/access-denied-403": html(403, `<!doctype html><html><head><title>Access denied</title></head><body>${"<p>Blocked</p>".repeat(900)}</body></html>`),
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
  onCollectorDone = () => {};
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
    // The page was blocked before collection: diagnostics say the collector never ran.
    expect(events.at(-1)).toMatchObject({ diagnostics: { blockReason: "http-403", collector: "none" } });
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

  it("counts a generic challenge title only on a failed page, or on a page that stays small once loaded", async () => {
    const large = await scan(testDeps().deps, `${fixture.origin}/one-more-step`);
    expect(large.at(-1)).toMatchObject({ type: "done", partial: false });

    const small = await scan(testDeps().deps, `${fixture.origin}/access-denied`);
    // The element count only means something once the page has loaded.
    expect(small.map(describeEvent)).toEqual(["accepted", "step open start", "page", "step open done", "step load start", "step load done", "error blocked"]);
    expect(small.at(-1)).toMatchObject({ diagnostics: { blockReason: "challenge-title" } });

    const failed = await scan(testDeps().deps, `${fixture.origin}/access-denied-403`);
    // The status holds at domcontentloaded: the scan stops before the page loads.
    expect(failed.map(describeEvent)).toEqual(["accepted", "step open start", "error blocked"]);
    expect(failed.at(-1)).toMatchObject({ diagnostics: { blockReason: "challenge-title" } });
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
    expect(Date.now() - started).toBeLessThan(18_000);
    expect(events.find((event) => event.type === "assets")).toEqual({ type: "assets", items: [] });
    // The scroll cut short by the deadline still gets its done; collection never started, so it is not reported.
    expect(stepsOf(events)).toEqual(["step open start", "step open done", "step load start", "step load done", "step scroll start", "step scroll done", "step process start", "step process done"]);
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
    const downloads: Promise<string | null>[] = [];
    const { deps } = testDeps({
      withBrowser: (options, fn) =>
        withBrowser(options, (session) => {
          session.page.on("download", (download) => downloads.push(download.failure()));
          return fn(session);
        }),
    });
    const events = await scan(deps, `${fixture.origin}/download.html`);
    expect(events.at(-1)).toMatchObject({ type: "done", partial: false });
    expect(downloadHits).toBeGreaterThanOrEqual(1);
    expect(downloads.length).toBeGreaterThanOrEqual(1);
    // The browser cancels every download (acceptDownloads: false), so no byte is written, in Downloads or anywhere else.
    for (const failure of await Promise.all(downloads)) expect(failure).toMatch(/acceptDownloads|canceled/i);
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

  it("never stops a scan that waits for its slot because another scan's browser uses the memory", async () => {
    let proxy: TestProxy | undefined;
    let holding = false;
    let released = false;
    let release = () => {};
    try {
      // Another scan holds the only browser slot, and its browser takes the memory until it is done.
      proxy = await startTestProxy({ allow: [fixture.host] });
      const held = withBrowser({ egressPort: proxy.port, signal: new AbortController().signal }, () => {
        holding = true;
        return new Promise<void>((resolve) => (release = resolve));
      });
      await expect.poll(() => holding, { timeout: 20_000 }).toBe(true);
      const readings: number[] = [];
      const { deps } = testDeps({
        readMemAvailableMb: async () => {
          const available = released ? 4_000 : 200;
          readings.push(available);
          return available;
        },
      });
      const events = await scan(deps, `${fixture.origin}/`, {
        onEvent: (event) => {
          // Long enough for several watchdog readings while queued.
          if (event.type === "step" && event.step === "queue" && event.state === "start")
            setTimeout(() => {
              released = true;
              release();
            }, 1_500);
        },
      });
      await held;
      const done = events.at(-1);
      if (done?.type !== "done") throw new Error(`expected done, got ${done && describeEvent(done)}`);
      expect(done.partial).toBe(false);
      expect(stepsOf(events).slice(0, 3)).toEqual(["step open start", "step queue start", "step queue done"]);
      // The watchdog guards the scan's own browser: it starts with it.
      expect(readings).not.toContain(200);
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
    // The 4 s cap, not the page deadline (25 s here): a loaded runner can add a little.
    expect(abortedAfter).toBeGreaterThanOrEqual(3_900);
    expect(abortedAfter).toBeLessThan(10_000);
    expect(events.filter((event) => event.type === "page").at(-1)).toMatchObject({ page: { title: "overlays restored" } });
    expect(events.find((event) => event.type === "palette")).toEqual({ type: "palette", palette: null });
    expect(logged).toContainEqual(expect.stringMatching(/^Scan [0-9a-f-]{36} has no palette \(aborted\)$/));
  });

  it("keeps what page work collected when the browser close hangs past the page deadline", async () => {
    vi.stubEnv("SCAN_DEADLINE_MS", "20000");
    // Long enough that only the page deadline can cut the hung close.
    vi.stubEnv("SETTLE_MS", "8000");
    const started = Date.now();
    // Page work stops 5 s before the scan deadline. Collection ends 1 s before that, then the graceful close hangs.
    const pageDeadlineAt = started + 15_000;
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
    // The page deadline kills the browser instead of waiting for the close, so post-processing still has its time.
    expect(Date.now() - started).toBeLessThan(18_000);
    expect(done.partial).toBe(false);
    expect(events.find((event) => event.type === "assets")).toMatchObject({ items: [{ id: "photo" }] });
    expect(done.stats.hidden).toEqual({ spacer: 2, "unreferenced-symbol": 1 });
    expect(pids).toHaveLength(1);
    await expect.poll(() => isProcessAlive(pids[0]), { timeout: 5000 }).toBe(false);
  });

  it("settles and closes the browser within the settle budget when the close hangs", async () => {
    vi.stubEnv("SETTLE_MS", "1000");
    let collectedAt = 0;
    let collectDoneAt = 0;
    onCollectorDone = () => (collectedAt = Date.now());
    const collectorSource = `${FAKE_COLLECTOR}
{
  const collect = globalThis.__assetsScraper.collect;
  globalThis.__assetsScraper.collect = async (options) => {
    const output = await collect(options);
    await fetch("/collector-done");
    return output;
  };
}`;
    const { deps, pids } = testDeps({
      collectorSource,
      withBrowser: (options, fn) =>
        withBrowser(options, (session) => {
          if (session.pid) pids.push(session.pid);
          const close = session.browser.close.bind(session.browser);
          let calls = 0;
          session.browser.close = (closeOptions) => (calls++ === 0 ? new Promise<void>(() => {}) : close(closeOptions));
          return fn(session);
        }),
    });
    const events = await scan(deps, `${fixture.origin}/`, {
      onEvent: (event) => {
        if (event.type === "step" && event.step === "collect" && event.state === "done") collectDoneAt = Date.now();
      },
    });
    const done = events.at(-1);
    if (done?.type !== "done") throw new Error(`expected done, got ${done && describeEvent(done)}`);
    expect(done.partial).toBe(false);
    expect(collectedAt).toBeGreaterThan(0);
    // Spec 7.2 phase 9: settling and closing share the settle budget; the hung close is cut and the browser killed.
    expect(collectDoneAt - collectedAt).toBeLessThan(3_000);
    await expect.poll(() => isProcessAlive(pids[0]), { timeout: 5000 }).toBe(false);
  });

  it("ends the scan when stopping the egress proxy hangs", async () => {
    let closeCalled = 0;
    let stopped: Promise<void> | undefined;
    const { deps } = testDeps({
      startEgressProxy: async () => {
        const proxy = await startTestProxy({ allow: [fixture.host] });
        return {
          port: proxy.port,
          stats: proxy.stats,
          close: () => {
            closeCalled = Date.now();
            stopped = proxy.close();
            return new Promise<void>(() => {});
          },
        };
      },
    });
    const events = await scan(deps, `${fixture.origin}/`);
    await stopped;
    const done = events.at(-1);
    if (done?.type !== "done") throw new Error(`expected done, got ${done && describeEvent(done)}`);
    expect(done.partial).toBe(false);
    expect(closeCalled).toBeGreaterThan(0);
    expect(done.diagnostics.phases.process).toBeDefined();
    expect(Date.now() - closeCalled).toBeLessThan(5_000);
  }, 60_000);

  it("gives what post-processing finished as a partial result at the scan deadline", async () => {
    vi.stubEnv("SCAN_DEADLINE_MS", "20000");
    vi.stubEnv("VERIFY_MS", "100");
    const started = Date.now();
    let fontsFinishedAt = 0;
    const { deps } = testDeps({
      assembleAssets: () => new Promise<AssetsOutput>(() => {}),
      // CPU work that ends well after its network deadline is still used while the scan has time left.
      buildFontFamilies: async (input) => {
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, input.deadline + 6_000 - Date.now())));
        fontsFinishedAt = Date.now();
        const family: FontsOutput["families"][number] = {
          id: "late",
          name: "Late Sans",
          cssFamilies: ["Late Sans"],
          source: "self-hosted",
          license: { kind: "unknown" },
          convertible: false,
          downloadable: false,
          usedOnPage: true,
          usage: 1,
          faces: [],
        };
        return { families: [family], hidden: {} };
      },
    });
    const events = await scan(deps, `${fixture.origin}/`);
    const done = events.at(-1);
    if (done?.type !== "done") throw new Error(`expected done, got ${done && describeEvent(done)}`);
    expect(fontsFinishedAt).toBeGreaterThan(0);
    expect(done.partial).toBe(true);
    expect(events).toContainEqual({ type: "warning", code: "partial" });
    expect(events.find((event) => event.type === "assets")).toEqual({ type: "assets", items: [] });
    expect(events.find((event) => event.type === "fonts")).toMatchObject({ type: "fonts", families: [{ name: "Late Sans" }] });
    expect(done.stats.hidden).toEqual({ "unreferenced-symbol": 1 });
    // Ended by the scan deadline, not by the network deadline.
    expect(Date.now() - started).toBeGreaterThanOrEqual(19_000);
    expect(Date.now() - started).toBeLessThan(25_000);
  });

  it("signs the assets before the font files within the shared signing cap, and warns when files stay unsigned", async () => {
    const fontUrls = ["regular", "bold"].map((name) => `${fixture.origin}/fonts/${name}.woff2`);
    const family = (): FontsOutput["families"][number] => ({
      id: "brand",
      name: "Brand Sans",
      cssFamilies: ["Brand Sans"],
      source: "self-hosted",
      license: { kind: "unknown" },
      convertible: false,
      downloadable: true,
      usedOnPage: true,
      usage: 1,
      faces: fontUrls.map((url, index) => ({ weight: String(400 + index * 300), style: "normal", loaded: true, files: [{ url, proxy: "", format: "woff2", coversLatin: true }] })),
    });
    const run = async (max: number) => {
      const { deps } = testDeps({
        createSigner: () => createSigner({ secret: "test-only-signing-secret-0123456789abcdef", max }),
        // The fonts finish first; the assets still take the signing cap before them.
        assembleAssets: async (input) => {
          await new Promise((resolve) => setTimeout(resolve, 200));
          return fakeAssets(input);
        },
        buildFontFamilies: async () => ({ families: [family()], hidden: {} }),
      });
      const events = await scan(deps, `${fixture.origin}/`);
      const assets = events.flatMap((event) => (event.type === "assets" ? event.items : []));
      const fonts = events.find((event) => event.type === "fonts");
      if (fonts?.type !== "fonts") throw new Error("expected fonts");
      return { events, assetProxy: assets[0]?.original?.proxy, fontProxies: fonts.families[0].faces.map((face) => face.files[0].proxy) };
    };

    const capped = await run(2);
    expect(capped.assetProxy).toMatch(/^\/api\/asset\?/);
    expect(capped.fontProxies.map((proxy) => proxy !== "")).toEqual([true, false]);
    expect(capped.events).toContainEqual({ type: "warning", code: "truncated" });

    const roomy = await run(3);
    expect(roomy.fontProxies.every((proxy) => proxy.startsWith("/api/asset?"))).toBe(true);
    expect(roomy.events).not.toContainEqual({ type: "warning", code: "truncated" });
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
        // It started, then failed: diagnostics keep the world it ran in.
        expect(done.diagnostics.collector).toBe("isolated");
        expect(events).toContainEqual({ type: "warning", code: "partial" });
        expect(events.find((event) => event.type === "assets")).toMatchObject({ items: [{ id: "photo" }] });
        // The client gets no internal detail; the server log does.
        expect(JSON.stringify(events)).not.toContain("collector bug");
        expect(log).toHaveBeenCalledWith(expect.stringMatching(/^Scan [0-9a-f-]{36} collector failed in the isolated world$/), expect.any(Error));
      }
      expect(logged.join("\n")).toContain("collector bug in the page");
    } finally {
      log.mockRestore();
    }
  });

  it("fits collector output over its budget instead of losing it, and warns that it is truncated", async () => {
    // A budget of 8 MB. This collector ignores maxOutputChars, like one a main-world page replaced: the engine fits it.
    vi.stubEnv("COLLECTOR_MAX_OUTPUT_CHARS", "8000000");
    // A 50 KB data: URI on 300 elements (15 MB), a unique logo, a 9 MB SVG and a small one.
    const collectorSource = `${FAKE_COLLECTOR}
{
  const collect = globalThis.__assetsScraper.collect;
  globalThis.__assetsScraper.collect = async (options) => {
    const output = await collect(options);
    await fetch("/collector-options?options=" + encodeURIComponent(JSON.stringify(options)));
    const context = { header: false, nav: false, footer: false, homeLink: false, logoWord: false, siteWord: false, logoWall: false, shadowRoot: false, iframe: false };
    const candidate = (url, order) => ({ url, group: order, foundIn: "css-background", order, visible: true, context, declaredOnly: false });
    const pattern = "data:image/png;base64," + "A".repeat(50000);
    const candidates = [candidate(pattern, 0), candidate(location.origin + "/logo.png", 1), ...Array.from({ length: 299 }, (_, i) => candidate(pattern, i + 2))];
    const svg = (markup, order) => ({ markup, hash: "h" + order, source: "inline", referenced: false, order, visible: true, context, usedCount: 1, hasLiveText: false, elementCount: 1 });
    return { ...output, page: { ...output.page, title: "T".repeat(50000) }, candidates, svgs: [svg("<svg>" + "x".repeat(9000000) + "</svg>", 0), svg("<svg><path/></svg>", 1)] };
  };
}`;
    postedCollectorOptions = undefined;
    let collected: PostInput["collector"] | undefined;
    let pageTitle = "";
    const { deps } = testDeps({
      collectorSource,
      assembleAssets: (input) => {
        collected = input.collector;
        pageTitle = input.page.title;
        return fakeAssets(input);
      },
    });
    const events = await scan(deps, `${fixture.origin}/`);
    const done = events.at(-1);
    if (done?.type !== "done") throw new Error(`expected done, got ${done && describeEvent(done)}`);
    expect(done.partial).toBe(false);
    expect(events).toContainEqual({ type: "warning", code: "truncated" });
    expect(collected?.candidates.map((candidate) => candidate.order)).toEqual([0, 1]);
    expect(collected?.svgs.map((svg) => svg.markup)).toEqual(["<svg><path/></svg>"]);
    expect(collected?.stats).toMatchObject({ truncated: true });
    expect(postedCollectorOptions).toMatchObject({ maxOutputChars: 8_000_000, maxTitleChars: 2_048, maxSiteNameChars: 200 });
    // The collector's title is cut, for post-processing and in the final page event.
    expect(pageTitle).toBe("T".repeat(2_048));
    expect(events.filter((event) => event.type === "page").at(-1)).toMatchObject({ page: { title: "T".repeat(2_048) } });
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
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/^Scan [0-9a-f-]{36} collector failed in the isolated world$/), expect.anything());
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
          throw new Error("assemble bug");
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
          return (assetsOut = await assembleAssets(input));
        },
        buildFontFamilies: async (input) => (fontsOut = await buildFontFamilies(input)),
      },
      `${fixture.origin}/sprites.html`,
    );
    const logged = log.mock.calls;
    log.mockRestore();
    expect(events.filter((event) => event.type === "done" || event.type === "error")).toHaveLength(1);
    expect(logged).toEqual([]);
    const last = events.at(-1);

    // Done, and each drop counted once. assembleAssets reports the collector's drops, and the
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
