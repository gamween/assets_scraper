import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScanEvent } from "@/lib/contract";

const gateScanRequest = vi.fn();
const scan = vi.fn();
const refundScanBudget = vi.fn(async () => {});
const refuseScanMethod = () => Response.json({ error: { code: "invalid-url", message: "Use POST with a JSON body." } }, { status: 405, headers: { allow: "POST", "cache-control": "no-store" } });
vi.mock("@/server/security/gate", () => ({ gateScanRequest, refuseScanMethod }));
vi.mock("@/server/security/budget", () => ({ refundScanBudget }));
vi.mock("@/server/scan/engine", () => ({ scanEngine: { scan } }));

const { DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT } = await import("./route");

const request = () => new Request("http://localhost/api/scan", { method: "POST", body: JSON.stringify({ url: "example.com" }), headers: { "content-type": "application/json" } });

describe("POST /api/scan", () => {
  beforeEach(() => {
    gateScanRequest.mockReset();
    scan.mockReset();
    refundScanBudget.mockClear();
  });

  const streamOf = (...events: ScanEvent[]) =>
    scan.mockImplementation(async function* () {
      yield* events;
    });
  const accepted: ScanEvent = { type: "accepted", scanId: "s", url: "https://example.com/" };
  const busy: ScanEvent = { type: "error", code: "busy", message: "All browsers are busy" };

  it("returns the gate response when the gate refuses", async () => {
    gateScanRequest.mockResolvedValue({ ok: false, response: Response.json({ error: { code: "budget", message: "Daily scan limit reached" } }, { status: 429 }) });
    const response = await POST(request());
    expect(response.status).toBe(429);
    expect(scan).not.toHaveBeenCalled();
  });

  it("streams the engine events for the gated URL with the request signal", async () => {
    const events: ScanEvent[] = [{ type: "accepted", scanId: "s", url: "https://example.com/" }, { type: "error", code: "dns", message: "The host could not be resolved" }];
    gateScanRequest.mockResolvedValue({ ok: true, url: "https://example.com/", host: "example.com", ops: false });
    scan.mockImplementation(async function* () {
      yield* events;
    });
    const incoming = request();
    const response = await POST(incoming);
    expect(response.headers.get("content-type")).toBe("application/x-ndjson; charset=utf-8");
    expect(scan).toHaveBeenCalledWith({ url: "https://example.com/" }, { signal: incoming.signal });
    expect((await response.text()).trim().split("\n").map((line) => JSON.parse(line))).toEqual(events);
  });

  /**
   * `busy` is raised after the gate took a unit: the queue timed out or the health gate refused the launch, and no page
   * was opened. The client retries once, so without the refund a busy instance spends two units and scans nothing.
   */
  it("hands the unit back to the client's counters when the scan ends busy", async () => {
    gateScanRequest.mockResolvedValue({ ok: true, url: "https://example.com/", host: "example.com", ops: false, client: "203.0.113.7" });
    streamOf(accepted, busy);
    const response = await POST(request());
    expect((await response.text()).trim().split("\n").map((line) => JSON.parse(line))).toEqual([accepted, busy]);
    expect(refundScanBudget).toHaveBeenCalledTimes(1);
    expect(refundScanBudget).toHaveBeenCalledWith("203.0.113.7");
  });

  it("refunds nothing for any other failure, nor for an ops request, which took no unit", async () => {
    gateScanRequest.mockResolvedValue({ ok: true, url: "https://example.com/", host: "example.com", ops: false, client: null });
    streamOf(accepted, { type: "error", code: "dns", message: "The host could not be resolved" });
    await (await POST(request())).text();
    gateScanRequest.mockResolvedValue({ ok: true, url: "https://example.com/", host: "example.com", ops: true, client: null });
    streamOf(accepted, busy);
    await (await POST(request())).text();
    expect(refundScanBudget).not.toHaveBeenCalled();
  });

  it("binds every other method to the gate's refusal, so Next does not answer a bare 405 first", async () => {
    for (const handler of [GET, HEAD, PUT, PATCH, DELETE, OPTIONS]) {
      const response = await handler();
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(scan).not.toHaveBeenCalled();
  });

  it("answers a JSON internal error when the gate itself fails", async () => {
    gateScanRequest.mockRejectedValue(new Error("store down"));
    const response = await POST(request());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { code: "internal", message: "Something went wrong on our side" } });
  });
});
