import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/contract";

const botid = vi.hoisted(() => ({
  checkBotId: vi.fn(async () => ({ isBot: false, isHuman: true, isVerifiedBot: false, bypassed: false })),
}));
vi.mock("botid/server", () => botid);

import { MemoryBudgetStore, setBudgetStoreForTests } from "./budget";
import { gateScanRequest, type GateResult } from "./gate";

const ORIGIN = "https://assets.example.com";
const OPS_TOKEN = "ops-token-with-at-least-32-characters-0001";

function scanRequest(
  body: unknown = { url: "linear.app" },
  { method = "POST", headers = {} }: { method?: string; headers?: Record<string, string | null> } = {},
): Request {
  const merged: Record<string, string | null> = { "content-type": "application/json", origin: ORIGIN, ...headers };
  const init: RequestInit = { method, headers: Object.fromEntries(Object.entries(merged).filter((entry): entry is [string, string] => entry[1] !== null)) };
  if (method !== "GET" && method !== "HEAD") init.body = typeof body === "string" ? body : JSON.stringify(body);
  return new Request(`${ORIGIN}/api/scan`, init);
}

async function expectFailure(result: GateResult, status: number, code: string) {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.response.status).toBe(status);
  expect(result.response.headers.get("cache-control")).toBe("no-store");
  expect(result.response.headers.get("content-type")).toMatch(/^application\/json/);
  const body = ApiError.parse(await result.response.json());
  expect(body.error.code).toBe(code);
  expect(body.error.message).not.toMatch(/[\u2013\u2014]/);
}

