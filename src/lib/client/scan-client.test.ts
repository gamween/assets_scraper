import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScanEvent } from "@/lib/contract";
import { ACCESS_CODE_KEY, startScan, type ScanErrorInfo } from "./scan-client";

function ndjsonResponse(lines: unknown[], options: { hold?: boolean } = {}) {
  const encoder = new TextEncoder();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const text = lines.map((line) => `${JSON.stringify(line)}\n`).join("");
      // Split mid-line so the decoder has to join chunks.
      const middle = Math.floor(text.length / 2);
      controller.enqueue(encoder.encode(text.slice(0, middle)));
      controller.enqueue(encoder.encode(text.slice(middle)));
      if (!options.hold) controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  const response = new Response(body, { status: 200, headers: { "content-type": "application/x-ndjson" } });
  return { response, isCancelled: () => cancelled };
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const done = {
  type: "done",
  partial: false,
  stats: { assets: 0, svg: 0, images: 0, fonts: 0, hidden: {}, durationMs: 10 },
  diagnostics: { scanId: "s1", cold: false, phases: {}, queueMs: 0, egress: { bytes: 0, blocked: 0, refused: 0 }, bodyTimeouts: 0, skippedBodies: 0, collector: "isolated", version: "x" },
} satisfies ScanEvent;

function recorder() {
  const events: ScanEvent[] = [];
  const errors: ScanErrorInfo[] = [];
  return { events, errors, handlers: { onEvent: (e: ScanEvent) => events.push(e), onError: (e: ScanErrorInfo) => errors.push(e) } };
}

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
}

