import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Asset } from "@/lib/contract";
import { downloadAssets, type DownloadManifest } from "./download";
import { agentLimitEnvName } from "./limits";
import { testAsset, testScan } from "./testing";
import type { AgentScan, ScanSource } from "./types";

/**
 * `downloadAssets` against a fake source (plan Task G2.1): what lands on disk, what the manifest says, and the four
 * rules a download must not break (nothing outside the destination, nothing overwritten, one file per picture, the
 * byte budget).
 */

let dir: string;
const restore: Record<string, string | undefined> = {};

const setLimit = (name: Parameters<typeof agentLimitEnvName>[0], value: number): void => {
  const variable = agentLimitEnvName(name);
  if (!(variable in restore)) restore[variable] = process.env[variable];
  process.env[variable] = String(value);
};

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-download-")));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [name, value] of Object.entries(restore)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    delete restore[name];
  }
});

interface FakeSource extends ScanSource {
  /** Every URL `fetchBytes` was asked for, in order. */
  requests: string[];
  /** The most fetches that were ever in flight at the same time. */
  peak: number;
}

/** A source answering from `bodies` by URL. A body that is an `Error` fails the fetch; an absent URL is a 404. */
const fakeSource = (bodies: Record<string, Buffer | Error>, delayMs = 0): FakeSource => {
  const requests: string[] = [];
  let inFlight = 0;
  const source: FakeSource = {
    kind: "local",
    requests,
    peak: 0,
    scan: () => Promise.reject(new Error("the fake source does not scan")),
    async fetchBytes(target) {
      const url = "url" in target ? target.url : "";
      requests.push(url);
      inFlight += 1;
      source.peak = Math.max(source.peak, inFlight);
      try {
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        const body = bodies[url];
        if (body === undefined) throw new Error(`HTTP 404 for ${url}`);
        if (body instanceof Error) throw body;
        return body;
      } finally {
        inFlight -= 1;
      }
    },
  };
  return source;
};

const urlOf = (asset: Asset): string => asset.original?.url ?? asset.display?.url ?? "";

/** A scan holding exactly `assets`, so a test only has to describe the assets it cares about. */
const scanOf = (assets: Asset[], patch: Partial<AgentScan> = {}): AgentScan =>
  testScan({ assets, fonts: [], ...patch });

const readManifest = (result: { manifestPath: string }): DownloadManifest =>
  JSON.parse(fs.readFileSync(result.manifestPath, "utf8")) as DownloadManifest;

describe("downloadAssets", () => {
  it("writes svg and images into the destination and records every file in the manifest", async () => {
    const logo = testAsset({ id: "logo", kind: "svg", format: "svg", role: "site-logo", name: "Logo", filename: "logo.svg" });
    const hero = testAsset({ id: "hero", filename: "hero.png", name: "Hero", width: 1600, height: 900 });
    const svgBytes = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>");
    const heroBytes = Buffer.from("hero-bytes");
    const source = fakeSource({ [urlOf(logo)]: svgBytes, [urlOf(hero)]: heroBytes });

    const result = await downloadAssets(scanOf([logo, hero]), source, { dest: dir });

    expect(result.dir).toBe(dir);
    expect(result.files.map((file) => path.relative(dir, file.path)).sort()).toEqual(["images/hero.png", "svg/logo.svg"]);
    expect(fs.readFileSync(path.join(dir, "svg/logo.svg"), "utf8")).toMatch(/^<svg/);
    expect(result.totalBytes).toBe(svgBytes.length + heroBytes.length);
    expect(result.failed).toEqual([]);

    const manifest = readManifest(result);
    expect(manifest.page.host).toBe("stripe.com");
    expect(manifest.profile).toBe("deck");
    expect(manifest.files).toHaveLength(2);
    expect(manifest.files.find((file) => file.id === "hero")).toMatchObject({
      file: "images/hero.png",
      name: "Hero",
      url: urlOf(hero),
      role: "image",
      kind: "image",
      width: 1600,
      height: 900,
      bytes: heroBytes.length,
      keptBecause: "deck profile (role image)",
    });
  });

  it("writes an inline SVG from its markup without any request", async () => {
    const inline = testAsset({
      id: "inline",
      kind: "svg",
      format: "svg",
      role: "logo",
      filename: "wordmark.svg",
      display: null,
      original: null,
      inline: { mime: "image/svg+xml", text: "<svg id='inline'/>" },
    });
    const source = fakeSource({});

    const result = await downloadAssets(scanOf([inline]), source, { dest: dir });

    expect(source.requests).toEqual([]);
    expect(fs.readFileSync(path.join(dir, "svg/wordmark.svg"), "utf8")).toBe("<svg id='inline'/>");
    expect(result.files[0]).toMatchObject({ id: "inline", bytes: 18 });
    expect(readManifest(result).files[0].url).toBe("");
  });

  it("resolves the destination from the project when no dest is given", async () => {
    fs.mkdirSync(path.join(dir, "project", ".git"), { recursive: true });
    const logo = testAsset({ id: "logo", kind: "svg", format: "svg", role: "logo", filename: "logo.svg" });
    const source = fakeSource({ [urlOf(logo)]: Buffer.from("<svg/>") });

    const result = await downloadAssets(scanOf([logo]), source, { cwd: path.join(dir, "project") });

    expect(result.dir).toBe(path.join(dir, "project", "scrap", "stripe.com"));
    expect(fs.existsSync(path.join(result.dir, "svg/logo.svg"))).toBe(true);
  });
});

