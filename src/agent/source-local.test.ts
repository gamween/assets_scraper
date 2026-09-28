import { describe, expect, it } from "vitest";
import type { AssetSource, Diagnostics, PageInfo, ScanEvent, ScanStats } from "@/lib/contract";
import { ScanFailure } from "@/server/errors";
import type { SafeFetch, SafeResponse, ScanBackend } from "@/server/scan/types";
import { createLocalScanSource, decodeDataUri, scanIdFor } from "./source-local";
import { testAsset, testFontFamily, testFontFile } from "./testing";

/** A backend that replays `events` and records what it was asked, so the folding can be watched without a browser. */
const fakeBackend = (events: ScanEvent[]): ScanBackend & { calls: { url: string; signal: AbortSignal }[] } => {
  const calls: { url: string; signal: AbortSignal }[] = [];
  return {
    calls,
    async *scan(input, options) {
      calls.push({ url: input.url, signal: options.signal });
      for (const event of events) yield event;
    },
  };
};

const page = (patch: Partial<PageInfo> = {}): PageInfo => ({
  requestedUrl: "stripe.com",
  finalUrl: "https://stripe.com/",
  host: "stripe.com",
  title: "Stripe",
  status: 200,
  brandLinks: [],
  ...patch,
});

const stats: ScanStats = { assets: 2, svg: 1, images: 1, fonts: 1, hidden: { pixel: 3 }, durationMs: 1_234 };

const diagnostics: Diagnostics = {
  scanId: "engine-1",
  cold: false,
  phases: { open: 10 },
  queueMs: 0,
  egress: { bytes: 100, blocked: 0, refused: 0 },
  bodyTimeouts: 0,
  skippedBodies: 0,
  collector: "isolated",
  version: "test",
};

const done = (partial = false): ScanEvent => ({ type: "done", partial, stats, diagnostics });

