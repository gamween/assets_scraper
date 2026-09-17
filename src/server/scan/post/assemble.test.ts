import { describe, expect, it } from "vitest";
import { limits } from "@/server/config/limits";
import type { CandidateContext, CapturedImage, PostInput, RawCandidate, RawCollectorOutput, SafeFetch } from "../types";
import { assembleAssets } from "./assemble";

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

const run = (collector: RawCollectorOutput, images: CapturedImage[] = []) => {
  const input: PostInput = {
    collector,
    network: { images, fonts: [], sheets: [], bodyTimeouts: 0, skippedBodies: 0 },
    page: { requestedUrl: PAGE, finalUrl: PAGE, host: "shop.example", siteName: "Shop", title: "Shop" },
    signer: { sign: (url) => `/api/asset?u=${encodeURIComponent(url)}`, count: 0 },
    fetch: notFound,
    signal: new AbortController().signal,
    deadline: Date.now() + 60_000,
  };
  return assembleAssets(input);
};

describe("assembleAssets hidden counts", () => {
  it("counts its own drops only, never the collector's", async () => {
    const collector = collectorOutput({
      candidates: [
        candidate(`${PAGE}logo.png`, 1, 1, { foundIn: "icon-link" }),
        candidate("https://www.google-analytics.com/collect?v=1", 2, 2),
      ],
      noise: { "lottie-frame": 3, "unreferenced-symbol": 2, "svg-too-large": 1 },
    });
    const { hidden } = await run(collector, [captured(`${PAGE}logo.png`)]);
    expect(hidden).toEqual({ tracker: 1 });
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

  it("counts a declared /favicon.ico link that fails its probe", async () => {
    const collector = collectorOutput({ candidates: [candidate(`${PAGE}favicon.ico`, 1, 1, { foundIn: "icon-link" })] });
    const { assets, hidden } = await run(collector);
    expect(assets).toEqual([]);
    expect(hidden).toEqual({ "probe-failed": 1 });
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