/** A smooth deterministic pattern: it survives a resize, so two sizes of it are the same picture. */
const pattern = (width: number, height: number): Promise<Buffer> => {
  const raw = Buffer.alloc(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      raw[y * width + x] = Math.max(0, Math.min(255, Math.round(128 + 110 * Math.sin((x / width) * 7) * Math.cos((y / height) * 3))));
    }
  }
  return sharp(raw, { raw: { width, height, channels: 1 } }).png().toBuffer();
};

describe("downloadAssets, the byte rules", () => {
  it("drops a duplicate found in the bytes instead of leaving it on disk", async () => {
    const svg = testAsset({ id: "svg", kind: "svg", format: "svg", role: "logo", filename: "mark.svg" });
    const copy = testAsset({ id: "copy", filename: "mark-copy.png", width: 1200, height: 800, score: 40 });
    const bytes = Buffer.from("<svg id='mark'/>");
    const source = fakeSource({ [urlOf(svg)]: bytes, [urlOf(copy)]: bytes });

    const result = await downloadAssets(scanOf([svg, copy]), source, { dest: dir });

    expect(result.files.map((file) => file.id)).toEqual(["svg"]);
    expect(result.dropped.duplicate).toBe(1);
    expect(fs.readdirSync(path.join(dir, "svg"))).toEqual(["mark.svg"]);
    expect(fs.existsSync(path.join(dir, "images"))).toBe(false);
    const manifest = readManifest(result);
    expect(manifest.files[0].duplicatesDropped).toEqual(["copy"]);
  });

  it("keeps one file when the same picture was served at two sizes", async () => {
    const big = testAsset({ id: "big", filename: "hero.png", width: 1600, height: 1200 });
    const small = testAsset({ id: "small", filename: "hero-small.png", width: 800, height: 600, score: 30 });
    const source = fakeSource({
      [urlOf(big)]: await pattern(1600, 1200),
      [urlOf(small)]: await sharp(await pattern(1600, 1200)).resize(800, 600).png().toBuffer(),
    });

    const result = await downloadAssets(scanOf([big, small]), source, { dest: dir });

    expect(result.files.map((file) => file.id)).toEqual(["big"]);
    expect(result.dropped["near-duplicate"]).toBe(1);
    expect(fs.readdirSync(path.join(dir, "images"))).toEqual(["hero.png"]);
  });

  it("skips a file whose bytes are already on disk and writes a second copy of different bytes", async () => {
    const asset = testAsset({ id: "logo", kind: "svg", format: "svg", role: "logo", filename: "logo.svg" });
    const first = Buffer.from("<svg id='one'/>");
    const run = (bytes: Buffer) => downloadAssets(scanOf([asset]), fakeSource({ [urlOf(asset)]: bytes }), { dest: dir });

    await run(first);
    const written = fs.statSync(path.join(dir, "svg/logo.svg")).mtimeMs;
    const again = await run(first);
    expect(again.files[0].path).toBe(path.join(dir, "svg/logo.svg"));
    expect(fs.statSync(path.join(dir, "svg/logo.svg")).mtimeMs).toBe(written);
    expect(fs.readdirSync(path.join(dir, "svg"))).toEqual(["logo.svg"]);

    const changed = await run(Buffer.from("<svg id='two'/>"));
    expect(path.basename(changed.files[0].path)).toBe("logo-2.svg");
    expect(fs.readFileSync(path.join(dir, "svg/logo.svg"), "utf8")).toBe("<svg id='one'/>");
  });
});

