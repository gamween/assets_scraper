import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadScan, saveScan } from "@/agent/cache";
import { createScanSource } from "@/agent/source";
import { summarize } from "@/agent/summary";
import type { AgentScan } from "@/agent/types";
import { Asset, FontFamily } from "@/lib/contract";
import { TEST_SVG as TEST_SVG_TEXT } from "@/agent/testing";
import { ScanFailure } from "@/server/errors";
import type { FixtureServer } from "../../fixtures/serve";
import { brandKitRoutes, FIXTURE_KIT, serveAssetsFixture } from "../assets/harness";

/**
 * The agent core against the fixture site with the real engine (plan Task G1.5): one local scan folded into an
 * `AgentScan`, cached, summarized, and its bytes fetched back.
 */

let server: FixtureServer;
let scan: AgentScan;
let steps: string[];
let cache: string;
let previousCache: string | undefined;
let browserOnlyReferer: string | undefined;

beforeAll(async () => {
  previousCache = process.env.XDG_CACHE_HOME;
  cache = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-local-")));
  process.env.XDG_CACHE_HOME = cache;
  server = await serveAssetsFixture({
    ...brandKitRoutes(),
    // bybit.com's edge: the favicon.ico it serves Chrome is a 403 for any other user agent, this tool's own included.
    "/browser-only/favicon.ico": (req, res) => {
      if (!/ Chrome\/\d/.test(req.headers["user-agent"] ?? "")) {
        res.writeHead(403, { "content-type": "text/html" });
        res.end("<!doctype html><title>Access denied</title>");
        return;
      }
      browserOnlyReferer = req.headers.referer;
      res.writeHead(200, { "content-type": "image/x-icon" });
      res.end(fs.readFileSync(path.join(import.meta.dirname, "../../fixtures/site/assets/favicon.ico")));
    },
  });
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
    // The footer links its press kit and another site's brand page: only the site's own is a place to look next.
    expect(summary.brandLinks).toEqual([{ href: `${server.origin}/press`, text: "Press kit" }]);
    expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThan(4_096);
  });

  it("reports the text beside the header logo as the wordmark, tied to the logo row, through the cache too", async () => {
    const logo = scan.assets.find((asset) => asset.role === "site-logo")!;
    expect(scan.page.wordmark).toEqual({
      text: "Fixture", family: "Inter", weight: 700, size: 16, letterSpacing: 1.28, transform: "uppercase",
      runs: [{ text: "Fixture", hex: "#141e28" }],
      withLogo: { id: logo.id, width: 120, height: 32 },
    });
    const summary = summarize(scan);
    expect(summary.wordmark).toEqual(scan.page.wordmark);
    expect(summary.logos.map((row) => row.id)).toContain(summary.wordmark?.withLogo?.id);
    await saveScan(scan);
    expect((await loadScan(scan.scanId))?.page.wordmark).toEqual(scan.page.wordmark);
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

  it("fetches a file the way the scan's browser did, for an edge that refuses anything else", async () => {
    const favicon = { url: `${server.origin}/browser-only/favicon.ico`, proxy: "", format: "ico" as const };
    const bytes = await createScanSource().fetchBytes(favicon, { referer: scan.page.finalUrl });
    expect(bytes.equals(fs.readFileSync(path.join(import.meta.dirname, "../../fixtures/site/assets/favicon.ico")))).toBe(true);
    expect(browserOnlyReferer).toBe(`${server.origin}/`);
  });

  it("reports a brand page's kit: its linked files and the one its code downloads, named and sized, with its portals", async () => {
    const kit = await createScanSource().scan(`${server.origin}/brand-kit.html`);
    const cdn = "https://cdn.fixture.test/files";
    expect(kit.page.brandFiles?.map(({ url, name, type, foundIn, bytes }) => ({ url, name, type, foundIn, bytes }))).toEqual([
      // A button that names only formats: the file name says which variant it is. This host answers whole.
      { url: `${server.origin}/brandkit/downloads/Fixture_Logo_FullColor.zip`, name: "Fixture Logo FullColor", type: "zip", foundIn: "link", bytes: FIXTURE_KIT.length },
      // This one honours the probe's range.
      { url: `${server.origin}/brandkit/downloads/Fixture_Logo_all.zip`, name: "Download all Fixture logo variations", type: "zip", foundIn: "link", bytes: FIXTURE_KIT.length },
      // A host that does not answer leaves a file without a size, never out of the list.
      { url: `${cdn}/9ef5ab890833c2571489b41a23a0ffc29307300c.zip`, name: "Fixture logo pack", type: "zip", foundIn: "link", bytes: undefined },
      { url: `${cdn}/c155385509c73b245ff4f752ade94048a06245bc.pdf`, name: "Discover the brand guide", type: "pdf", foundIn: "link", bytes: undefined },
      // The logo the page shows and links is an asset, not a brand file. The one it only links is.
      { url: `${server.origin}/brandkit/fixture-wordmark.svg`, name: "Wordmark", type: "svg", foundIn: "link", bytes: Buffer.byteLength(TEST_SVG_TEXT) },
      // monad.xyz's case: the kit and a logo only the page's script names, and not the social icon beside them.
      { url: `${server.origin}/brand-page-assets/Fixture%20Brand%20and%20Media%20Kit.zip`, name: "Fixture Brand and Media Kit", type: "zip", foundIn: "script", bytes: FIXTURE_KIT.length },
      { url: `${server.origin}/brand-page-assets/Logomark.svg`, name: "Logomark", type: "svg", foundIn: "script", bytes: Buffer.byteLength(TEST_SVG_TEXT) },
    ]);

    const summary = summarize(kit);
    expect(summary.brandFiles.map((file) => file.type)).toEqual(["zip", "zip", "zip", "zip", "pdf", "svg", "svg"]);
    expect(summary.brandLinks.map((link) => link.text)).toEqual(["Brand Kit", "Go to Visualbook", "Download the Media Kit", "Press"]);
    await saveScan(kit);
    expect((await loadScan(kit.scanId))?.page.brandFiles).toEqual(kit.page.brandFiles);
  });

  it("rejects an unreachable URL with the engine's failure", async () => {
    const failure = await createScanSource()
      .scan("https://assets-scraper-nothing-here.invalid/")
      .then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(ScanFailure);
    expect((failure as ScanFailure).code).toMatch(/^(?:dns|connect|timeout)$/);
  });
});
