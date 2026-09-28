import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST } from "@/app/api/v1/scan/route";
import { ApiError, Asset, FontFamily, Palette, ScanStats } from "@/lib/contract";
import type { FixtureServer } from "../../fixtures/serve";
import { serveAssetsFixture } from "../assets/harness";

/**
 * `POST /api/v1/scan` end to end (plan Task G4.2): the real engine against the fixture site, through the route handler
 * with its own gate, as an agent holding a bearer token calls it.
 */

const TOKEN = "integration-agent-token-long-enough";

let server: FixtureServer;
let env: typeof process.env;

const scanRequest = (body: unknown, headers: Record<string, string> = {}): Request =>
  new Request("https://assets.example.com/api/v1/scan", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  env = { ...process.env };
  server = await serveAssetsFixture();
  process.env.AGENT_TOKENS = TOKEN;
}, 60_000);

afterAll(async () => {
  await server?.close();
  process.env = env;
});

describe("POST /api/v1/scan", () => {
  it("answers the summary view with one JSON document", async () => {
    const response = await POST(scanRequest({ url: `${server.origin}/` }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body.view).toBe("summary");
    expect(body.summary.page).toMatchObject({ finalUrl: `${server.origin}/`, host: "127.0.0.1", title: "Fixture Co" });
    expect(body.summary.counts.assets).toBeGreaterThan(0);
    expect(body.summary.logos.some((logo: { name: string }) => logo.name.length > 0)).toBe(true);
    expect(body.summary.fonts.map((font: { family: string }) => font.family)).toContain("Inter");
    expect(body.summary.palette.length).toBeGreaterThan(0);
    expect(body.scan).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThan(4_500);
  }, 150_000);

  it("answers the full view with every asset and font, in the v1 contract shapes", async () => {
    const response = await POST(scanRequest({ url: `${server.origin}/`, view: "full" }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.view).toBe("full");
    expect(body.scanId).toBe(body.summary.scanId);
    for (const asset of body.scan.assets) Asset.parse(asset);
    for (const family of body.scan.fonts) FontFamily.parse(family);
    Palette.parse(body.scan.palette);
    ScanStats.parse(body.scan.stats);
    expect(body.scan.assets.filter((asset: { role: string }) => asset.role === "site-logo")).toHaveLength(1);
    expect(body.scan.assets).toHaveLength(body.summary.counts.assets);
    expect(new Date(body.scan.scannedAt).toISOString()).toBe(body.scan.scannedAt);
  }, 150_000);

  it("refuses a request without a bearer token, before it scans anything", async () => {
    const response = await POST(scanRequest({ url: `${server.origin}/` }, { authorization: "" }));
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(ApiError.parse(await response.json()).error.code).toBe("access-code");
  });

  it("refuses a private address that is not the allowlisted test origin", async () => {
    const response = await POST(scanRequest({ url: "http://127.0.0.1/" }));
    expect(response.status).toBe(422);
    expect(ApiError.parse(await response.json()).error.code).toBe("blocked-address");
  });

  it("maps an unreachable host to a 502 with the engine's own code", async () => {
    const response = await POST(scanRequest({ url: "https://assets-scraper-nothing-here.invalid/" }));
    expect(response.status).toBe(502);
    expect(ApiError.parse(await response.json()).error.code).toMatch(/^(?:dns|connect|timeout)$/);
  }, 60_000);
});
