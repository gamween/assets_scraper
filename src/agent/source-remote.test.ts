import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SafeFetch, SafeResponse } from "@/server/scan/types";
import { RemoteScanError, createRemoteScanSource } from "./source-remote";
import { testAsset, testScan } from "./testing";
import type { AgentScan } from "./types";

/**
 * The remote scan source against a local server standing in for the hosted app (plan Task G2.2): what it posts, what it
 * makes of the answer, and how it gets the bytes of an asset the hosted scan described.
 */

/**
 * Enough of a PNG for the type guard `fetchBytes` runs on every answer (`src/agent/bytes.ts`). The stub proxy answers
 * these, and the direct fetch answers `DIRECT_PNG`, so a test can tell which path served the bytes.
 */
const PROXIED_PNG = Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), Buffer.from("proxied")]);
const DIRECT_PNG = Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), Buffer.from("direct")]);

interface Call {
  method: string;
  url: string;
  authorization?: string;
  body: string;
}

const calls: Call[] = [];
/** The answer `/api/v1/scan` gives next, so one server covers the happy path and every failure. */
let answer: { status: number; body: string; type?: string } = { status: 200, body: "{}" };
let origin: string;
let server: http.Server;

/**
 * The document `view: "full"` answers with, in the exact shape of `src/app/api/v1/scan/route.ts`: the scan fields nested
 * under `scan`, next to `view`, `scanId` and the summary. `tests/integration/agent/remote-source.test.ts` runs the same
 * source against the real route, so this stub cannot drift from it unnoticed.
 */
const remoteScan = (patch: Partial<AgentScan> = {}): Record<string, unknown> => {
  const scan = testScan({
    assets: [testAsset({ id: "logo", kind: "svg", format: "svg", role: "site-logo", filename: "logo.svg" })],
    fonts: [],
    ...patch,
  });
  const { scanId, scannedAt, page, assets, fonts, palette, stats, warnings } = scan;
  return { view: "full", scanId, scan: { scannedAt, page, assets, fonts, palette, stats, warnings } };
};

