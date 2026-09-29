import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testAsset, testScan } from "@/agent/testing";
import type { AssetSource } from "@/lib/contract";
import { ApiError } from "@/lib/contract";
import { readZip, type ZipEntry } from "../../../../../e2e/support/zip";

vi.mock("botid/server", () => ({ checkBotId: vi.fn(async () => ({ isBot: true })) }));

const { MemoryBudgetStore, setBudgetStoreForTests } = await import("@/server/security/budget");
const { setAgentScanSourceForTests } = await import("../source");
const { DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT, maxDuration, runtime } = await import("./route");

const TOKEN = "agent-token-one-with-enough-characters";
const DUPLICATE = Buffer.from("the same bytes twice over");

/** A page with one of every case the selection rules exist for. */
const assets = [
  testAsset({ id: "site-logo", kind: "svg", format: "svg", role: "site-logo", name: "Fixture Co", filename: "site-logo.svg", score: 100, display: null, inline: { mime: "image/svg+xml", text: "<svg xmlns='http://www.w3.org/2000/svg'/>" } }),
  testAsset({ id: "logo-svg", kind: "svg", format: "svg", role: "logo", filename: "logo.svg", score: 90 }),
  testAsset({ id: "logo-png", format: "png", role: "logo", filename: "logo@2x.png", width: 800, height: 200, score: 89 }),
  testAsset({ id: "hero", format: "png", role: "image", filename: "hero.png", width: 1600, height: 900, score: 80 }),
  testAsset({ id: "thumb", format: "png", role: "image", filename: "thumb.png", width: 320, height: 200, score: 70 }),
  testAsset({ id: "copy-a", format: "png", role: "illustration", filename: "copy-a.png", width: 1200, height: 800, score: 60 }),
  testAsset({ id: "copy-b", format: "png", role: "illustration", filename: "copy-b.png", width: 900, height: 600, score: 59 }),
  testAsset({ id: "menu", format: "svg", kind: "svg", role: "icon", filename: "menu.svg", score: 40 }),
  testAsset({ id: "broken", format: "png", role: "image", filename: "broken.png", width: 1200, height: 900, score: 30 }),
];

const bytesFor = (id: string): Buffer =>
  id === "copy-a" || id === "copy-b" ? DUPLICATE : Buffer.alloc(1024, id.charCodeAt(0));

const scan = vi.fn();
const fetchBytes = vi.fn(async (target: AssetSource) => {
  const id = /\/([^/]+)\.[a-z0-9]+$/.exec(target.url)?.[1] ?? "";
  if (id === "broken") throw new Error("HTTP 404 for the asset");
  return bytesFor(id);
});

const request = (query = "") =>
  new Request(`https://assets.example.com/api/v1/assets.zip?url=stripe.com${query}`, { headers: { authorization: `Bearer ${TOKEN}` } });

const entriesOf = async (response: Response): Promise<ZipEntry[]> => readZip(await response.arrayBuffer());
const manifestOf = (entries: ZipEntry[]) => JSON.parse(new TextDecoder().decode(entries.find((entry) => entry.name === "manifest.json")!.data));
const pathsOf = (entries: ZipEntry[]) => entries.map((entry) => entry.name).filter((name) => name !== "manifest.json");

let env: typeof process.env;

beforeEach(() => {
  env = { ...process.env };
  process.env.AGENT_TOKENS = TOKEN;
  scan.mockReset();
  scan.mockResolvedValue(testScan({ assets, stats: { assets: assets.length, svg: 3, images: 6, fonts: 0, hidden: {}, durationMs: 100 } }));
  fetchBytes.mockClear();
  setBudgetStoreForTests(new MemoryBudgetStore());
  setAgentScanSourceForTests({ kind: "local", scan, fetchBytes });
});

afterEach(() => {
  process.env = env;
  setBudgetStoreForTests(null);
  setAgentScanSourceForTests(null);
});

