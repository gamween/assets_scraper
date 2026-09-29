import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET } from "./route";

const request = (origin = "https://assets-scraper.vercel.app") => new Request(`${origin}/llms.txt`);

let env: typeof process.env;

beforeEach(() => {
  env = { ...process.env };
});

afterEach(() => {
  process.env = env;
});

const textOf = async (origin?: string): Promise<string> => (await GET(request(origin))).text();

describe("GET /llms.txt", () => {
  it("is plain text an agent can read, and may be cached", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("cache-control")).toMatch(/max-age/);
  });

  it("describes both endpoints and the bearer auth", async () => {
    const text = await textOf();
    expect(text).toContain("POST /api/v1/scan");
    expect(text).toContain("GET /api/v1/assets.zip");
    expect(text).toContain("Authorization: Bearer");
    expect(text).toContain("AGENT_TOKENS");
    expect(text).toContain("401");
  });

  it("states the limits that decide what a request gets back, as this deployment configures them", async () => {
    // None of these is a default, so a page that printed fixed numbers instead of reading the limits would fail.
    process.env.SCANS_PER_DAY = "37";
    process.env.SCANS_PER_IP_PER_DAY = "9";
    process.env.SCAN_DEADLINE_MS = "73000";
    process.env.AGENT_MAX_FILES = "41";
    process.env.AGENT_MIN_LONG_SIDE = "777";
    process.env.AGENT_ZIP_DEADLINE_MS = "61000";
    process.env.PROXY_BYTES_PER_IP_PER_DAY = String(44 * 1024 * 1024);
    const text = await textOf();
    expect(text).toContain("37 scans a day for this deployment, 9 a day per client address");
    expect(text).toContain("73 s for one scan");
    expect(text).toContain("41 files");
    expect(text).toContain("777 px");
    expect(text).toContain("built within 61 s");
    expect(text).toContain("44 MB of them per client address");
  });

  it("says what the edge answers before the API runs, and which paths its rate limit covers", async () => {
    const text = await textOf();
    expect(text).toContain("20 requests per 10 minutes per client address");
    expect(text).toContain("x-vercel-mitigated: deny");
    expect(text).toContain("x-vercel-mitigated: challenge");
  });

  it("stops its archive example on a refusal instead of unzipping the error", async () => {
    const zip = (await textOf()).split("\n").find((line) => line.includes("/api/v1/assets.zip?"));
    expect(zip).toMatch(/curl -sS --fail-with-body /);
    expect(zip).toMatch(/&& mkdir -p scrap\/stripe\.com && unzip/);
  });

  it("carries two examples runnable against the host that served it", async () => {
    const text = await textOf("https://assets.example.com");
    const examples = text.split("\n").filter((line) => line.trim().startsWith("curl"));
    expect(examples.length).toBeGreaterThanOrEqual(2);
    expect(text).toContain("https://assets.example.com/api/v1/scan");
    expect(text).toContain("https://assets.example.com/api/v1/assets.zip");
    expect(text).not.toContain("assets-scraper.vercel.app");
  });

  it("keeps the copy rules: no em dash, no en dash, no emoji, no exclamation mark", async () => {
    const text = await textOf();
    expect(text).not.toMatch(/[\u2013\u2014]/);
    expect(text).not.toMatch(/!/);
    expect(text).not.toMatch(/[\u{1f300}-\u{1faff}\u{2600}-\u{27bf}]/u);
  });

  it("never prints a token", async () => {
    process.env.AGENT_TOKENS = "agent-token-one-with-enough-characters";
    expect(await textOf()).not.toContain("agent-token-one-with-enough-characters");
  });
});
