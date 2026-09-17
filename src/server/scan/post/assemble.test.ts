import { afterEach, describe, expect, it, vi } from "vitest";
import { limits } from "@/server/config/limits";
import { SignLimitError } from "@/server/security/sign";
import type { CandidateContext, CapturedImage, CapturedSheet, PostInput, RawCandidate, RawCollectorOutput, SafeFetch, Signer } from "../types";
import { assembleAssets, siteLabel } from "./assemble";

// Counts the image header reads of inline rasters, and how many run at once
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

/** assembleAssets on synthetic collector output, with a fetch that answers every probe with a 404. */

const PAGE = "https://shop.example/";
const noContext: CandidateContext = {
  header: false, nav: false, footer: false, homeLink: false, logoWord: false, siteWord: false, logoWall: false, shadowRoot: false, iframe: false,
};

const notFound: SafeFetch = async (url) => ({
  url,
  status: 404,
  headers: new Headers({ "content-type": "text/html" }),
  redirected: false,
  stream: () => new ReadableStream({ start: (controller) => controller.close() }),
  buffer: async () => Buffer.alloc(0),
  text: async () => "",
  json: async <T>() => ({}) as T,
  cancel: async () => {},
});

const candidate = (url: string, group: number, order: number, patch: Partial<RawCandidate> = {}): RawCandidate => ({
  url, group, foundIn: "img", order, visible: false, context: noContext, declaredOnly: false, ...patch,
});

const collectorOutput = (patch: Partial<RawCollectorOutput>): RawCollectorOutput => ({
  page: { title: "Shop", siteName: "Shop", baseUrl: PAGE, elementCount: 10 },
  candidates: [],
  svgs: [],
  fontFaces: [],
  fontStatuses: [],
  fontUsage: [],
  unreadableSheets: [],
  blobs: [],
  brandLinks: [],
  noise: {},
  stats: { elements: 10, ms: 1, truncated: false },
  ...patch,
});

const captured = (url: string, patch: Partial<CapturedImage> = {}): CapturedImage => ({
  url, status: 200, contentType: "image/png", bytes: 20_000, sha1: url, width: 640, height: 480, tone: "opaque", ...patch,
});

const proxyOf = (url: string) => `/api/asset?u=${encodeURIComponent(url)}`;

const run = (collector: RawCollectorOutput, images: CapturedImage[] = [], signer: Signer = { sign: proxyOf, count: 0 }, sheets: CapturedSheet[] = []) => {
  const input: PostInput = {
    collector,
    network: { images, fonts: [], sheets, bodyTimeouts: 0, skippedBodies: 0 },
    page: { requestedUrl: PAGE, finalUrl: PAGE, host: "shop.example", siteName: "Shop", title: "Shop" },
    signer,
    fetch: notFound,
    signal: new AbortController().signal,
    deadline: Date.now() + 60_000,
  };
  return assembleAssets(input);
};

describe("siteLabel", () => {
  it.each([
    ["linear.app", "linear"],
    ["www.stripe.com", "stripe"],
    ["www.shop.co.uk", "shop"],
    ["assets.shop.com.au", "shop"],
    ["co.uk", "co"],
    ["localhost:3000", "localhost"],
    ["127.0.0.1:8080", ""],
  ])("names %s after %s", (host, label) => {
    expect(siteLabel(host)).toBe(label);
  });
});

describe("assembleAssets hidden counts", () => {
  it("reports the collector's drops together with its own, once each", async () => {
    const hugeSvg = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><!--${"x".repeat(limits.svgMaxBytes)}--></svg>`)}`;
    const collector = collectorOutput({
      candidates: [
        candidate(`${PAGE}logo.png`, 1, 1, { foundIn: "icon-link" }),
        candidate("https://www.google-analytics.com/collect?v=1", 2, 2),
        candidate(hugeSvg, 3, 3, { foundIn: "css-background", visible: true }),
      ],
      noise: { "lottie-frame": 3, "unreferenced-symbol": 2, "svg-too-large": 1 },
    });
    const { hidden } = await run(collector, [captured(`${PAGE}logo.png`)]);
    // Only the collector sees Lottie frames and unreferenced symbols: the engine takes them from here (spec 8.1, 8.2).
    expect(hidden).toEqual({ "lottie-frame": 3, "unreferenced-symbol": 2, "svg-too-large": 2, tracker: 1 });
    expect(collector.noise).toEqual({ "lottie-frame": 3, "unreferenced-symbol": 2, "svg-too-large": 1 });
  });

  it("does not count a missing /favicon.ico the page never declared", async () => {
    const collector = collectorOutput({
      candidates: [candidate(`${PAGE}hero.png`, 1, 1), candidate(`${PAGE}lazy.png`, 2, 2, { foundIn: "lazy-attribute" })],
    });
    const { assets, hidden } = await run(collector, [captured(`${PAGE}hero.png`)]);
    expect(assets.map((a) => a.original?.url)).toEqual([`${PAGE}hero.png`]);
    // the declared lazy URL failed its probe, the /favicon.ico nobody declared is not noise from the page
    expect(hidden).toEqual({ "probe-failed": 1 });
  });

  it("still probes /favicon.ico when the page only declares a meta icon", async () => {
    const collector = collectorOutput({ candidates: [candidate(`${PAGE}tile.png`, 1, 1, { foundIn: "meta-icon" })] });
    const { assets } = await run(collector, [captured(`${PAGE}tile.png`), captured(`${PAGE}favicon.ico`)]);
    expect(assets.map((a) => [a.original?.url, a.role, a.foundIn])).toEqual(
      expect.arrayContaining([
        [`${PAGE}tile.png`, "favicon", ["meta-icon"]],
        [`${PAGE}favicon.ico`, "favicon", ["icon-link"]],
      ]),
    );
    expect(assets).toHaveLength(2);
  });

  it("counts a declared /favicon.ico link that fails its probe", async () => {
    const collector = collectorOutput({ candidates: [candidate(`${PAGE}favicon.ico`, 1, 1, { foundIn: "icon-link" })] });
    const { assets, hidden } = await run(collector);
    expect(assets).toEqual([]);
    expect(hidden).toEqual({ "probe-failed": 1 });
  });
});

