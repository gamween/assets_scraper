import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScanEvent } from "@/lib/contract";

const gateScanRequest = vi.fn();
const scan = vi.fn();
vi.mock("@/server/security/gate", () => ({ gateScanRequest }));
vi.mock("@/server/scan/engine", () => ({ scanEngine: { scan } }));

const { POST, maxDuration, runtime } = await import("./route");

const request = () => new Request("http://localhost/api/scan", { method: "POST", body: JSON.stringify({ url: "example.com" }), headers: { "content-type": "application/json" } });

describe("POST /api/scan", () => {
  beforeEach(() => {
    gateScanRequest.mockReset();
    scan.mockReset();
  });

  it("runs on Node with room for the 90 s scan deadline", () => {
    expect(runtime).toBe("nodejs");
    expect(maxDuration).toBe(120);
  });

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

  it("answers a JSON internal error when the gate itself fails", async () => {
    gateScanRequest.mockRejectedValue(new Error("store down"));
    const response = await POST(request());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { code: "internal", message: "Something went wrong on our side" } });
  });
});