describe("downloadAssets, the limits", () => {
  it("records a failed fetch and keeps going", async () => {
    const good = testAsset({ id: "good", kind: "svg", format: "svg", role: "logo", filename: "good.svg" });
    const bad = testAsset({ id: "bad", kind: "svg", format: "svg", role: "logo", name: "Bad", filename: "bad.svg" });
    const source = fakeSource({ [urlOf(good)]: Buffer.from("<svg/>"), [urlOf(bad)]: new Error("HTTP 403 for the CDN") });

    const result = await downloadAssets(scanOf([good, bad]), source, { dest: dir });

    expect(result.files.map((file) => file.id)).toEqual(["good"]);
    expect(result.failed).toEqual([{ id: "bad", name: "Bad", reason: "HTTP 403 for the CDN" }]);
    expect(readManifest(result).failed).toHaveLength(1);
  });

  it("stops at the byte budget and reports the rest as unavailable", async () => {
    setLimit("maxDownloadBytes", 40);
    const assets = Array.from({ length: 4 }, (_, index) =>
      testAsset({ id: `a${index}`, kind: "svg", format: "svg", role: "logo", filename: `a${index}.svg`, score: 100 - index }),
    );
    // Distinct drawings per asset: identical ones would be dropped as duplicates before the budget was ever reached, and
    // two that differ only in an id are the same drawing as far as the duplicate rule is concerned.
    const bodies = Object.fromEntries(assets.map((asset, index) => [urlOf(asset), Buffer.from(`<svg><rect width='${index + 1}'/></svg>`.padEnd(30, " "))]));
    const source = fakeSource(bodies);

    const result = await downloadAssets(scanOf(assets), source, { dest: dir, concurrency: 1 });

    expect(result.files.map((file) => file.id)).toEqual(["a0", "a1"]);
    expect(result.totalBytes).toBe(60);
    expect(result.dropped.unavailable).toBe(2);
    expect(source.requests).toHaveLength(2);
  });

  it("never runs more fetches at once than the limit allows", async () => {
    setLimit("downloadConcurrency", 2);
    const assets = Array.from({ length: 8 }, (_, index) =>
      testAsset({ id: `a${index}`, kind: "svg", format: "svg", role: "logo", filename: `a${index}.svg` }),
    );
    const source = fakeSource(Object.fromEntries(assets.map((asset, index) => [urlOf(asset), Buffer.from(`<svg><rect width='${index + 1}'/></svg>`)])), 5);

    const result = await downloadAssets(scanOf(assets), source, { dest: dir });

    expect(result.files).toHaveLength(8);
    expect(source.peak).toBe(2);
  });

  it("keeps a file named to escape the destination inside it", async () => {
    const evil = testAsset({ id: "evil", kind: "svg", format: "svg", role: "logo", name: "../../evil", filename: "../../evil.svg" });
    const source = fakeSource({ [urlOf(evil)]: Buffer.from("<svg/>") });

    const result = await downloadAssets(scanOf([evil]), source, { dest: path.join(dir, "out") });

    expect(result.files[0].path.startsWith(path.join(dir, "out") + path.sep)).toBe(true);
    expect(fs.existsSync(path.join(dir, "evil.svg"))).toBe(false);
    expect(fs.readdirSync(path.join(dir))).toEqual(["out"]);
  });

  it("names the assets an explicit id list asked for as kept on purpose", async () => {
    const icon = testAsset({ id: "icon", role: "icon", filename: "icon.png", width: 32, height: 32 });
    const source = fakeSource({ [urlOf(icon)]: Buffer.from("icon-bytes") });

    const result = await downloadAssets(scanOf([icon]), source, { dest: dir, ids: ["icon"] });

    expect(result.files.map((file) => file.id)).toEqual(["icon"]);
    expect(readManifest(result).files[0].keptBecause).toBe("explicit id");
  });
});

describe("downloadAssets, the destination", () => {
  it("writes paths in the manifest relative to the folder itself when the destination is a link", async () => {
    fs.mkdirSync(path.join(dir, "real"));
    fs.symlinkSync(path.join(dir, "real"), path.join(dir, "link"));
    const logo = testAsset({ id: "logo", kind: "svg", format: "svg", role: "logo", filename: "logo.svg" });
    const source = fakeSource({ [urlOf(logo)]: Buffer.from("<svg/>") });

    const result = await downloadAssets(scanOf([logo]), source, { dest: path.join(dir, "link") });

    expect(result.dir).toBe(path.join(dir, "real"));
    expect(readManifest(result).files[0].file).toBe("svg/logo.svg");
    expect(fs.existsSync(path.join(dir, "real", "svg/logo.svg"))).toBe(true);
  });
});