describe("assembleAssets CDN original probes", () => {
  const transformed = `${PAGE}media/photo.png?w=400&q=80`;

  it("counts a candidate whose probe failed, instead of falling back to the page's bytes in silence", async () => {
    const collector = collectorOutput({ candidates: [candidate(transformed, 1, 1, { visible: true })] });
    // notFound answers the original with a 404, so the group keeps the transformed URL the page served.
    const { assets, originals } = await run(collector, [captured(transformed)]);
    expect(assets.map((asset) => asset.original?.url)).toEqual([transformed]);
    expect(originals).toEqual({ attempted: 1, adopted: 0, captured: 0, failed: 1, noise: 0, skipped: 0 });
  });

  it("keeps an original the page served itself out of the probe counters", async () => {
    const original = `${PAGE}media/photo.png`;
    const collector = collectorOutput({
      candidates: [candidate(transformed, 1, 1, { visible: true }), candidate(original, 1, 2, { visible: true })],
    });
    const { assets, originals } = await run(collector, [
      captured(transformed, { width: 1200, height: 900, bytes: 50_000 }),
      captured(original),
    ]);
    expect(assets.map((asset) => asset.original?.url)).toEqual([original]);
    // No request went out for it, so `attempted` stays a count of probes and the adoption lands in its own bucket.
    expect(originals).toEqual({ attempted: 0, adopted: 0, captured: 1, failed: 0, noise: 0, skipped: 0 });
  });

  it("reports a skipped probe even when the group ends on a candidate the page also served", async () => {
    // Two candidates: the Contentful original, which nobody captured, then the transformed URL the page declared.
    const intermediate = "https://images.ctfassets.net/s/a/b/c.png?w=400&fm=avif";
    const wrapper = `https://www.gymshark.com/_next/image?url=${encodeURIComponent(intermediate)}&w=1920&q=75`;
    // The first candidate is the fully stripped URL: its probe outlives the deadline, so `verifyUrl` returns
    // `verify-skipped` without the limiter ever queueing a task, and only `resolve` knows the check was partial.
    const deadline = Date.now() + 300;
    // Outlives the deadline however the machine schedules it, so the probe always ends as `verify-skipped`.
    const tooSlow: SafeFetch = async () => {
      while (Date.now() < deadline + 20) await new Promise((resolve) => setTimeout(resolve, 20));
      throw new Error("after the deadline");
    };
    const collector = collectorOutput({
      candidates: [
        candidate(wrapper, 1, 1, { visible: true }),
        candidate(intermediate, 1, 2, { visible: true }),
        // Declared and captured, so the implicit /favicon.ico probe never queues a task the limiter skips: the only
        // record of the skip is the one `resolve` keeps.
        candidate(`${PAGE}favicon.ico`, 2, 3, { foundIn: "icon-link" }),
      ],
    });
    const input: PostInput = {
      collector,
      network: {
        images: [
          captured(wrapper, { width: 1200, height: 900, bytes: 50_000 }),
          captured(intermediate),
          captured(`${PAGE}favicon.ico`, { width: 32, height: 32, bytes: 1_000 }),
        ],
        fonts: [], sheets: [], bodyTimeouts: 0, skippedBodies: 0,
      },
      page: { requestedUrl: PAGE, finalUrl: PAGE, host: "shop.example", siteName: "Shop", title: "Shop" },
      signer: { sign: proxyOf, count: 0 }, fetch: tooSlow, signal: new AbortController().signal, deadline,
    };
    const { assets, warnings } = await assembleAssets(input);
    expect(assets.map((asset) => asset.original?.url)).toContain(intermediate);
    expect(warnings).toContain("verify-skipped");
  });

  it("counts a candidate it adopted", async () => {
    const original = `${PAGE}media/photo.png`;
    // 64x64, so the noise rules keep it: a tiny original would be rejected and counted as noise, not adopted.
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAT0lEQVRo3u3PQQkAAAgEsHub2IjGMoJvYbACS/W8FgEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQGBywJ466EtZ6dwxgAAAABJRU5ErkJggg==", "base64");
    const serveOriginal: SafeFetch = async (url) =>
      url === original
        ? {
            url, status: 200, headers: new Headers({ "content-type": "image/png", "content-length": String(png.length) }), redirected: false,
            stream: () => new ReadableStream({ start: (c) => { c.enqueue(png); c.close(); } }),
            buffer: async () => png, text: async () => "", json: async <T>() => ({}) as T, cancel: async () => {},
          }
        : notFound(url);
    const collector = collectorOutput({ candidates: [candidate(transformed, 1, 1, { visible: true })] });
    const input: PostInput = {
      collector, network: { images: [captured(transformed)], fonts: [], sheets: [], bodyTimeouts: 0, skippedBodies: 0 },
      page: { requestedUrl: PAGE, finalUrl: PAGE, host: "shop.example", siteName: "Shop", title: "Shop" },
      signer: { sign: proxyOf, count: 0 }, fetch: serveOriginal, signal: new AbortController().signal, deadline: Date.now() + 60_000,
    };
    const { assets, originals } = await assembleAssets(input);
    expect(assets.map((asset) => asset.original?.url)).toEqual([original]);
    expect(originals).toMatchObject({ adopted: 1, failed: 0, noise: 0, skipped: 0 });
  });
});

