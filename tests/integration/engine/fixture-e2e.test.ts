import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Asset, FontFamily, ScanEvent, type HiddenReason } from "@/lib/contract";
import { safeFetch } from "@/server/net/safe-fetch";
import { createScanEngine } from "@/server/scan/engine";
import { buildFontFamilies } from "@/server/scan/fonts";
import { clearGoogleFontsCache } from "@/server/scan/fonts/google";
import { fakeGoogleFetch } from "@/server/scan/fonts/testing";
import { assembleAssets } from "@/server/scan/post/assemble";
import type { AssetsOutput, FontsOutput, PostInput, SafeFetch } from "@/server/scan/types";
import { verifyAssetParams } from "@/server/security/sign";
import type { FixtureServer } from "../../fixtures/serve";
import { serveAssetsFixture } from "../assets/harness";

/**
 * The whole scan of the fixture site with the default engine (plan Task 2.2): real preflight, egress proxy, Chrome,
 * collector, palette, post-processing and signer. The fixture host is allowed through SCAN_TEST_ALLOW_HOSTS. Only the
 * Google Fonts check is answered locally, and the post-processing modules run behind pass-through spies so the test can
 * check that each hidden count reaches the stats once.
 */

let server: FixtureServer;
let events: ScanEvent[];
let assetsOut: AssetsOutput | undefined;
let fontsOut: FontsOutput | undefined;
let collectorNoise: PostInput["collector"]["noise"] = {};

const google = fakeGoogleFetch(["Inter", "Source Sans 3"]);
const fetch: SafeFetch = (url, options) => (url.startsWith("https://fonts.googleapis.com/") ? google(url, options) : safeFetch(url, options));

/** The URL a signed `/api/asset` path points to, after checking its signature. */
const signedUrl = (proxy: string) => verifyAssetParams(new URLSearchParams(proxy.slice(proxy.indexOf("?") + 1))).url;

beforeAll(async () => {
  server = await serveAssetsFixture();
  clearGoogleFontsCache();
  const engine = createScanEngine({
    fetch,
    assembleAssets: async (input) => {
      collectorNoise = input.collector.noise;
      return (assetsOut = await assembleAssets(input));
    },
    buildFontFamilies: async (input) => (fontsOut = await buildFontFamilies(input)),
  });
  events = [];
  for await (const event of engine.scan({ url: `${server.origin}/` }, { signal: new AbortController().signal })) events.push(ScanEvent.parse(event));
}, 150_000);

afterAll(async () => {
  await server?.close();
});

const assets = () => events.flatMap((event) => (event.type === "assets" ? event.items : []));
const byUrl = (name: string) => assets().filter((a) => [a.display?.url, a.original?.url].some((url) => url?.endsWith(`/assets/${name}`)));
const done = () => {
  const last = events.at(-1);
  if (last?.type !== "done") throw new Error(`expected done, got ${JSON.stringify(last)}`);
  return last;
};

