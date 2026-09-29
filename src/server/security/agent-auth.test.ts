import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/contract";

vi.mock("botid/server", () => ({ checkBotId: vi.fn(async () => ({ isBot: false })) }));
/** The real comparison, watched: what makes the check constant time is which calls it makes, not how long they take. */
const crypto = vi.hoisted(() => ({ timingSafeEqual: vi.fn() }));
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  crypto.timingSafeEqual.mockImplementation(actual.timingSafeEqual);
  return { ...actual, default: actual, timingSafeEqual: crypto.timingSafeEqual };
});

const { MIN_AGENT_TOKEN_LENGTH, agentTokens, authenticateAgent } = await import("./agent-auth");

const FIRST = "agent-token-one-with-enough-characters";
const SECOND = "agent-token-two-with-enough-characters";
const OPS = "ops-token-with-at-least-32-characters-0001";

const request = (authorization?: string): Request =>
  new Request("https://assets.example.com/api/v1/scan", {
    method: "POST",
    headers: authorization === undefined ? {} : { authorization },
  });

let env: typeof process.env;

beforeEach(() => {
  env = { ...process.env };
  process.env.AGENT_TOKENS = `${FIRST}, ${SECOND} `;
  process.env.OPS_TOKEN = OPS;
});

afterEach(() => {
  process.env = env;
  vi.restoreAllMocks();
});

async function expectRefusal(result: ReturnType<typeof authenticateAgent>): Promise<void> {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.response.status).toBe(401);
  expect(result.response.headers.get("cache-control")).toBe("no-store");
  expect(result.response.headers.get("www-authenticate")).toBe("Bearer");
  const body = ApiError.parse(await result.response.json());
  expect(body.error.code).toBe("access-code");
  expect(body.error.message).not.toMatch(/[\u2013\u2014]/);
}

describe("agentTokens", () => {
  it("reads AGENT_TOKENS as a comma separated list, trimmed", () => {
    expect(agentTokens()).toEqual([FIRST, SECOND]);
  });

  it("ignores empty entries and tokens too short to guard anything", () => {
    process.env.AGENT_TOKENS = `,  , short, ${FIRST}`;
    expect(agentTokens()).toEqual([FIRST]);
    expect(MIN_AGENT_TOKEN_LENGTH).toBeGreaterThanOrEqual(24);
  });

  it("is empty when nothing is configured", () => {
    delete process.env.AGENT_TOKENS;
    expect(agentTokens()).toEqual([]);
  });
});

describe("authenticateAgent", () => {
  it("accepts a configured token and reports which one matched as an index", () => {
    expect(authenticateAgent(request(`Bearer ${FIRST}`))).toEqual({ ok: true, tokenIndex: 0 });
    expect(authenticateAgent(request(`bearer ${SECOND}`))).toEqual({ ok: true, tokenIndex: 1 });
  });

  it("refuses a missing, malformed or empty authorization header", async () => {
    for (const header of [undefined, "", "Bearer", "Bearer   ", `Token ${FIRST}`, FIRST]) {
      await expectRefusal(authenticateAgent(request(header)));
    }
  });

  it("refuses an unknown token", async () => {
    await expectRefusal(authenticateAgent(request("Bearer agent-token-nobody-configured-here")));
  });

  it("refuses every request when no token is configured", async () => {
    delete process.env.AGENT_TOKENS;
    await expectRefusal(authenticateAgent(request(`Bearer ${FIRST}`)));
  });

  it("does not accept the ops token, which keeps its own gate", async () => {
    await expectRefusal(authenticateAgent(request(`Bearer ${OPS}`)));
  });

  it("never logs the token, matched or not", () => {
    const wrote = vi.fn();
    for (const stream of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, stream).mockImplementation(wrote);
    authenticateAgent(request(`Bearer ${FIRST}`));
    authenticateAgent(request("Bearer agent-token-nobody-configured-here"));
    expect(wrote).not.toHaveBeenCalled();
  });

  it("compares in constant time: every configured token, digest against digest, whatever matched", () => {
    // A plain === returns at the first differing character, and a loop that stops at a match tells which token nearly
    // matched: both would pass a test that only checks the answer, so this checks the comparisons made.
    const almost = `${FIRST.slice(0, -1)}X`;
    crypto.timingSafeEqual.mockClear();
    expect(authenticateAgent(request(`Bearer ${almost}`)).ok).toBe(false);
    expect(crypto.timingSafeEqual).toHaveBeenCalledTimes(2);
    crypto.timingSafeEqual.mockClear();
    expect(authenticateAgent(request(`Bearer ${FIRST}`))).toEqual({ ok: true, tokenIndex: 0 });
    expect(crypto.timingSafeEqual).toHaveBeenCalledTimes(2);
    // sha256 digests, so two tokens of different lengths are compared over the same 32 bytes
    for (const [a, b] of crypto.timingSafeEqual.mock.calls as [Uint8Array, Uint8Array][]) expect([a.byteLength, b.byteLength]).toEqual([32, 32]);
  });
});
