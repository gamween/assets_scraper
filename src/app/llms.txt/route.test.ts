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

  it("states the limits that decide what a request gets back", async () => {
    process.env.SCANS_PER_DAY = "80";
    process.env.AGENT_MAX_FILES = "60";
    process.env.AGENT_MIN_LONG_SIDE = "600";
    const text = await textOf();
    expect(text).toContain("80 scans");
    expect(text).toContain("60 files");
    expect(text).toContain("600 px");
    expect(text).toContain("90 s");
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
    expect(text).not.toMatch(/[–—]/);
    expect(text).not.toMatch(/!/);
    expect(text).not.toMatch(/[\u{1f300}-\u{1faff}\u{2600}-\u{27bf}]/u);
  });

  it("never prints a token", async () => {
    process.env.AGENT_TOKENS = "agent-token-one-with-enough-characters";
    expect(await textOf()).not.toContain("agent-token-one-with-enough-characters");
  });
});