describe("full scan of the fixture site", () => {
  it("finishes without partial results, with the page twice and a palette", () => {
    expect(events.filter((event) => event.type === "done" || event.type === "error")).toHaveLength(1);
    expect(done().partial).toBe(false);
    expect(done().diagnostics.collector).toBe("isolated");
    expect(events.filter((event) => event.type === "warning")).toEqual([]);

    const pages = events.flatMap((event) => (event.type === "page" ? [event.page] : []));
    expect(pages).toHaveLength(2);
    expect(pages[0]).toMatchObject({ host: server.host.split(":")[0], title: "Fixture Co", status: 200, brandLinks: [] });
    expect(pages[1].brandLinks).toContainEqual({ href: `${server.origin}/press`, text: "Press kit" });

    const palette = events.find((event) => event.type === "palette");
    expect(palette?.type === "palette" && palette.palette).not.toBeNull();
    expect(palette?.type === "palette" && palette.palette?.brand.length).toBeGreaterThan(0);
  });

  it("returns the fixture assets (Task C6)", () => {
    const items = assets();
    for (const asset of items) Asset.parse(asset);
    const scores = items.map((a) => a.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    const logos = items.filter((a) => a.role === "site-logo");
    expect(logos).toHaveLength(1);
    expect(items[0]).toEqual(logos[0]);
    expect(logos[0]).toMatchObject({ kind: "svg", display: null, original: null });
    expect(["Fixture home", "Fixture"]).toContain(logos[0].name);
    expect(logos[0].filename).toMatch(/^fixture-/);

    const photos = byUrl("photo-large.png");
    expect(photos).toHaveLength(1);
    expect(photos[0].display?.url).toMatch(/\/photo-small\.png$/);
    expect(byUrl("hero.jpg")).toHaveLength(1);
    expect(byUrl("hero.jpg")[0]).not.toEqual(photos[0]);
    expect(byUrl("pixel.gif")).toEqual([]);
    expect((done().stats.hidden.spacer ?? 0) + (done().stats.hidden.pixel ?? 0)).toBeGreaterThanOrEqual(1);
    expect(items.some((a) => a.inline && "base64" in a.inline && a.inline.mime === "image/gif")).toBe(false);

    expect(byUrl("hover.png")).toEqual([expect.objectContaining({ declaredOnly: true })]);
    expect(byUrl("mask.svg")).toEqual([expect.objectContaining({ kind: "svg" })]);
    expect(byUrl("og.png")[0]).toMatchObject({ role: "social", foundIn: expect.arrayContaining(["og-image"]) });
    expect(items.some((a) => a.original?.url.includes("example.invalid"))).toBe(false);
    expect(done().stats.hidden["probe-failed"]).toBeGreaterThanOrEqual(1);

    const blobs = items.filter((a) => a.inline && "base64" in a.inline);
    expect(blobs).toEqual([expect.objectContaining({ display: null, format: "png" })]);

    expect(new Set(items.map((a) => a.filename)).size).toBe(items.length);
    for (const asset of items) {
      expect(asset.tone).toBeTruthy();
      if (asset.inline) continue;
      for (const source of [asset.display, asset.original]) if (source) expect(signedUrl(source.proxy)).toBe(source.url);
    }
  });

  it("returns the fixture fonts (Task D4)", () => {
    const fontsEvent = events.find((event) => event.type === "fonts");
    if (fontsEvent?.type !== "fonts") throw new Error("expected a fonts event");
    const families = fontsEvent.families.map((family) => FontFamily.parse(family));
    expect(families.map((family) => family.name)).toEqual(["Inter", "Brand Serif", "Unused Face"]);
    const [inter, brand, unused] = families;

    expect(inter).toMatchObject({ cssFamilies: ["__Inter_d65c78"], source: "self-hosted", usedOnPage: true, googleFamily: "Inter", license: { kind: "open" }, convertible: true, downloadable: true });
    expect(inter.axes).toContainEqual(expect.objectContaining({ tag: "wght" }));
    expect(inter.faces).toEqual([expect.objectContaining({ weight: "100 900", style: "normal", loaded: true })]);
    expect(inter.faces[0].files).toHaveLength(2);
    expect(inter.faces[0].files.map((file) => file.coversLatin)).toContain(true);

    expect(brand).toMatchObject({ usedOnPage: true, googleFamily: "Source Sans 3", convertible: true });
    expect(unused).toMatchObject({ usedOnPage: false });
    expect(unused.faces).toEqual([expect.objectContaining({ loaded: false })]);
    expect(unused.faces[0].files[0].bytes).toBeUndefined();

    for (let i = 1; i < families.length; i += 1) {
      const [a, b] = [families[i - 1], families[i]];
      expect(a.usage > b.usage || (a.usage === b.usage && (a.usedOnPage || !b.usedOnPage))).toBe(true);
    }
    for (const file of families.flatMap((family) => family.faces.flatMap((face) => face.files))) expect(signedUrl(file.proxy)).toBe(file.url);
  });

  it("counts each hidden asset once", () => {
    if (!assetsOut || !fontsOut) throw new Error("post-processing did not run");
    const expected: Partial<Record<HiddenReason, number>> = {};
    for (const counts of [assetsOut.hidden, fontsOut.hidden])
      for (const [reason, count] of Object.entries(counts)) if (count) expected[reason as HiddenReason] = (expected[reason as HiddenReason] ?? 0) + count;
    // The collector drops something on the fixture, so a second count of its noise would show.
    expect(Object.keys(collectorNoise).length).toBeGreaterThan(0);
    expect(done().stats.hidden).toEqual(expected);
  });
});
