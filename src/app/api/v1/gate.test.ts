import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/contract";

vi.mock("botid/server", () => ({ checkBotId: vi.fn(async () => ({ isBot: true })) }));
const ipAddress = vi.fn(() => undefined as string | undefined);
vi.mock("@vercel/functions", () => ({ ipAddress }));

const { MemoryBudgetStore, setBudgetStoreForTests } = await import("@/server/security/budget");
const { authorizeAgent, gateAgentTarget, parseSelectionParams, readAgentJson } = await import("./gate");
const { MAX_BODY_BYTES } = await import("@/server/security/request");

const TOKEN = "agent-token-one-with-enough-characters";
const ORIGIN = "https://assets.example.com";

const post = (body: unknown, headers: Record<string, string> = {}): Request =>
  new Request(`${ORIGIN}/api/v1/scan`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

let env: typeof process.env;

beforeEach(() => {
  env = { ...process.env };
  process.env.AGENT_TOKENS = TOKEN;
  delete process.env.SCAN_DISABLED;
  delete process.env.ACCESS_CODE;
  setBudgetStoreForTests(new MemoryBudgetStore());
});

afterEach(() => {
  process.env = env;
  setBudgetStoreForTests(null);
  ipAddress.mockReset();
  ipAddress.mockReturnValue(undefined);
});

async function expectFailure(response: Response, status: number, code: string): Promise<void> {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = ApiError.parse(await response.json());
  expect(body.error.code).toBe(code);
  expect(body.error.message).not.toMatch(/[\u2013\u2014]/);
}

describe("authorizeAgent", () => {
  it("accepts a configured bearer token without asking BotID, which is what keeps curl out of /api/scan", () => {
    expect(authorizeAgent(post({ url: "linear.app" }))).toEqual({ ok: true, tokenIndex: 0 });
  });

  it("refuses a request with no token", async () => {
    const result = authorizeAgent(post({ url: "linear.app" }, { authorization: "" }));
    expect(result.ok).toBe(false);
    if (!result.ok) await expectFailure(result.response, 401, "access-code");
  });

  it("refuses when scanning is paused", async () => {
    process.env.SCAN_DISABLED = "1";
    const result = authorizeAgent(post({ url: "linear.app" }));
    expect(result.ok).toBe(false);
    if (!result.ok) await expectFailure(result.response, 503, "disabled");
  });

  it("still asks for the access code when the app is behind one", async () => {
    process.env.ACCESS_CODE = "open-sesame";
    const refused = authorizeAgent(post({ url: "linear.app" }));
    expect(refused.ok).toBe(false);
    if (!refused.ok) await expectFailure(refused.response, 401, "access-code");
    expect(authorizeAgent(post({ url: "linear.app" }, { "x-access-code": "open-sesame" })).ok).toBe(true);
  });
});

describe("readAgentJson", () => {
  it("parses a JSON body", async () => {
    expect(await readAgentJson(post({ url: "linear.app" }))).toEqual({ url: "linear.app" });
  });

  it("refuses anything but application/json", async () => {
    expect(await readAgentJson(post({ url: "linear.app" }, { "content-type": "text/plain" }))).toBeNull();
    expect(await readAgentJson(post({ url: "linear.app" }, { "content-type": "application/json; charset=utf-8" }))).toEqual({ url: "linear.app" });
  });

  it("refuses a body that is not JSON", async () => {
    expect(await readAgentJson(post("{"))).toBeNull();
  });

  it("refuses a body past the cap, whatever content-length claims", async () => {
    const long = JSON.stringify({ url: "x".repeat(MAX_BODY_BYTES) });
    expect(await readAgentJson(post(long, { "content-length": "20" }))).toBeNull();
  });
});

describe("gateAgentTarget", () => {
  it("normalizes the URL and takes a unit of the daily budget", async () => {
    const result = await gateAgentTarget("linear.app", post({ url: "linear.app" }));
    expect(result).toMatchObject({ ok: true, url: "https://linear.app/", host: "linear.app", client: null });
  });

  it("keys the per-address quota on the caller's address like the browser gate does", async () => {
    process.env.VERCEL = "1";
    ipAddress.mockReturnValue("203.0.113.7");
    const result = await gateAgentTarget("linear.app", post({ url: "linear.app" }));
    expect(result).toMatchObject({ ok: true, client: "203.0.113.7" });
  });

  it("keys nothing on an address off Vercel, where the client writes x-real-ip itself", async () => {
    delete process.env.VERCEL;
    ipAddress.mockReturnValue("203.0.113.7");
    const result = await gateAgentTarget("linear.app", post({ url: "linear.app" }));
    expect(result).toMatchObject({ ok: true, client: null });
  });

  it("refuses a missing or unusable URL", async () => {
    for (const input of [null, "", "not a url at all", "ftp://linear.app/"]) {
      const result = await gateAgentTarget(input, post({}));
      expect(result.ok).toBe(false);
      if (!result.ok) await expectFailure(result.response, 400, "invalid-url");
    }
  });

  it("refuses a port the scanner does not support", async () => {
    const result = await gateAgentTarget("https://linear.app:8443/", post({}));
    expect(result.ok).toBe(false);
    if (!result.ok) await expectFailure(result.response, 422, "unsupported-port");
  });

  it("refuses its own host and a private address", async () => {
    process.env.APP_HOSTS = "assets.example.com";
    const own = await gateAgentTarget("assets.example.com", post({}));
    expect(own.ok).toBe(false);
    if (!own.ok) await expectFailure(own.response, 422, "own-host");

    for (const input of ["http://127.0.0.1/", "http://localhost/", "http://[::1]/"]) {
      const blocked = await gateAgentTarget(input, post({}));
      expect(blocked.ok).toBe(false);
      if (!blocked.ok) await expectFailure(blocked.response, 422, "blocked-address");
    }
  });

  it("reaches an allowlisted test origin on its own port, as the browser gate does", async () => {
    process.env.SCAN_TEST_ALLOW_HOSTS = "127.0.0.1:4321";
    const result = await gateAgentTarget("http://127.0.0.1:4321/", post({}));
    expect(result).toMatchObject({ ok: true, url: "http://127.0.0.1:4321/", host: "127.0.0.1" });
  });

  it("refuses once the daily budget is spent, and does not spend one on a URL it refused", async () => {
    process.env.SCANS_PER_DAY = "1";
    expect((await gateAgentTarget("linear.app", post({}))).ok).toBe(true);
    const spent = await gateAgentTarget("linear.app", post({}));
    expect(spent.ok).toBe(false);
    if (!spent.ok) await expectFailure(spent.response, 429, "budget");
  });
});

describe("parseSelectionParams", () => {
  const params = (query: string) => new URL(`${ORIGIN}/api/v1/assets.zip?${query}`).searchParams;

  it("defaults to the deck profile with no explicit filter", () => {
    expect(parseSelectionParams(params("url=linear.app"))).toEqual({ ok: true, options: { profile: "deck" } });
  });

  it("reads the profile, kinds, roles, max, minLongSide and nameContains", () => {
    const result = parseSelectionParams(params("profile=all&kinds=svg,image&roles=logo,+site-logo&max=3&minLongSide=200&nameContains=Hero"));
    expect(result).toEqual({
      ok: true,
      options: { profile: "all", kinds: ["svg", "image"], roles: ["logo", "site-logo"], max: 3, minLongSide: 200, nameContains: "Hero" },
    });
  });

  it("refuses an unknown profile, kind, role or number", () => {
    for (const query of ["profile=everything", "kinds=svg,pdf", "roles=mascot", "max=0", "max=-4", "max=lots", "minLongSide=1.5"]) {
      const result = parseSelectionParams(params(query));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).not.toMatch(/[\u2013\u2014]/);
    }
  });

  it("cuts a needle longer than any file name", () => {
    expect(parseSelectionParams(params(`nameContains=${"x".repeat(500)}`))).toEqual({ ok: true, options: { profile: "deck", nameContains: "x".repeat(200) } });
  });

  /** Every byte the endpoint serves is a fetch and a byte of the shared proxy budget, so "no limit" means the ceiling. */
  it("reads the byte limits and holds them to what one request may serve", () => {
    process.env.AGENT_ZIP_MAX_BYTES = "1000000";
    expect(parseSelectionParams(params("maxBytes=4000&maxFileBytes=2000"))).toMatchObject({
      ok: true,
      options: { maxTotalBytes: 4_000, maxFileBytes: 2_000 },
    });
    expect(parseSelectionParams(params("maxBytes=0&maxFileBytes=0"))).toMatchObject({ ok: true, options: { maxTotalBytes: 1_000_000, maxFileBytes: 0 } });
    expect(parseSelectionParams(params("maxBytes=999999999"))).toMatchObject({ ok: true, options: { maxTotalBytes: 1_000_000 } });
    for (const query of ["maxBytes=-1", "maxBytes=lots", "maxFileBytes=1.5"]) {
      expect(parseSelectionParams(params(query)).ok, query).toBe(false);
    }
  });

  it("caps max at the number of files one download writes", () => {
    process.env.AGENT_MAX_FILES = "5";
    expect(parseSelectionParams(params("max=500"))).toMatchObject({ ok: true, options: { max: 5 } });
  });
});