describe("gateScanRequest", () => {
  let budgetCalls = 0;

  beforeEach(() => {
    budgetCalls = 0;
    const memory = new MemoryBudgetStore();
    setBudgetStoreForTests({ incr: (key, by, ttl) => { budgetCalls++; return memory.incr(key, by, ttl); } });
    botid.checkBotId.mockClear();
    botid.checkBotId.mockResolvedValue({ isBot: false, isHuman: true, isVerifiedBot: false, bypassed: false });
  });

  afterEach(() => {
    setBudgetStoreForTests(null);
    vi.unstubAllEnvs();
  });

  it("answers 405 to anything but POST", async () => {
    const result = await gateScanRequest(scanRequest(undefined, { method: "GET" }));
    await expectFailure(result, 405, "invalid-url");
    if (!result.ok) expect(result.response.headers.get("allow")).toBe("POST");
  });

  it("requires a JSON content type", async () => {
    await expectFailure(await gateScanRequest(scanRequest({ url: "linear.app" }, { headers: { "content-type": "text/plain" } })), 400, "invalid-url");
    await expectFailure(await gateScanRequest(scanRequest({ url: "linear.app" }, { headers: { "content-type": null } })), 400, "invalid-url");
    expect((await gateScanRequest(scanRequest({ url: "linear.app" }, { headers: { "content-type": "Application/JSON; charset=utf-8" } }))).ok).toBe(true);
  });

  it("requires our own Origin", async () => {
    await expectFailure(await gateScanRequest(scanRequest({ url: "linear.app" }, { headers: { origin: "https://evil.example" } })), 403, "bot");
    await expectFailure(await gateScanRequest(scanRequest({ url: "linear.app" }, { headers: { origin: "null" } })), 403, "bot");
    await expectFailure(await gateScanRequest(scanRequest({ url: "linear.app" }, { headers: { origin: null } })), 403, "bot");
    await expectFailure(await gateScanRequest(scanRequest({ url: "linear.app" }, { headers: { origin: "http://assets.example.com" } })), 403, "bot");
  });

  it("validates the body", async () => {
    await expectFailure(await gateScanRequest(scanRequest({ url: "" })), 400, "invalid-url");
    await expectFailure(await gateScanRequest(scanRequest("{not json")), 400, "invalid-url");
    await expectFailure(await gateScanRequest(scanRequest(["linear.app"])), 400, "invalid-url");
    await expectFailure(await gateScanRequest(scanRequest({ url: `https://x.com/${"a".repeat(2048)}` })), 400, "invalid-url");
    await expectFailure(await gateScanRequest(scanRequest({ url: "linear.app", pad: "x".repeat(64 * 1024) })), 400, "invalid-url");
    expect(botid.checkBotId).not.toHaveBeenCalled();
  });

  it("blocks bots and fails closed when BotID errors", async () => {
    botid.checkBotId.mockResolvedValueOnce({ isBot: true, isHuman: false, isVerifiedBot: false, bypassed: false });
    await expectFailure(await gateScanRequest(scanRequest()), 403, "bot");
    botid.checkBotId.mockRejectedValueOnce(new Error("botid unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expectFailure(await gateScanRequest(scanRequest()), 403, "bot");
    expect(budgetCalls).toBe(0);
  });

  it("honors the kill switch before the access code and the budget", async () => {
    vi.stubEnv("SCAN_DISABLED", "1");
    vi.stubEnv("ACCESS_CODE", "abc");
    await expectFailure(await gateScanRequest(scanRequest({ url: "http://127.0.0.1/" })), 503, "disabled");
    expect(budgetCalls).toBe(0);
  });

  it("requires the access code when one is set", async () => {
    vi.stubEnv("ACCESS_CODE", "abc");
    await expectFailure(await gateScanRequest(scanRequest()), 401, "access-code");
    await expectFailure(await gateScanRequest(scanRequest({ url: "linear.app" }, { headers: { "x-access-code": "abd" } })), 401, "access-code");
    await expectFailure(await gateScanRequest(scanRequest({ url: "linear.app" }, { headers: { "x-access-code": "abcd" } })), 401, "access-code");
    expect(budgetCalls).toBe(0);
    expect((await gateScanRequest(scanRequest({ url: "linear.app" }, { headers: { "x-access-code": "abc" } }))).ok).toBe(true);
  });

  it("answers 429 when the budget is spent", async () => {
    vi.stubEnv("SCANS_PER_DAY", "1");
    expect((await gateScanRequest(scanRequest())).ok).toBe(true);
    await expectFailure(await gateScanRequest(scanRequest()), 429, "budget");
  });

  it("applies the URL policy last", async () => {
    vi.stubEnv("APP_HOSTS", "assets.example.com");
    await expectFailure(await gateScanRequest(scanRequest({ url: "http://127.0.0.1/" })), 422, "blocked-address");
    await expectFailure(await gateScanRequest(scanRequest({ url: "http://x.com:8080" })), 422, "unsupported-port");
    await expectFailure(await gateScanRequest(scanRequest({ url: "https://assets.example.com/?url=linear.app" })), 422, "own-host");
    await expectFailure(await gateScanRequest(scanRequest({ url: "ASSETS.example.com." })), 422, "own-host");
    for (const url of ["http://[::1]/", "localhost", "http://0x7f000001/", "http://[::ffff:10.0.0.1]/", "169.254.169.254", "http://app.localhost/", "http://0.0.0.0/"]) {
      await expectFailure(await gateScanRequest(scanRequest({ url })), 422, "blocked-address");
    }
    await expectFailure(await gateScanRequest(scanRequest({ url: "not a url" })), 400, "invalid-url");
    await expectFailure(await gateScanRequest(scanRequest({ url: "ftp://linear.app/" })), 400, "invalid-url");
  });

  it("lets a valid ops token skip BotID, budget and the Origin requirement", async () => {
    vi.stubEnv("OPS_TOKEN", OPS_TOKEN);
    vi.stubEnv("SCANS_PER_DAY", "1");
    botid.checkBotId.mockResolvedValue({ isBot: true, isHuman: false, isVerifiedBot: false, bypassed: false });
    const result = await gateScanRequest(scanRequest({ url: "linear.app" }, { headers: { origin: null, "x-ops-token": OPS_TOKEN } }));
    expect(result).toEqual({ ok: true, url: "https://linear.app/", host: "linear.app", ops: true });
    expect((await gateScanRequest(scanRequest({ url: "linear.app" }, { headers: { origin: null, "x-ops-token": OPS_TOKEN } }))).ok).toBe(true);
    expect(botid.checkBotId).not.toHaveBeenCalled();
    expect(budgetCalls).toBe(0);
    await expectFailure(await gateScanRequest(scanRequest({ url: "linear.app" }, { headers: { origin: "https://evil.example", "x-ops-token": OPS_TOKEN } })), 403, "bot");
    await expectFailure(await gateScanRequest(scanRequest({ url: "linear.app" }, { headers: { origin: null, "x-ops-token": `${OPS_TOKEN}x` } })), 403, "bot");
  });

  it("ignores an ops token shorter than 32 characters", async () => {
    vi.stubEnv("OPS_TOKEN", "short-token");
    await expectFailure(await gateScanRequest(scanRequest({ url: "linear.app" }, { headers: { origin: null, "x-ops-token": "short-token" } })), 403, "bot");
    vi.stubEnv("OPS_TOKEN", "");
    await expectFailure(await gateScanRequest(scanRequest({ url: "linear.app" }, { headers: { origin: null, "x-ops-token": "" } })), 403, "bot");
  });

  it("accepts a valid request", async () => {
    expect(await gateScanRequest(scanRequest({ url: "https://linear.app" }))).toEqual({ ok: true, url: "https://linear.app/", host: "linear.app", ops: false });
    expect(botid.checkBotId).toHaveBeenCalledTimes(1);
    expect(budgetCalls).toBe(2);
  });
});
