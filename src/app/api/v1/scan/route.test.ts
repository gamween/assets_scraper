import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testScan } from "@/agent/testing";
import { ApiError } from "@/lib/contract";
import { ScanFailure } from "@/server/errors";

vi.mock("botid/server", () => ({ checkBotId: vi.fn(async () => ({ isBot: true })) }));

const { MemoryBudgetStore, setBudgetStoreForTests } = await import("@/server/security/budget");
const { setAgentScanSourceForTests } = await import("../source");
const { DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT, maxDuration, runtime } = await import("./route");

const TOKEN = "agent-token-one-with-enough-characters";
const scan = vi.fn();

const request = (body: unknown = { url: "stripe.com" }, headers: Record<string, string> = {}): Request =>
  new Request("https://assets.example.com/api/v1/scan", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

let env: typeof process.env;

beforeEach(() => {
  env = { ...process.env };
  process.env.AGENT_TOKENS = TOKEN;
  scan.mockReset();
  scan.mockResolvedValue(testScan());
  setBudgetStoreForTests(new MemoryBudgetStore());
  setAgentScanSourceForTests({ kind: "local", scan, fetchBytes: vi.fn() });
});

afterEach(() => {
  process.env = env;
  setBudgetStoreForTests(null);
  setAgentScanSourceForTests(null);
});

describe("POST /api/v1/scan", () => {
  it("runs on Node with room for the 90 s scan deadline", () => {
    expect(runtime).toBe("nodejs");
    expect(maxDuration).toBe(120);
  });

  it("returns the summary view by default, as one JSON document", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^application\/json/);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(scan).toHaveBeenCalledWith("https://stripe.com/", { signal: expect.anything() });
    expect(body.view).toBe("summary");
    expect(body.scanId).toBe("scan-1");
    expect(body.summary.counts.assets).toBe(236);
    expect(body.summary.logos.length).toBeGreaterThan(0);
    expect(body.scan).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThan(4_500);
  });

  it("adds every asset and font in the full view", async () => {
    const response = await POST(request({ url: "stripe.com", view: "full" }));
    const body = await response.json();
    expect(body.view).toBe("full");
    expect(body.summary.scanId).toBe("scan-1");
    expect(body.scan.assets).toHaveLength(236);
    expect(body.scan.fonts.map((family: { family?: string; name?: string }) => family.name)).toEqual(["Inter", "Söhne"]);
    expect(body.scan.palette.brand[0].hex).toBe("#635bff");
    expect(body.scan.page.finalUrl).toBe("https://stripe.com/");
    expect(body.scan.stats.assets).toBe(236);
    expect(body.scan.scannedAt).toBe("2026-09-27T10:00:00.000Z");
    expect(body.scan.warnings).toEqual([]);
  });

  it("refuses an unknown view", async () => {
    const response = await POST(request({ url: "stripe.com", view: "everything" }));
    expect(response.status).toBe(400);
    expect(ApiError.parse(await response.json()).error.code).toBe("invalid-url");
    expect(scan).not.toHaveBeenCalled();
  });

  it("refuses a request with no bearer token before it reads the body", async () => {
    const response = await POST(request({ url: "stripe.com" }, { authorization: "" }));
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(scan).not.toHaveBeenCalled();
  });

  it("refuses a body that is not JSON", async () => {
    const response = await POST(request("{"));
    expect(response.status).toBe(400);
    expect(ApiError.parse(await response.json()).error.code).toBe("invalid-url");
  });

  it("maps an engine failure to its v1 code and the right status", async () => {
    const cases: [ScanFailure, number][] = [
      [new ScanFailure("dns", "The host could not be resolved"), 502],
      [new ScanFailure("connect", "The site refused the connection"), 502],
      [new ScanFailure("http", "The page returned 404", { httpStatus: 404 }), 502],
      [new ScanFailure("blocked", "The site blocked the scan"), 502],
      [new ScanFailure("not-html", "That URL is a file, not a page"), 422],
      [new ScanFailure("timeout", "The scan timed out"), 504],
      [new ScanFailure("busy", "All browsers are busy"), 503],
      [new ScanFailure("internal", "Something went wrong on our side"), 500],
    ];
    for (const [failure, status] of cases) {
      scan.mockRejectedValueOnce(failure);
      const response = await POST(request());
      expect(response.status).toBe(status);
      const body = ApiError.parse(await response.json());
      expect(body.error.code).toBe(failure.code);
      expect(body.error.message).toBe(failure.message);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("hands the budget unit back when no browser was free, as /api/scan does", async () => {
    process.env.SCANS_PER_DAY = "1";
    scan.mockRejectedValueOnce(new ScanFailure("busy", "All browsers are busy"));
    expect((await POST(request())).status).toBe(503);
    // The refund is what makes the retry possible: without it the one unit of the day is gone on a scan that never ran.
    expect((await POST(request())).status).toBe(200);
  });

  it("answers an internal error for an unexpected failure, without leaking its message", async () => {
    scan.mockRejectedValueOnce(new Error("postgres://user:secret@host/db is down"));
    const response = await POST(request());
    expect(response.status).toBe(500);
    const body = ApiError.parse(await response.json());
    expect(body.error).toEqual({ code: "internal", message: "Something went wrong on our side" });
  });

  it("refuses a private address with 422 blocked-address, without scanning", async () => {
    const response = await POST(request({ url: "http://127.0.0.1/" }));
    expect(response.status).toBe(422);
    expect(ApiError.parse(await response.json()).error.code).toBe("blocked-address");
    expect(scan).not.toHaveBeenCalled();
  });

  it("answers every other method with 405 and allow: POST", async () => {
    for (const handler of [GET, HEAD, PUT, PATCH, DELETE, OPTIONS]) {
      const response = await handler();
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(scan).not.toHaveBeenCalled();
  });
});
