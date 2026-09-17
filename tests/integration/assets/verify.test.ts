import type http from "node:http";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FixtureServer } from "../../fixtures/serve";
import type { SafeFetch } from "@/server/scan/types";
import { runVerifications, verifyUrl } from "@/server/scan/post/verify";
import { serveAssetsFixture, testFetch } from "./harness";

const noise = (width: number, height: number) => {
  const data = Buffer.alloc(width * height * 3);
  for (let i = 0; i < data.length; i++) data[i] = (i * 7919) % 251;
  return sharp(data, { raw: { width, height, channels: 3 } });
};

let server: FixtureServer;
let bigPng: Buffer;
let webp: Buffer;
let gif: Buffer;
const requests: http.IncomingHttpHeaders[] = [];
const rangeResetRequests: http.IncomingHttpHeaders[] = [];

beforeAll(async () => {
  bigPng = await noise(1000, 900).png({ compressionLevel: 0 }).toBuffer();
  webp = await noise(640, 360).webp().toBuffer();
  gif = await noise(400, 300).gif().toBuffer();
  expect(bigPng.length).toBeGreaterThan(262_144);
  server = await serveAssetsFixture({
    "/ranged.png": (req, res) => {
      requests.push(req.headers);
      res.writeHead(206, { "content-type": "image/png", "content-range": "bytes 0-262143/900000" });
      res.end(bigPng.subarray(0, 262_144));
    },
    "/full.png": (_req, res) => {
      res.writeHead(200, { "content-type": "image/png", "content-length": String(bigPng.length) });
      res.end(bigPng);
    },
    "/error.png": (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html><title>Not found</title>");
    },
    "/missing.png": (_req, res) => {
      res.writeHead(404, { "content-type": "image/png" });
      res.end();
    },
    "/blob": (_req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(webp);
    },
    "/garbage": (_req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(Buffer.from("PK\u0003\u0004 not an image"));
    },
    // A CDN edge that resets the response mid-body whenever the request carries a range, and serves the file otherwise.
    "/range-resets.png": (req, res) => {
      rangeResetRequests.push(req.headers);
      if (req.headers.range) {
        res.writeHead(206, { "content-type": "image/png", "content-range": `bytes 0-262143/${900_000}` });
        res.write(bigPng.subarray(0, 1024));
        res.socket?.destroy();
        return;
      }
      res.writeHead(200, { "content-type": "image/png", "content-length": String(bigPng.length) });
      res.end(bigPng);
    },
    "/partial.gif": (_req, res) => {
      res.writeHead(206, { "content-type": "image/gif", "content-range": `bytes 0-1023/${gif.length}` });
      res.end(gif.subarray(0, 1024));
    },
  });
});
afterAll(() => server.close());

const options = () => ({ fetch: testFetch, pageUrl: `${server.origin}/`, signal: new AbortController().signal, deadline: Date.now() + 8_000 });

