import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET } from "@/app/api/v1/assets.zip/route";
import { ApiError } from "@/lib/contract";
import { readZip, type ZipEntry } from "../../../e2e/support/zip";
import type { FixtureServer } from "../../fixtures/serve";
import { serveAssetsFixture } from "../assets/harness";

/**
 * `GET /api/v1/assets.zip` end to end (plan Task G4.3): the real engine against the fixture site, the real asset
 * fetches through `safeFetch`, and the archive read back from the streamed response.
 */

const TOKEN = "integration-agent-token-long-enough";

let server: FixtureServer;
let env: typeof process.env;

const zipRequest = (query = "", headers: Record<string, string> = {}): Request =>
  new Request(`https://assets.example.com/api/v1/assets.zip?url=${encodeURIComponent(`${server.origin}/`)}${query}`, {
    headers: { authorization: `Bearer ${TOKEN}`, ...headers },
  });

const entriesOf = async (response: Response): Promise<ZipEntry[]> => readZip(await response.arrayBuffer());
const manifestOf = (entries: ZipEntry[]) => JSON.parse(new TextDecoder().decode(entries.find((entry) => entry.name === "manifest.json")!.data));

beforeAll(async () => {
  env = { ...process.env };
  server = await serveAssetsFixture();
  process.env.AGENT_TOKENS = TOKEN;
}, 60_000);

afterAll(async () => {
  await server?.close();
  process.env = env;
});

describe("GET /api/v1/assets.zip", () => {
  it("streams the deck selection of the fixture site with its manifest", async () => {
    const response = await GET(zipRequest());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="127.0.0.1-assets.zip"');

    const entries = await entriesOf(response);
    const manifest = manifestOf(entries);
    const paths = entries.map((entry) => entry.name).filter((name) => name !== "manifest.json");
    expect(paths.length).toBeGreaterThan(0);
    expect(paths).toEqual(manifest.files.map((file: { path: string }) => file.path));
    expect(Number(response.headers.get("x-assets-count"))).toBe(manifest.files.length);
    expect(response.headers.get("x-scan-id")).toBe(manifest.scanId);
    expect(manifest.page.host).toBe("127.0.0.1");
    expect(manifest.truncated).toBe(false);

    // Nothing writes outside the two folders, whatever a page named its files.
    for (const path of paths) expect(path).toMatch(/^(?:svg|images)\/[^/]+$/);
    for (const file of manifest.files) {
      expect(file.bytes).toBeGreaterThan(0);
      expect(file.keptFor).toMatch(/^(?:vector|logo|large|named)$/);
    }
    const svg = entries.find((entry) => entry.name.startsWith("svg/"));
    expect(new TextDecoder().decode(svg!.data)).toMatch(/<svg/);
    const bytes = entries.filter((entry) => entry.name !== "manifest.json").reduce((total, entry) => total + entry.data.byteLength, 0);
    expect(bytes).toBe(manifest.totalBytes);
  }, 150_000);

  it("keeps only the SVG files when asked for them", async () => {
    const entries = await entriesOf(await GET(zipRequest("&kinds=svg&max=3")));
    const paths = entries.map((entry) => entry.name).filter((name) => name !== "manifest.json");
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.length).toBeLessThanOrEqual(3);
    for (const path of paths) expect(path.startsWith("svg/")).toBe(true);
  }, 150_000);

  it("refuses a request without a bearer token, before it scans anything", async () => {
    const response = await GET(zipRequest("", { authorization: "" }));
    expect(response.status).toBe(401);
    expect(ApiError.parse(await response.json()).error.code).toBe("access-code");
  });
});
