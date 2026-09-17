import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Asset, ScanEvent, type Palette } from "@/lib/contract";
import { BusyError, withBrowser } from "@/server/browser/launch";
import { NotImplementedError } from "@/server/errors";
import { SafeFetchError } from "@/server/net/safe-fetch";
import { createScanEngine, type ScanEngineDeps } from "@/server/scan/engine";
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

const PALETTE: Palette = { brand: [{ hex: "#ff3366", role: "primary" }], neutrals: [{ hex: "#141e28" }] };

let fixture: FixtureServer;
let victim: FixtureServer;
let victimHits = 0;
let downloadHits = 0;
const downloadName = `assets-scraper-test-${randomUUID()}.bin`;

beforeAll(async () => {
  const html = (status: number, markup: string) => (_req: unknown, res: import("node:http").ServerResponse) => {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
    res.end(markup);
  };
  fixture = await serveFixture({
    "/report.pdf": (_req, res) => {
      res.writeHead(200, { "content-type": "application/pdf" });
      res.end("%PDF-1.7 fake");
    },
    "/challenge": html(403, '<!doctype html><html><head><title>Just a moment...</title><link rel="icon" href="/assets/touch.png"></head><body><div id="challenge"></div></body></html>'),
    "/loop.html": html(200, '<!doctype html><title>Busy</title><div style="height:4000px">Busy</div><img src="/assets/photo-small.png"><script>setTimeout(() => { for (;;) {} }, 500)</script>'),
    "/download.html": html(200, `<!doctype html><title>Download</title><a id="file" href="/download.bin" download="${downloadName}">file</a><script>document.getElementById("file").click()</script>`),
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
});

const fakeAssets = async (input: PostInput): Promise<AssetsOutput> => {
  const photo = input.network.images.find((image) => image.url.endsWith("/photo-small.png"));
  const url = photo?.url ?? `${input.page.finalUrl}fallback.png`;
  const source = { url, proxy: input.signer.sign(url), format: "png" as const };
  const asset: Asset = {
    id: "photo", kind: "image", role: "image", name: "Photo", filename: "fixture-photo.png", format: "png", foundIn: ["network"], visible: true, declaredOnly: false,
    order: 0, score: 100, usedCount: 1, tone: photo?.tone ?? "unknown", display: source, original: source,
  };
  // Like the real assembleAssets, hidden only counts what post-processing drops: the engine adds the collector's noise.
  return { assets: [asset], hidden: { spacer: 2 }, warnings: [] };
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
    expect(events.map(describeEvent)).toEqual(["accepted", "step open start", "error blocked"]);
    expect(events.at(-1)).toMatchObject({ diagnostics: { blockReason: "http-403" } });
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
      const { deps } = testDeps();
      const events = await scan(deps, `${fixture.origin}/`, {
        onEvent: (event) => {
          if (event.type === "step" && event.step === "queue" && event.state === "start") setTimeout(() => release(), 300);
        },
      });
      await held;
      expect(events.map(describeEvent)).toEqual(["accepted", "step open start", "step queue start", "step queue done", "error busy"]);
      const last = events.at(-1);
      expect(last?.type === "error" && last.diagnostics?.queueMs).toBeGreaterThanOrEqual(250);
    } finally {
      release();
      await proxy?.close();
    }
  });

  it("caps the palette phase when extractPalette never answers", async () => {
    vi.stubEnv("SCAN_DEADLINE_MS", "30000");
    const { deps } = testDeps({ extractPalette: () => new Promise<Palette | null>(() => {}) });
    const events = await scan(deps, `${fixture.origin}/`);
    const done = events.at(-1);
    if (done?.type !== "done") throw new Error(`expected done, got ${done && describeEvent(done)}`);
    expect(done.partial).toBe(false);
    expect(events.find((event) => event.type === "palette")).toEqual({ type: "palette", palette: null });
    expect(done.diagnostics.phases.palette).toBeGreaterThanOrEqual(3_900);
    expect(done.diagnostics.phases.palette).toBeLessThan(6_000);
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

  it("turns collector and post-processing failures into internal errors with diagnostics", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const collectorFails = await scan(testDeps({ collectorSource: THROWING_COLLECTOR }).deps, `${fixture.origin}/`);
    expect(collectorFails.at(-1)).toMatchObject({ type: "error", code: "internal", message: "Something went wrong on our side", diagnostics: { collector: "isolated" } });
    expect(collectorFails.some((event) => event.type === "done")).toBe(false);
    // The client gets no internal detail; the server log does.
    expect(JSON.stringify(collectorFails.at(-1))).not.toContain("Not implemented");
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^Scan [0-9a-f-]{36} failed$/), expect.objectContaining({ message: expect.stringContaining("Not implemented: C: collector") }));

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
    // Only the network, proxy and signer are faked here. While the asset, font and palette tracks are stubs this ends
    // with an internal error; with the real modules it ends with done. Either way it never throws or hangs.
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps } = testDeps();
    const { fetch, startEgressProxy, withBrowser: browser, createSigner } = deps;
    const events = await scan({ fetch, startEgressProxy, withBrowser: browser, createSigner }, `${fixture.origin}/`);
    log.mockRestore();
    const last = events.at(-1);
    expect(last?.type === "done" || (last?.type === "error" && last.code === "internal")).toBe(true);
    expect(events.filter((event) => event.type === "done" || event.type === "error")).toHaveLength(1);
  });
});