describe("verifyUrl", () => {
  it("reads the full size from content-range and the dimensions from the first bytes", async () => {
    const result = await verifyUrl(`${server.origin}/ranged.png`, options());
    expect(result).toMatchObject({ ok: true, format: "png", bytes: 900_000, width: 1000, height: 900, complete: false });
    const headers = requests.at(-1)!;
    expect(headers.range).toBe("bytes=0-262143");
    expect(headers.accept).toBe("image/png,image/jpeg,image/gif,image/svg+xml,*/*;q=0.5");
    expect(headers.referer).toBe(`${server.origin}/`);
    expect(headers["user-agent"]).toMatch(/Chrome\/\d+/);
    expect(headers["user-agent"]).not.toMatch(/Headless/);
  });

  it("retries without the range when the ranged request is reset mid-body", async () => {
    rangeResetRequests.length = 0;
    const result = await verifyUrl(`${server.origin}/range-resets.png`, options());
    expect(result).toMatchObject({ ok: true, format: "png", width: 1000, height: 900 });
    // Two requests: the ranged one that was reset, then the same URL without a range.
    expect(rangeResetRequests.map((headers) => headers.range)).toEqual(["bytes=0-262143", undefined]);
  });

  it("does not retry a failure the range cannot have caused", async () => {
    let calls = 0;
    const counting: SafeFetch = (target, init) => {
      calls += 1;
      return testFetch(target, init);
    };
    // A host that does not resolve answers nothing, ranged or not, so it costs one request instead of two.
    expect(await verifyUrl("https://example.invalid/logo.png", { ...options(), fetch: counting })).toMatchObject({ ok: false, reason: "network" });
    expect(calls).toBe(1);
  });

  it("stops reading a response that ignores the range", async () => {
    const result = await verifyUrl(`${server.origin}/full.png`, options());
    expect(result).toMatchObject({ ok: true, format: "png", bytes: bigPng.length, width: 1000, height: 900, complete: false });
  });

  it("keeps the bytes of a small complete file", async () => {
    const result = await verifyUrl(`${server.origin}/assets/logo.svg`, options());
    expect(result).toMatchObject({ ok: true, format: "svg", bytes: 111, complete: true });
    expect(result.ok && result.body?.toString("utf8")).toContain("<svg");
  });

  it("rejects HTML, errors and unreachable hosts", async () => {
    expect(await verifyUrl(`${server.origin}/error.png`, options())).toMatchObject({ ok: false, reason: "not-image" });
    expect(await verifyUrl(`${server.origin}/missing.png`, options())).toMatchObject({ ok: false, reason: "http", status: 404 });
    expect(await verifyUrl(`${server.origin}/garbage`, options())).toMatchObject({ ok: false, reason: "not-image" });
    expect(await verifyUrl("https://example.invalid/logo.png", options())).toMatchObject({ ok: false, reason: "network" });
  });

  it("sniffs octet-stream bodies", async () => {
    expect(await verifyUrl(`${server.origin}/blob`, options())).toMatchObject({ ok: true, format: "webp", width: 640, height: 360 });
  });

  it("reads GIF dimensions from the header when the partial body cannot be decoded", async () => {
    expect(await verifyUrl(`${server.origin}/partial.gif`, options())).toMatchObject({ ok: true, format: "gif", bytes: gif.length, width: 400, height: 300 });
  });

  it("reports an aborted or late request as skipped", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await verifyUrl(`${server.origin}/ranged.png`, { ...options(), signal: controller.signal })).toMatchObject({ ok: false, reason: "verify-skipped" });
    expect(await verifyUrl(`${server.origin}/ranged.png`, { ...options(), deadline: Date.now() - 1 })).toMatchObject({ ok: false, reason: "verify-skipped" });
  });
});

describe("runVerifications", () => {
  it("respects the concurrency and stops starting tasks after the deadline", async () => {
    let active = 0;
    let maxActive = 0;
    let started = 0;
    const task = async () => {
      started++;
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 200));
      active--;
      return { ok: true as const };
    };
    const results = await runVerifications(Array.from({ length: 40 }, () => task), { concurrency: 16, deadline: Date.now() + 300 });
    expect(maxActive).toBe(16);
    expect(started).toBe(32);
    expect(results.filter((r) => r.ok)).toHaveLength(32);
    expect(results.slice(32)).toEqual(Array.from({ length: 8 }, () => ({ ok: false, reason: "verify-skipped" })));
  });

  it("aborts running tasks at the deadline", async () => {
    const results = await runVerifications(
      [
        (signal: AbortSignal) =>
          new Promise<{ ok: boolean; reason?: string }>((resolve) => signal.addEventListener("abort", () => resolve({ ok: false, reason: "aborted" }))),
      ],
      { concurrency: 2, deadline: Date.now() + 50 },
    );
    expect(results).toEqual([{ ok: false, reason: "aborted" }]);
  });
});