/** A distinct fill per id, so two files are never byte-identical and the duplicate rules leave them alone. */
const fillOf = (id: string): number => id.charCodeAt(0);

/**
 * The byte rules on the download path: the same `selectAssets` the MCP tool and the hosted ZIP run, so what lands in
 * `scrap/<host>` is bounded by bytes and says so in the manifest.
 */
describe("downloadAssets, byte rules", () => {
  const MB = 1024 * 1024;

  /** Three 4 MB photographs and a 9 MB budget: the two best score, and the manifest says why the third is missing. */
  it("writes the best scoring files inside the budget and reports it in the manifest", async () => {
    const photos = ["a", "b", "c"].map((id, index) =>
      testAsset({ id, filename: `${id}.png`, width: 2400, height: 1600, score: 90 - index * 10, order: index }),
    );
    const bodies = Object.fromEntries(photos.map((asset) => [urlOf(asset), Buffer.alloc(4 * MB, fillOf(asset.id))]));
    const source = fakeSource(bodies);

    const result = await downloadAssets(scanOf(photos), source, { dest: dir, maxTotalBytes: 9 * MB });

    expect(result.files.map((file) => file.id)).toEqual(["a", "b"]);
    expect(result.totalBytes).toBe(8 * MB);
    expect(result.dropped["over-budget"]).toBe(1);
    expect(fs.readdirSync(path.join(dir, "images")).sort()).toEqual(["a.png", "b.png"]);

    const manifest = readManifest(result);
    expect(manifest.budget).toEqual({ maxTotalBytes: 9 * MB, maxFileBytes: 8 * MB, keptBytes: 8 * MB });
    expect(manifest.dropped["over-budget"]).toBe(1);
  });

  it("drops a file over the per-file ceiling even when the scan measured nothing", async () => {
    const small = testAsset({ id: "small", filename: "small.png", width: 1200, height: 900, score: 60 });
    const huge = testAsset({ id: "huge", filename: "huge.png", width: 4000, height: 3000, score: 90 });
    const source = fakeSource({ [urlOf(small)]: Buffer.alloc(1_000), [urlOf(huge)]: Buffer.alloc(9 * MB) });

    const result = await downloadAssets(scanOf([small, huge]), source, { dest: dir });

    expect(result.files.map((file) => file.id)).toEqual(["small"]);
    expect(result.dropped["too-large"]).toBe(1);
    expect(fs.existsSync(path.join(dir, "images/huge.png"))).toBe(false);
  });

  /** A scan that measured the file is a scan that never spends a byte on it. */
  it("does not fetch a file the scan already measured over the ceiling", async () => {
    const huge = testAsset({ id: "huge", filename: "huge.png", width: 4000, height: 3000, bytes: 30 * MB });
    const source = fakeSource({ [urlOf(huge)]: Buffer.alloc(1_000) });

    const result = await downloadAssets(scanOf([huge]), source, { dest: dir });

    expect(source.requests).toEqual([]);
    expect(result.files).toEqual([]);
    expect(result.dropped["too-large"]).toBe(1);
  });

  it("writes an asset named by id whatever it weighs", async () => {
    const huge = testAsset({ id: "huge", filename: "huge.png", width: 4000, height: 3000, bytes: 30 * MB });
    const source = fakeSource({ [urlOf(huge)]: Buffer.alloc(30 * MB) });

    const result = await downloadAssets(scanOf([huge]), source, { dest: dir, ids: ["huge"] });

    expect(result.files.map((file) => file.id)).toEqual(["huge"]);
    expect(result.dropped).toEqual({});
    expect(readManifest(result).budget).toEqual({ maxTotalBytes: 0, maxFileBytes: 0, keptBytes: 30 * MB });
  });

  it("reads the limits from the environment like every other agent limit", async () => {
    setLimit("maxTotalBytes", 3_000);
    const assets = ["a", "b"].map((id, index) =>
      testAsset({ id, filename: `${id}.png`, width: 1200, height: 900, score: 90 - index * 10, order: index }),
    );
    const source = fakeSource(Object.fromEntries(assets.map((asset) => [urlOf(asset), Buffer.alloc(2_000, fillOf(asset.id))])));

    const result = await downloadAssets(scanOf(assets), source, { dest: dir });

    expect(result.files.map((file) => file.id)).toEqual(["a"]);
    expect(result.dropped["over-budget"]).toBe(1);
  });
});