describe("createLocalScanSource().scan", () => {
  it("folds the event stream into one scan, the last page event winning", async () => {
    const backend = fakeBackend([
      { type: "accepted", scanId: "engine-1", url: "stripe.com" },
      { type: "step", step: "open", state: "start" },
      { type: "step", step: "open", state: "done" },
      { type: "page", page: page({ title: "early", siteName: undefined }) },
      { type: "assets", items: [testAsset({ id: "a" })] },
      { type: "assets", items: [testAsset({ id: "b" }), testAsset({ id: "c" })] },
      { type: "fonts", families: [testFontFamily({ name: "Inter" })] },
      { type: "palette", palette: { brand: [{ hex: "#635bff" }], neutrals: [] } },
      { type: "page", page: page({ title: "Stripe", siteName: "Stripe" }) },
      done(),
    ]);
    const steps: string[] = [];
    const scan = await createLocalScanSource({ backend }).scan("stripe.com", { onStep: (step) => steps.push(step) });

    expect(scan.source).toBe("local");
    expect(scan.page).toEqual({ url: "stripe.com", finalUrl: "https://stripe.com/", host: "stripe.com", title: "Stripe", siteName: "Stripe" });
    expect(scan.assets.map((asset) => asset.id)).toEqual(["a", "b", "c"]);
    expect(scan.fonts.map((family) => family.name)).toEqual(["Inter"]);
    expect(scan.palette?.brand[0]?.hex).toBe("#635bff");
    expect(scan.stats).toEqual(stats);
    expect(scan.diagnostics).toEqual(diagnostics);
    expect(scan.warnings).toEqual([]);
    expect(scan.scanId).toMatch(/^stripe\.com-/);
    expect(Date.parse(scan.scannedAt)).toBeGreaterThan(0);
    expect(steps).toEqual(["open"]);
    expect(backend.calls[0]?.url).toBe("stripe.com");
  });

  it("formats a warning with and without a detail, and leads with partial", async () => {
    const backend = fakeBackend([
      { type: "page", page: page() },
      { type: "warning", code: "truncated", detail: "40 assets" },
      { type: "warning", code: "verify-skipped" },
      done(true),
    ]);
    expect((await createLocalScanSource({ backend }).scan("stripe.com")).warnings).toEqual(["partial", "truncated: 40 assets", "verify-skipped"]);
  });

  it("does not repeat a partial the engine already warned about", async () => {
    const backend = fakeBackend([{ type: "page", page: page() }, { type: "warning", code: "partial" }, done(true)]);
    expect((await createLocalScanSource({ backend }).scan("stripe.com")).warnings).toEqual(["partial"]);
  });

  it("turns an error event into the engine's ScanFailure", async () => {
    const backend = fakeBackend([
      { type: "page", page: page() },
      { type: "error", code: "http", message: "HTTP 503", httpStatus: 503, fallback: [testAsset({ id: "a" })] },
      done(),
    ]);
    let failure: unknown;
    try {
      await createLocalScanSource({ backend }).scan("stripe.com");
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ScanFailure);
    const thrown = failure as ScanFailure;
    expect(thrown.code).toBe("http");
    expect(thrown.message).toBe("HTTP 503");
    expect(thrown.options.httpStatus).toBe(503);
    expect(thrown.options.fallback?.map((asset) => asset.id)).toEqual(["a"]);
  });

  it("fails when the stream ends without a page or without a done", async () => {
    await expect(createLocalScanSource({ backend: fakeBackend([done()]) }).scan("stripe.com")).rejects.toThrow(/without a result/);
    await expect(createLocalScanSource({ backend: fakeBackend([{ type: "page", page: page() }]) }).scan("stripe.com")).rejects.toThrow(
      /without a result/,
    );
    await expect(createLocalScanSource({ backend: fakeBackend([]) }).scan("stripe.com")).rejects.toBeInstanceOf(ScanFailure);
  });

  it("passes the caller's signal to the backend, and one of its own when there is none", async () => {
    const backend = fakeBackend([{ type: "page", page: page() }, done()]);
    const source = createLocalScanSource({ backend });
    const controller = new AbortController();
    await source.scan("stripe.com", { signal: controller.signal });
    await source.scan("stripe.com");
    expect(backend.calls[0]?.signal).toBe(controller.signal);
    expect(backend.calls[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(backend.calls[1]?.signal.aborted).toBe(false);
  });
});

const assetSource = (url: string): AssetSource => ({ url, proxy: "", format: "png" });

/** A fetch in the shape `safeFetch` returns, with only the parts `fetchBytes` touches, counting what it was asked. */
const fakeFetch = (status: number, body: string): SafeFetch & { calls: number; cancels: number } => {
  const fetch = Object.assign(
    async () => {
      fetch.calls += 1;
      return { status, buffer: async () => Buffer.from(body), cancel: async () => void (fetch.cancels += 1) } as unknown as SafeResponse;
    },
    { calls: 0, cancels: 0 },
  );
  return fetch;
};

describe("createLocalScanSource().fetchBytes", () => {
  it("reads inline bytes and a data URI without a request, and guards every other URL", async () => {
    const fetch = fakeFetch(200, "remote");
    const source = createLocalScanSource({ backend: fakeBackend([]), fetch });

    expect((await source.fetchBytes(testFontFile({ inline: { base64: "aGk=", mime: "font/woff2" } }))).toString()).toBe("hi");
    expect((await source.fetchBytes(assetSource("data:text/plain,hi"))).toString()).toBe("hi");
    await expect(source.fetchBytes(assetSource(""))).rejects.toThrow(/no URL/);
    expect(fetch.calls).toBe(0);

    expect((await source.fetchBytes(assetSource("https://cdn.example.com/a.png"))).toString()).toBe("remote");
    expect(fetch.calls).toBe(1);
  });

  it("throws on an error status and cancels the body", async () => {
    const fetch = fakeFetch(404, "");
    const source = createLocalScanSource({ backend: fakeBackend([]), fetch });
    await expect(source.fetchBytes(assetSource("https://cdn.example.com/a.png"))).rejects.toThrow(/HTTP 404/);
    expect(fetch.cancels).toBe(1);
  });
});

describe("scanIdFor", () => {
  it("names a scan after the host and the time, and the cache accepts it", () => {
    expect(scanIdFor("www.Stripe.com", 1_759_000_000_000)).toMatch(/^stripe\.com-[0-9a-z]+-[0-9a-f]{6}$/);
    expect(scanIdFor("127.0.0.1:8787")).toMatch(/^127\.0\.0\.1-8787-/);
    expect(scanIdFor("")).toMatch(/^site-/);
    expect(scanIdFor("a".repeat(400)).length).toBeLessThanOrEqual(120);
  });
});

describe("decodeDataUri", () => {
  it("reads base64 and percent encoded payloads", () => {
    expect(decodeDataUri("data:font/woff2;base64,aGVsbG8=").toString("utf8")).toBe("hello");
    expect(decodeDataUri("data:image/svg+xml,%3Csvg%2F%3E").toString("utf8")).toBe("<svg/>");
    expect(decodeDataUri("data:,plain").toString("utf8")).toBe("plain");
    expect(() => decodeDataUri("data:image/png;base64")).toThrow(/malformed/);
  });
});
