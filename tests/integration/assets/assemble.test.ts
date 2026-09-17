import type { Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Asset, Tone } from "@/lib/contract";
import { SignLimitError } from "@/server/security/sign";
import { assembleAssets } from "@/server/scan/post/assemble";
import type { AssetsOutput, PostInput, Signer } from "@/server/scan/types";
import type { FixtureServer } from "../../fixtures/serve";
import { collectorOptions, launchChrome, openPage, runCollector, serveAssetsFixture, testFetch } from "./harness";

let server: FixtureServer;
let browser: Browser;
let input: PostInput;
let output: AssetsOutput;

const fakeSigner = (max = Infinity): Signer => {
  let count = 0;
  return {
    sign: (url) => {
      if (count >= max) throw new SignLimitError("signing cap");
      count++;
      return `/api/asset?u=${url}`;
    },
    get count() {
      return count;
    },
  };
};

const byUrl = (name: string) =>
  output.assets.filter((a) => [a.display?.url, a.original?.url].some((url) => url?.endsWith(`/assets/${name}`)));

beforeAll(async () => {
  server = await serveAssetsFixture();
  browser = await launchChrome();
  const { context, page, capture } = await openPage(browser, `${server.origin}/`);
  const collector = await runCollector(page, collectorOptions(server.host, "Fixture"));
  const network = await capture.settle();
  await context.close();
  input = {
    collector,
    network,
    page: { requestedUrl: `${server.origin}/`, finalUrl: `${server.origin}/`, host: server.host, siteName: "Fixture", title: "Fixture Co" },
    signer: fakeSigner(),
    fetch: testFetch,
    signal: new AbortController().signal,
    deadline: Date.now() + 8_000,
  };
  output = await assembleAssets(input);
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

describe("assembleAssets on the fixture page", () => {
  it("returns valid assets sorted by relevance with the site logo first", () => {
    for (const asset of output.assets) Asset.parse(asset);
    const scores = output.assets.map((a) => a.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    const logos = output.assets.filter((a) => a.role === "site-logo");
    expect(logos).toHaveLength(1);
    expect(output.assets[0]).toBe(logos[0]);
    expect(logos[0]).toMatchObject({ kind: "svg", format: "svg", display: null, original: null, visible: true });
    expect(logos[0].inline).toMatchObject({ mime: "image/svg+xml" });
    expect(["Fixture home", "Fixture"]).toContain(logos[0].name);
    expect(logos[0].filename).toMatch(/^fixture-[a-z0-9-]*\.svg$/);
    expect(output.warnings).toEqual([]);
  });

  it("merges size variants and keeps the displayed version for tiles", () => {
    const photos = byUrl("photo-large.png");
    expect(photos).toHaveLength(1);
    expect(photos[0].display?.url).toMatch(/\/photo-small\.png$/);
    expect(photos[0].original?.url).toMatch(/\/photo-large\.png$/);
    expect(photos[0]).toMatchObject({ kind: "image", format: "png", role: "image", visible: true, renderedWidth: 200, renderedHeight: 100 });
    expect(photos[0].original).toMatchObject({ format: "png", width: expect.any(Number), height: expect.any(Number), bytes: expect.any(Number) });
    expect(byUrl("photo-small.png")).toEqual(photos);
    const hero = byUrl("hero.jpg");
    expect(hero).toHaveLength(1);
    expect(hero[0]).not.toBe(photos[0]);
    expect(hero[0].tone).toBe("opaque");
  });

  it("drops noise and counts it", () => {
    expect(byUrl("pixel.gif")).toEqual([]);
    expect((output.hidden.spacer ?? 0) + (output.hidden.pixel ?? 0)).toBeGreaterThanOrEqual(1);
    expect(output.assets.some((a) => a.inline && "base64" in a.inline && a.inline.mime === "image/gif")).toBe(false);
    expect(output.hidden["tiny-data-uri"]).toBeGreaterThanOrEqual(1);
  });

  it("keeps declared, masked and social images with their origin", () => {
    expect(byUrl("hover.png")).toEqual([expect.objectContaining({ declaredOnly: true, visible: false, foundIn: ["stylesheet"] })]);
    expect(byUrl("mask.svg")).toEqual([expect.objectContaining({ kind: "svg", format: "svg" })]);
    const [og] = byUrl("og.png");
    expect(og.role).toBe("social");
    expect(og.foundIn).toContain("og-image");
    expect(byUrl("touch.png")[0]?.role).toBe("favicon");
    expect(byUrl("lazy.jpg")[0]).toMatchObject({ foundIn: ["lazy-attribute"], format: "jpg", role: "image", visible: false });
    expect(byUrl("shadow.png")[0]?.foundIn).toContain("shadow-dom");
  });

  it("drops the JSON-LD logo whose probe failed", () => {
    expect(output.assets.some((a) => a.original?.url.includes("example.invalid"))).toBe(false);
    expect(output.hidden["probe-failed"]).toBeGreaterThanOrEqual(1);
  });

  it("sends blob images inline", () => {
    const blobs = output.assets.filter((a) => a.inline && "base64" in a.inline);
    expect(blobs).toHaveLength(1);
    expect(blobs[0]).toMatchObject({ display: null, original: null, format: "png", width: 320, height: 160 });
    expect(blobs[0].inline).toMatchObject({ mime: "image/png", base64: expect.stringMatching(/^iVBOR/) });
  });

  it("signs remote sources, names files uniquely and tones everything", () => {
    const filenames = output.assets.map((a) => a.filename);
    expect(new Set(filenames).size).toBe(filenames.length);
    expect(new Set(output.assets.map((a) => a.id)).size).toBe(output.assets.length);
    for (const asset of output.assets) {
      expect(Tone.options).toContain(asset.tone);
      expect(asset.filename.length).toBeLessThanOrEqual(80);
      expect(asset.filename).toMatch(/^fixture[-.]/);
      if (asset.inline) continue;
      expect(asset.display?.proxy).toBe(`/api/asset?u=${asset.display?.url}`);
      expect(asset.original?.proxy).toBe(`/api/asset?u=${asset.original?.url}`);
    }
    expect(output.assets[0].tone).toBe("opaque");
  });

  it("gives inline SVGs roles and counts", () => {
    const icons = output.assets.filter((a) => a.inline && "text" in a.inline && a.inline.text.includes("rgb(0, 170, 119)"));
    expect(icons).toEqual([expect.objectContaining({ role: "icon", usedCount: 2, renderedWidth: 40, renderedHeight: 40, width: 40, height: 40, tone: "mixed" })]);
    expect(output.assets.filter((a) => a.role === "sprite-symbol" && a.inline)).toEqual([expect.objectContaining({ visible: false, foundIn: ["sprite-symbol"] })]);
  });

  it("ranks an external sprite sheet file with the sprite symbols", () => {
    expect(byUrl("sprite.svg")).toEqual([expect.objectContaining({ kind: "svg", role: "sprite-symbol", foundIn: ["network"], visible: false })]);
  });
});

describe("assembleAssets limits", () => {
  it("skips verification after the deadline, warns and caps the asset count", async () => {
    const late = await assembleAssets({ ...input, signer: fakeSigner(), deadline: Date.now() - 1 });
    expect(late.warnings).toContain("verify-skipped");
    expect(late.assets.some((a) => a.original?.url.endsWith("/photo-small.png"))).toBe(true);
    expect(late.assets.some((a) => a.original?.url.endsWith("/hover.png"))).toBe(false);
    expect(late.hidden["probe-failed"]).toBeUndefined();

    process.env.MAX_DECLARED_PROBES = "1";
    try {
      // The one probe goes to the most relevant URL, the JSON-LD logo, which fails; the rest are skipped.
      const probed = await assembleAssets({ ...input, signer: fakeSigner() });
      expect(probed.warnings).toContain("verify-skipped");
      expect(probed.hidden["probe-failed"]).toBe(1);
      const captured = new Set(input.network.images.map((i) => i.url));
      expect(probed.assets.filter((a) => a.original && !captured.has(a.original.url))).toEqual([]);
      const photo = probed.assets.find((a) => a.display?.url.endsWith("/photo-small.png"));
      expect(photo?.original?.url).toMatch(/\/photo-small\.png$/);
    } finally {
      delete process.env.MAX_DECLARED_PROBES;
    }

    process.env.MAX_ASSETS = "5";
    try {
      const capped = await assembleAssets({ ...input, signer: fakeSigner() });
      expect(capped.assets).toHaveLength(5);
      expect(capped.warnings).toContain("truncated");
      expect(capped.assets.map((a) => a.id)).toEqual(output.assets.slice(0, 5).map((a) => a.id));
    } finally {
      delete process.env.MAX_ASSETS;
    }
  });

  it("signs the most relevant sources first and warns at the signing cap", async () => {
    const capped = await assembleAssets({ ...input, signer: fakeSigner(3) });
    const sources = capped.assets.flatMap((a) => [a.display, a.original]).filter((source) => source !== null);
    const urls = [...new Set(sources.map((source) => source.url))];
    expect(urls.length).toBeGreaterThan(3);
    for (const source of sources) expect(source.proxy).toBe(urls.indexOf(source.url) < 3 ? `/api/asset?u=${source.url}` : "");
    expect(capped.warnings).toContain("truncated");

    const broken: Signer = { sign: () => { throw new Error("no secret"); }, count: 0 };
    await expect(assembleAssets({ ...input, signer: broken })).rejects.toThrow("no secret");
  });
});