describe("startScan", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", memoryStorage());
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("POSTs JSON with the stored access code and streams events in order", async () => {
    vi.stubGlobal("localStorage", memoryStorage({ [ACCESS_CODE_KEY]: "s3cret" }));
    const lines: ScanEvent[] = [
      { type: "accepted", scanId: "s1", url: "https://linear.app/" },
      { type: "step", step: "open", state: "start" },
      { type: "page", page: { requestedUrl: "https://linear.app/", finalUrl: "https://linear.app/", host: "linear.app", title: "Linear: Plan", status: 200, brandLinks: [] } },
      done,
    ];
    const fetchMock = vi.fn(async () => ndjsonResponse(lines).response);
    vi.stubGlobal("fetch", fetchMock);
    const rec = recorder();
    await startScan("https://linear.app/", rec.handlers).done;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/scan");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
    expect(new Headers(init.headers).get("x-access-code")).toBe("s3cret");
    expect(JSON.parse(String(init.body))).toEqual({ url: "https://linear.app/" });
    expect(rec.events).toEqual(lines);
    expect(rec.errors).toEqual([]);
  });

  it("sends no access code header when none is stored", async () => {
    const fetchMock = vi.fn(async () => ndjsonResponse([done]).response);
    vi.stubGlobal("fetch", fetchMock);
    await startScan("https://linear.app/", recorder().handlers).done;
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(new Headers(init.headers).has("x-access-code")).toBe(false);
  });

  it("maps gate JSON errors to onError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(429, { error: { code: "budget", message: "Daily scan limit reached" } })));
    const rec = recorder();
    await startScan("https://linear.app/", rec.handlers).done;
    expect(rec.errors).toEqual([{ code: "budget", message: "Daily scan limit reached", httpStatus: 429 }]);
    expect(rec.events).toEqual([]);
  });

  it("maps a non-JSON 429 to rate-limited and other failures to internal", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Too Many Requests", { status: 429 })));
    const rec = recorder();
    await startScan("https://linear.app/", rec.handlers).done;
    expect(rec.errors.map((e) => e.code)).toEqual(["rate-limited"]);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("Not implemented", { status: 501 })));
    const rec2 = recorder();
    await startScan("https://linear.app/", rec2.handlers).done;
    expect(rec2.errors).toMatchObject([{ code: "internal", httpStatus: 501 }]);

    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    const rec3 = recorder();
    await startScan("https://linear.app/", rec3.handlers).done;
    expect(rec3.errors.map((e) => e.code)).toEqual(["internal"]);
  });

  it("delivers stream error events to onError with their fallback and diagnostics", async () => {
    const error = { type: "error", code: "blocked", message: "blocked", fallback: [], diagnostics: done.diagnostics } satisfies ScanEvent;
    vi.stubGlobal("fetch", vi.fn(async () => ndjsonResponse([{ type: "accepted", scanId: "s1", url: "https://g2.com/" }, error]).response));
    const rec = recorder();
    await startScan("https://g2.com/", rec.handlers).done;
    expect(rec.events.map((e) => e.type)).toEqual(["accepted"]);
    expect(rec.errors).toEqual([{ code: "blocked", message: "blocked", fallback: [], diagnostics: done.diagnostics }]);
  });

  it("rejects a malformed event outside production, and passes it through inside it", async () => {
    // The contract check exists for a deploy that changes an event shape under a stale tab, which is production only,
    // so both halves of the policy are pinned here rather than only the half the test run happens to take.
    const malformed = { type: "done", partial: false };
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("NODE_ENV", "development");
    vi.stubGlobal("fetch", vi.fn(async () => ndjsonResponse([malformed]).response));
    const strict = recorder();
    await startScan("https://x.com/", strict.handlers).done;
    expect(strict.errors).toEqual([{ code: "internal", message: "The scan returned an unexpected response." }]);

    vi.stubEnv("NODE_ENV", "production");
    const lenient = recorder();
    await startScan("https://x.com/", lenient.handlers).done;
    expect(lenient.events).toEqual([malformed]);
    expect(lenient.errors).toEqual([]);
  });

  it("reports a stream that ends without done or error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ndjsonResponse([{ type: "accepted", scanId: "s1", url: "https://x.com/" }]).response));
    const rec = recorder();
    await startScan("https://x.com/", rec.handlers).done;
    expect(rec.errors.map((e) => e.code)).toEqual(["internal"]);
  });

  it("retries once after a jittered delay on busy, then reports busy", async () => {
    vi.useFakeTimers();
    const busy = { type: "error", code: "busy", message: "busy" } satisfies ScanEvent;
    const fetchMock = vi.fn(async () => ndjsonResponse([busy]).response);
    vi.stubGlobal("fetch", fetchMock);
    const rec = recorder();
    const onRetry = vi.fn();
    const scan = startScan("https://linear.app/", { ...rec.handlers, onRetry });

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(rec.errors).toEqual([]);
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    await scan.done;
    expect(rec.errors.map((e) => e.code)).toEqual(["busy"]);
  });

  it("succeeds when the retry after busy works", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(ndjsonResponse([{ type: "error", code: "busy", message: "busy" }]).response)
      .mockResolvedValueOnce(ndjsonResponse([done]).response);
    vi.stubGlobal("fetch", fetchMock);
    const rec = recorder();
    const scan = startScan("https://linear.app/", rec.handlers);
    await vi.advanceTimersByTimeAsync(5000);
    await scan.done;
    expect(rec.errors).toEqual([]);
    expect(rec.events.map((e) => e.type)).toEqual(["done"]);
  });

  it("abort cancels the stream and calls no further handlers", async () => {
    const stream = ndjsonResponse([{ type: "accepted", scanId: "s1", url: "https://linear.app/" }], { hold: true });
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        signal = init.signal ?? undefined;
        return stream.response;
      }),
    );
    const rec = recorder();
    const scan = startScan("https://linear.app/", rec.handlers);
    await vi.waitFor(() => expect(rec.events).toHaveLength(1));
    scan.abort();
    await scan.done;
    expect(signal?.aborted).toBe(true);
    expect(stream.isCancelled()).toBe(true);
    expect(rec.events).toHaveLength(1);
    expect(rec.errors).toEqual([]);
  });
});