describe("assembleAssets empty captures", () => {
  it("checks an image captured with an empty body again instead of keeping it", async () => {
    const url = `${PAGE}stream.png`;
    const collector = collectorOutput({ candidates: [candidate(`${PAGE}favicon.png`, 1, 1, { foundIn: "icon-link" }), candidate(url, 2, 2, { visible: true })] });
    const { assets, hidden } = await run(collector, [captured(`${PAGE}favicon.png`), captured(url, { bytes: 0, width: undefined, height: undefined, tone: "unknown" })]);
    expect(assets.map((asset) => asset.original?.url)).toEqual([`${PAGE}favicon.png`]);
    expect(hidden).toEqual({ "probe-failed": 1 });
  });
});

describe("assembleAssets signing", () => {
  it("signs http: sources first within the signing cap, since the client always proxies them", async () => {
    const shown = [1, 2, 3].map((i) => `${PAGE}photo-${i}.png`);
    const insecure = "http://legacy.shop.example/old.png";
    const collector = collectorOutput({
      candidates: [
        ...shown.map((url, i) => candidate(url, i + 1, i + 1, { visible: true, rect: { x: 0, y: 0, width: 400, height: 300 } })),
        candidate(insecure, 9, 9),
      ],
    });
    let count = 0;
    const signer: Signer = {
      sign: (url) => {
        if (count >= 2) throw new SignLimitError("signing cap");
        count++;
        return proxyOf(url);
      },
      get count() {
        return count;
      },
    };
    const { assets, warnings } = await run(collector, [...shown, insecure].map((url) => captured(url)), signer);
    const proxies = new Map(assets.map((a) => [a.original?.url, a.original?.proxy]));
    expect(assets.at(-1)?.original?.url).toBe(insecure);
    expect(proxies.get(insecure)).toBe(proxyOf(insecure));
    expect(proxies.get(shown[0])).toBe(proxyOf(shown[0]));
    expect([proxies.get(shown[1]), proxies.get(shown[2])]).toEqual(["", ""]);
    expect(warnings).toContain("truncated");
  });
});

describe("assembleAssets on a heavy page", () => {
  it("handles more candidates than a call can take as arguments, and returns capped results", async () => {
    const elements = 26_000;
    const placeholder = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
    const candidates: RawCandidate[] = [];
    const images: CapturedImage[] = [];
    for (let i = 0; i < elements; i++) {
      const group = i + 1;
      for (const w of [320, 640, 960, 1280, 1600]) {
        candidates.push(candidate(`${PAGE}p/${i}-${w}.jpg`, group, i * 2, { descriptor: { w } }));
      }
      candidates.push(candidate(`${PAGE}p/${i}-640.jpg`, group, i * 2, { naturalWidth: 640, naturalHeight: 480 }));
      // one lazy placeholder shared by every element
      candidates.push(candidate(placeholder, group, i * 2));
      images.push(captured(`${PAGE}p/${i}-640.jpg`, { contentType: "image/jpeg" }));
    }
    expect(candidates.length).toBeGreaterThan(150_000);

    const started = performance.now();
    const { assets, hidden, warnings } = await run(
      collectorOutput({ page: { title: "Shop", siteName: "Shop", baseUrl: PAGE, elementCount: elements * 2 }, candidates }),
      images,
    );
    expect(performance.now() - started).toBeLessThan(30_000);
    expect(assets).toHaveLength(limits.maxAssets);
    expect(assets[0].original?.url).toMatch(/-640\.jpg$/);
    expect(warnings).toEqual(expect.arrayContaining(["truncated", "verify-skipped"]));
    expect(hidden["probe-failed"]).toBeUndefined();
  }, 60_000);
});

