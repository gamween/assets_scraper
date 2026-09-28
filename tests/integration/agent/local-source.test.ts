import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadScan, saveScan } from "@/agent/cache";
import { createScanSource } from "@/agent/source";
import { summarize } from "@/agent/summary";
import type { AgentScan } from "@/agent/types";
import { Asset, FontFamily } from "@/lib/contract";
import { ScanFailure } from "@/server/errors";
import type { FixtureServer } from "../../fixtures/serve";
import { serveAssetsFixture } from "../assets/harness";

/**
 * The agent core against the fixture site with the real engine (plan Task G1.5): one local scan folded into an
 * `AgentScan`, cached, summarized, and its bytes fetched back.
 */

let server: FixtureServer;
let scan: AgentScan;
let steps: string[];
let cache: string;
let previousCache: string | undefined;

beforeAll(async () => {
  previousCache = process.env.XDG_CACHE_HOME;
  cache = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-local-")));
  process.env.XDG_CACHE_HOME = cache;
  server = await serveAssetsFixture();
  steps = [];
  scan = await createScanSource().scan(`${server.origin}/`, { onStep: (step) => steps.push(step) });
}, 150_000);

afterAll(async () => {
  await server?.close();
  if (previousCache === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = previousCache;
  fs.rmSync(cache, { recursive: true, force: true });
});

describe("createScanSource, local", () => {
  it("runs the v1 engine and returns one scan", () => {
    expect(createScanSource().kind).toBe("local");
    expect(scan.source).toBe("local");
    expect(scan.page).toMatchObject({ url: `${server.origin}/`, finalUrl: `${server.origin}/`, host: "127.0.0.1", title: "Fixture Co" });
    expect(scan.warnings).toEqual([]);
    expect(scan.stats.assets).toBe(scan.assets.length);
    expect(scan.stats.durationMs).toBeGreaterThan(0);
    expect(scan.diagnostics?.collector).toBe("isolated");
    expect(new Date(scan.scannedAt).toISOString()).toBe(scan.scannedAt);
    expect(steps).toContain("collect");
  });

  it("returns the fixture site logo, the fonts and a palette", () => {
    for (const asset of scan.assets) Asset.parse(asset);
    const logo = scan.assets.filter((asset) => asset.role === "site-logo");
    expect(logo).toHaveLength(1);
    expect(logo[0]).toMatchObject({ kind: "svg" });
    expect(logo[0].inline && "text" in logo[0].inline && logo[0].inline.text.startsWith("<svg")).toBe(true);

    for (const family of scan.fonts) FontFamily.parse(family);
    expect(scan.fonts.map((family) => family.name)).toContain("Inter");
    expect(scan.palette?.brand.length).toBeGreaterThan(0);
  });

  it("gives a scan id the cache accepts", async () => {
    expect(scan.scanId).toMatch(/^127\.0\.0\.1-[0-9a-z]+-[0-9a-f]{6}$/);
    const file = await saveScan(scan);
    expect(file.startsWith(cache)).toBe(true);
    expect(await loadScan(scan.scanId)).toEqual(scan);
  });

  it("summarizes the scan into a few hundred bytes", () => {
    const summary = summarize(scan);
    expect(summary.scanId).toBe(scan.scanId);
    expect(summary.counts.assets).toBe(scan.stats.assets);
    expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThan(4_096);
  });

  it("fetches the bytes of an asset and of a font file", async () => {
    const source = createScanSource();
    const svg = scan.assets.find((asset) => asset.kind === "svg" && asset.display?.url.endsWith(".svg"));
    if (!svg?.display) throw new Error("expected an SVG asset with a URL");
    const markup = (await source.fetchBytes(svg.display)).toString("utf8");
    expect(markup).toMatch(/<svg/);

    const inter = scan.fonts.find((family) => family.name === "Inter");
    const file = inter?.faces.flatMap((face) => face.files).find((candidate) => candidate.format === "woff2" && candidate.url !== "");
    if (!file) throw new Error("expected a WOFF2 file for Inter");
    const bytes = await source.fetchBytes(file);
    expect(bytes.subarray(0, 4).toString("latin1")).toBe("wOF2");
    expect(bytes.length).toBe(file.bytes);
  });

  it("rejects an unreachable URL with the engine's failure", async () => {
    const failure = await createScanSource()
      .scan("https://assets-scraper-nothing-here.invalid/")
      .then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(ScanFailure);
    expect((failure as ScanFailure).code).toMatch(/^(?:dns|connect|timeout)$/);
  });
});