beforeAll(async () => {
  server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const url = request.url ?? "";
      calls.push({
        method: request.method ?? "",
        url,
        ...(request.headers.authorization === undefined ? {} : { authorization: request.headers.authorization }),
        body: Buffer.concat(chunks).toString("utf8"),
      });
      if (url.startsWith("/api/asset")) {
        response.writeHead(200, { "content-type": "image/png" });
        response.end(PROXIED_PNG);
        return;
      }
      response.writeHead(answer.status, { "content-type": answer.type ?? "application/json" });
      response.end(answer.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const source = (patch: { token?: string } = {}) => createRemoteScanSource({ remote: origin, token: "agent-token", ...patch });

/** A `SafeFetch` that answers every URL with `body`, or fails, and records what it was asked. */
const fakeFetch = (body: Buffer | null, contentType = "image/png"): SafeFetch & { urls: string[] } => {
  const urls: string[] = [];
  const fetch = (url: string): Promise<SafeResponse> => {
    urls.push(url);
    if (!body) return Promise.reject(new Error("the CDN refused"));
    return Promise.resolve({
      url,
      status: 200,
      headers: new Headers({ "content-type": contentType }),
      redirected: false,
      stream: () => new ReadableStream(),
      buffer: () => Promise.resolve(body),
      text: () => Promise.resolve(body.toString("utf8")),
      json: () => Promise.resolve(JSON.parse(body.toString("utf8"))),
      cancel: () => Promise.resolve(),
    } satisfies SafeResponse);
  };
  return Object.assign(fetch, { urls });
};

describe("createRemoteScanSource().scan", () => {
  it("posts the URL and the full view with the bearer token", async () => {
    calls.length = 0;
    answer = { status: 200, body: JSON.stringify(remoteScan()) };

    const scan = await source().scan("stripe.com");

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("/api/v1/scan");
    expect(calls[0].authorization).toBe("Bearer agent-token");
    expect(JSON.parse(calls[0].body)).toEqual({ url: "stripe.com", view: "full" });
    expect(scan.source).toBe("remote");
    expect(scan.page.host).toBe("stripe.com");
    expect(scan.assets.map((asset) => asset.id)).toEqual(["logo"]);
    expect(scan.scanId).toBe("scan-1");
  });

  it("gives a scan with no id one the cache accepts", async () => {
    const body = remoteScan();
    delete body.scanId;
    answer = { status: 200, body: JSON.stringify(body) };

    const scan = await source().scan("stripe.com");

    expect(scan.scanId).toMatch(/^stripe\.com-[0-9a-z]+-[0-9a-f]{6}$/);
  });

  it("refuses to be created without a token", () => {
    const failure = (() => {
      try {
        return source({ token: "" });
      } catch (error) {
        return error;
      }
    })();
    expect(failure).toBeInstanceOf(RemoteScanError);
    expect((failure as RemoteScanError).code).toBe("unauthorized");
    expect((failure as RemoteScanError).message).toMatch(/ASSETS_SCRAPER_TOKEN/);
  });

  const failure = async (status: number, body = JSON.stringify({ error: { code: "internal", message: "nope" } })) => {
    answer = { status, body };
    return source()
      .scan("stripe.com")
      .then(() => null, (error: unknown) => error as RemoteScanError);
  };

  it("throws a typed error for a refused, throttled or broken hosted app", async () => {
    expect(await failure(401)).toMatchObject({ name: "RemoteScanError", code: "unauthorized", status: 401 });
    expect(await failure(429)).toMatchObject({ code: "rate-limited", status: 429 });
    expect(await failure(500)).toMatchObject({ code: "server", status: 500 });
    expect(await failure(422)).toMatchObject({ code: "request", status: 422 });
    const broken = await failure(200, "not json at all");
    expect(broken).toMatchObject({ code: "response", status: 200 });
  });

  it("carries the hosted error message", async () => {
    const error = await failure(422, JSON.stringify({ error: { code: "blocked-address", message: "Blocked address" } }));
    expect(error?.message).toContain("blocked-address");
    expect(error?.message).toContain("Blocked address");
  });

  it("rejects an answer that is not a scan", async () => {
    const error = await failure(200, JSON.stringify({ page: { url: "stripe.com" } }));
    expect(error).toMatchObject({ code: "response" });
  });
});

describe("createRemoteScanSource().fetchBytes", () => {
  it("fetches an https URL directly", async () => {
    const fetch = fakeFetch(DIRECT_PNG);
    calls.length = 0;

    const bytes = await createRemoteScanSource({ remote: origin, token: "agent-token" }, { fetch }).fetchBytes({
      url: "https://cdn.example.com/hero.png",
      proxy: "/api/asset?id=hero",
      format: "png",
    });

    expect(bytes).toEqual(DIRECT_PNG);
    expect(fetch.urls).toEqual(["https://cdn.example.com/hero.png"]);
    expect(calls).toHaveLength(0);
  });

  it("falls back to the hosted proxy when the direct fetch fails", async () => {
    const fetch = fakeFetch(null);
    calls.length = 0;

    const bytes = await createRemoteScanSource({ remote: origin, token: "agent-token" }, { fetch }).fetchBytes({
      url: "https://cdn.example.com/hero.png",
      proxy: "/api/asset?id=hero",
      format: "png",
    });

    expect(bytes).toEqual(PROXIED_PNG);
    expect(calls.map((call) => call.url)).toEqual(["/api/asset?id=hero"]);
    expect(calls[0].authorization).toBe("Bearer agent-token");
  });

  it("goes straight to the hosted proxy for an http URL", async () => {
    const fetch = fakeFetch(Buffer.from("never a valid image"));
    calls.length = 0;

    const bytes = await createRemoteScanSource({ remote: origin, token: "agent-token" }, { fetch }).fetchBytes({
      url: "http://cdn.example.com/hero.png",
      proxy: "/api/asset?id=hero",
      format: "png",
    });

    expect(bytes).toEqual(PROXIED_PNG);
    expect(fetch.urls).toEqual([]);
  });

  /**
   * The type guard of `src/agent/bytes.ts` on the direct leg: a CDN answering a page instead of the picture is a refusal
   * this source can recover from, so it falls through to the hosted proxy rather than ending the download.
   */
  it("falls back to the hosted proxy when the direct answer is not the file the scan reported", async () => {
    const fetch = fakeFetch(Buffer.from("<!doctype html><html></html>"), "text/html");
    calls.length = 0;

    const bytes = await createRemoteScanSource({ remote: origin, token: "agent-token" }, { fetch }).fetchBytes({
      url: "https://cdn.example.com/hero.png",
      proxy: "/api/asset?id=hero",
      format: "png",
    });

    expect(bytes).toEqual(PROXIED_PNG);
    expect(fetch.urls).toEqual(["https://cdn.example.com/hero.png"]);
    expect(calls.map((call) => call.url)).toEqual(["/api/asset?id=hero"]);
  });

  it("reads inline bytes without any request", async () => {
    const fetch = fakeFetch(null);
    calls.length = 0;

    const bytes = await createRemoteScanSource({ remote: origin, token: "agent-token" }, { fetch }).fetchBytes({
      url: "",
      proxy: "",
      format: "woff2",
      coversLatin: true,
      inline: { mime: "font/woff2", base64: Buffer.from("font-bytes").toString("base64") },
    });

    expect(bytes.toString("utf8")).toBe("font-bytes");
    expect(fetch.urls).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("reports an asset with no way to fetch it", async () => {
    const error = await createRemoteScanSource({ remote: origin, token: "agent-token" }, { fetch: fakeFetch(null) })
      .fetchBytes({ url: "", proxy: "", format: "png" })
      .then(() => null, (thrown: unknown) => thrown as Error);
    expect(error?.message).toMatch(/no URL/);
  });
});