describe("GET /api/v1/assets.zip", () => {
  it("runs on Node with room for the 90 s scan deadline", () => {
    expect(runtime).toBe("nodejs");
    expect(maxDuration).toBe(120);
  });

  it("streams a ZIP of the deck selection with a manifest", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="stripe.com-assets.zip"');
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-assets-truncated")).toBe("false");
    const entries = await entriesOf(response);
    expect(pathsOf(entries).sort()).toEqual(["images/copy-a.png", "images/hero.png", "svg/logo.svg", "svg/site-logo.svg"]);
    expect(Number(response.headers.get("x-assets-count"))).toBe(4);

    const manifest = manifestOf(entries);
    expect(manifest.tool).toBe("assets-scraper");
    expect(manifest.scanId).toBe("scan-1");
    expect(manifest.page.host).toBe("stripe.com");
    expect(manifest.files).toHaveLength(4);
    // The row shape `src/agent/download.ts` writes: `file` and `keptBecause`, not `path` and a `keptFor` enum, because
    // llms.txt tells an agent to unzip this into the same folder a local download writes (review issue 18).
    expect(manifest.manifestVersion).toBe(1);
    expect(manifest.profile).toBe("deck");
    expect(new Date(manifest.downloadedAt).toISOString()).toBe(manifest.downloadedAt);
    expect(manifest.files.find((file: { id: string }) => file.id === "hero")).toMatchObject({
      file: "images/hero.png",
      url: "https://cdn.example.com/hero.png",
      width: 1600,
      height: 900,
      bytes: 1024,
      role: "image",
      keptBecause: "deck profile (role image)",
    });
    expect(manifest.files.find((file: { id: string }) => file.id === "site-logo")).toMatchObject({ keptBecause: "deck profile (role site-logo)", url: "" });
    expect(manifest.files.find((file: { id: string }) => file.id === "copy-a")).toMatchObject({ duplicatesDropped: ["copy-b"] });
    expect(manifest.dropped).toMatchObject({ icon: 1, small: 1, "vector-preferred": 1 });
    expect(manifest.dropped.duplicate ?? 0).toBe(1);
    expect(manifest.duplicates).toEqual([{ keptId: "copy-a", droppedIds: ["copy-b"] }]);
    expect(manifest.failed).toEqual([{ id: "broken", name: "broken", reason: "HTTP 404 for the asset" }]);
    expect(manifest.truncated).toBe(false);
    expect(manifest.note).toBeUndefined();
    expect(manifest.totalBytes).toBe(manifest.files.reduce((total: number, file: { bytes: number }) => total + file.bytes, 0));
  });

  it("says so in the header and the manifest when the archive is only the front of the selection", async () => {
    // AGENT_ZIP_MAX_BYTES stands in for a near-exhausted daily budget: both end the archive the same way (plan G4.3).
    // One fetch at a time, because `total` is read between awaits: with several in flight the cap can be passed by up to
    // `concurrency` files, which is what zip.ts documents and what this test would otherwise measure instead.
    vi.stubEnv("AGENT_ZIP_MAX_BYTES", "1500");
    vi.stubEnv("AGENT_DOWNLOAD_CONCURRENCY", "1");

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(response.headers.get("x-assets-truncated")).toBe("true");
    const manifest = manifestOf(await entriesOf(response));
    expect(manifest.truncated).toBe(true);
    expect(manifest.note).toMatch(/front of the selection/);
    expect(manifest.files.map((file: { id: string }) => file.id)).toEqual(["site-logo", "logo-svg"]);
    expect(manifest.totalBytes).toBeLessThanOrEqual(1_500);
    expect(manifest.dropped.unavailable).toBe(4);
    expect(Number(response.headers.get("x-assets-count"))).toBe(2);
    vi.unstubAllEnvs();
  });

  it("writes the inline markup of an asset the scan already holds, without a request", async () => {
    const entries = await entriesOf(await GET(request()));
    const svg = entries.find((entry) => entry.name === "svg/site-logo.svg")!;
    expect(new TextDecoder().decode(svg.data)).toMatch(/^<svg/);
    expect(fetchBytes.mock.calls.map(([target]) => target.url)).not.toContain("https://cdn.example.com/site-logo.svg");
  });

  it("applies profile, kinds, roles and max", async () => {
    expect(pathsOf(await entriesOf(await GET(request("&profile=all&kinds=image")))).sort()).toEqual([
      "images/copy-a.png",
      "images/hero.png",
      "images/logo@2x.png",
      "images/thumb.png",
    ]);
    expect(pathsOf(await entriesOf(await GET(request("&kinds=svg"))))).toEqual(["svg/site-logo.svg", "svg/logo.svg"]);
    expect(pathsOf(await entriesOf(await GET(request("&roles=logo"))))).toEqual(["svg/logo.svg"]);
    expect(pathsOf(await entriesOf(await GET(request("&max=1"))))).toEqual(["svg/site-logo.svg"]);
    const capped = manifestOf(await entriesOf(await GET(request("&max=1"))));
    expect(capped.dropped.cap).toBeGreaterThan(0);
  });

  it("fetches no more than the download concurrency at a time", async () => {
    process.env.AGENT_DOWNLOAD_CONCURRENCY = "2";
    let inFlight = 0;
    let peak = 0;
    fetchBytes.mockImplementation(async (target: AssetSource) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return bytesFor(/\/([^/]+)\./.exec(target.url)?.[1] ?? "");
    });
    await GET(request("&profile=all"));
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(1);
  });

  it("stops cleanly when the request cap runs out, with a note in the manifest", async () => {
    process.env.AGENT_ZIP_MAX_BYTES = "2048";
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("x-assets-truncated")).toBe("true");
    const entries = await entriesOf(response);
    const manifest = manifestOf(entries);
    expect(response.headers.get("x-assets-truncated")).toBe("true");
    expect(manifest.truncated).toBe(true);
    expect(manifest.note).toMatch(/front of the selection/);
    expect(manifest.note).not.toMatch(/[\u2013\u2014]/);
    expect(manifest.files.length).toBeGreaterThan(0);
    expect(manifest.files.length).toBeLessThan(4);
    expect(pathsOf(entries)).toHaveLength(manifest.files.length);
  });

  /**
   * The archive and a local download name one asset one way, which is what makes unzipping it into a project the same
   * operation as `assets-scraper get` (plan Task G6.2). The rule lives in `safeFileName`, so a name that tries to climb
   * out of the folder loses its path here exactly as it does on disk.
   */
  it("names files the way a local download does", async () => {
    const { safeFileName } = await import("@/agent/download");
    scan.mockResolvedValue(
      testScan({
        assets: [
          testAsset({
            id: "evil",
            kind: "svg",
            format: "svg",
            role: "logo",
            filename: "../../evil.svg",
            score: 100,
            display: null,
            inline: { mime: "image/svg+xml", text: "<svg xmlns='http://www.w3.org/2000/svg'/>" },
          }),
        ],
      }),
    );

    const paths = pathsOf(await entriesOf(await GET(request())));

    expect(paths).toEqual([`svg/${safeFileName("../../evil.svg", "evil.svg")}`]);
    expect(paths).toEqual(["svg/evil.svg"]);
  });

  it("counts the bytes it serves against the daily proxy budget", async () => {
    process.env.PROXY_BYTES_PER_DAY = "1500";
    const manifest = manifestOf(await entriesOf(await GET(request())));
    expect(manifest.truncated).toBe(true);
    expect(manifest.totalBytes).toBeLessThanOrEqual(1500);
    expect(manifest.dropped.unavailable).toBeGreaterThan(0);
  });

  it("refuses a request without a bearer token, before it scans anything", async () => {
    const response = await GET(new Request("https://assets.example.com/api/v1/assets.zip?url=stripe.com"));
    expect(response.status).toBe(401);
    expect(ApiError.parse(await response.json()).error.code).toBe("access-code");
    expect(scan).not.toHaveBeenCalled();
  });

  it("refuses an unknown filter value and a missing URL", async () => {
    // An empty kinds or roles would select nothing: it is refused before the scan, so it spends no unit of the budget.
    for (const query of ["&profile=everything", "&kinds=pdf", "&roles=mascot", "&max=0", "&kinds=", "&roles="]) {
      const response = await GET(request(query));
      expect(response.status).toBe(400);
      expect(ApiError.parse(await response.json()).error.code).toBe("invalid-url");
    }
    const missing = await GET(new Request("https://assets.example.com/api/v1/assets.zip", { headers: { authorization: `Bearer ${TOKEN}` } }));
    expect(missing.status).toBe(400);
    expect(scan).not.toHaveBeenCalled();
  });

  it("maps a scan failure to the v1 code and status", async () => {
    const { ScanFailure } = await import("@/server/errors");
    scan.mockRejectedValueOnce(new ScanFailure("timeout", "The scan timed out"));
    const response = await GET(request());
    expect(response.status).toBe(504);
    expect(ApiError.parse(await response.json()).error.code).toBe("timeout");
  });

  it("answers every other method with 405 and allow: GET", async () => {
    for (const handler of [HEAD, POST, PUT, PATCH, DELETE, OPTIONS]) {
      const response = await handler();
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET");
    }
  });
});