describe("assembleAssets on URL-heavy stylesheets", () => {
  afterEach(() => vi.unstubAllEnvs());
  const sheet = (urls: string[]): CapturedSheet => ({
    url: `${PAGE}site.css`,
    status: 200,
    cssText: urls.map((url, i) => `.a${i}{background:url(${url})}`).join("\n"),
  });

  it("reads at most maxStylesheetUrls URLs the network did not load, and every URL it did load", async () => {
    vi.stubEnv("MAX_STYLESHEET_URLS", "5");
    vi.stubEnv("MAX_DECLARED_PROBES", "1000");
    const loaded = `${PAGE}img/loaded.png`;
    const declared = Array.from({ length: 20 }, (_, i) => `${PAGE}img/${i}.png`);
    const { assets, hidden, warnings } = await run(collectorOutput({ candidates: [candidate(`${PAGE}favicon.png`, 1, 1, { foundIn: "icon-link" })] }), [captured(`${PAGE}favicon.png`), captured(loaded)], undefined, [sheet([...declared, loaded])]);
    // Five declared URLs get a record (and fail their probe), the other 15 never do
    expect(hidden).toEqual({ "probe-failed": 5 });
    expect(assets.find((asset) => asset.original?.url === loaded)?.foundIn).toEqual(["stylesheet"]);
    expect(warnings).toContain("truncated");
  });

  it("counts the declared URLs the probe budget stopped, instead of dropping them silently", async () => {
    vi.stubEnv("MAX_STYLESHEET_URLS", "10");
    vi.stubEnv("MAX_DECLARED_PROBES", "4");
    const declared = Array.from({ length: 10 }, (_, i) => `${PAGE}img/${i}.png`);
    const { assets, hidden, warnings } = await run(collectorOutput({}), [], undefined, [sheet(declared)]);
    expect(assets).toEqual([]);
    // Four probes run: the implicit /favicon.ico takes one slot and is not counted, three declared URLs take the rest
    // and fail. The other seven never get a probe, and used to vanish with no hidden entry at all.
    expect(hidden).toEqual({ "probe-failed": 3, "probe-skipped": 7 });
    expect(warnings).toContain("verify-skipped");
  });

  it("reads a 15 MB sheet of 370,000 URLs quickly, keeping only the capped records", async () => {
    const urls = Array.from({ length: 370_000 }, (_, i) => `/img/i${i}.png`);
    const started = performance.now();
    const { assets, hidden, warnings } = await run(collectorOutput({}), [], undefined, [sheet(urls)]);
    expect(performance.now() - started).toBeLessThan(15_000);
    expect(assets).toEqual([]);
    // Probes stop at maxDeclaredProbes, the other capped records are skipped, the rest were never made
    expect(hidden["probe-failed"]).toBeLessThanOrEqual(limits.maxDeclaredProbes);
    expect(warnings).toEqual(expect.arrayContaining(["truncated", "verify-skipped"]));
  }, 60_000);
});

describe("assembleAssets inline rasters", () => {
  const png1x1 = (i: number, padding = 0) => {
    // A 1x1 PNG with a distinct text chunk, so every data URI is a distinct URL
    const base = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    return `data:image/png;base64,${Buffer.concat([base, Buffer.from(String(i)), Buffer.alloc(padding)]).toString("base64")}`;
  };

  it("never decodes raster data URIs under 1 KB, and reads the others a few at a time", async () => {
    metadataCalls.total = 0;
    metadataCalls.peak = 0;
    const tiny = Array.from({ length: 5_000 }, (_, i) => candidate(png1x1(i), i + 1, i + 1));
    const large = Array.from({ length: 20 }, (_, i) => candidate(png1x1(i, 2_000), 10_000 + i, 10_000 + i));
    const { assets, hidden } = await run(collectorOutput({ candidates: [...tiny, ...large] }));
    expect(assets).toEqual([]);
    expect(hidden["tiny-data-uri"]).toBe(5_020);
    expect(metadataCalls.total).toBe(20);
    expect(metadataCalls.peak).toBeLessThanOrEqual(2);
  });
});
