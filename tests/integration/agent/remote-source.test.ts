import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { saveScan } from "@/agent/cache";
import { scanPage } from "@/agent/cli";
import { RemoteScanError, createRemoteScanSource } from "@/agent/source-remote";
import { testScan } from "@/agent/testing";
import { POST } from "@/app/api/v1/scan/route";
import type { SafeFetch } from "@/server/scan/types";
import { handleAssetRequest } from "@/server/security/asset-proxy";
import { createSigner } from "@/server/security/sign";
import type { FixtureServer } from "../../fixtures/serve";
import { serveAssetsFixture } from "../assets/harness";

/**
 * The remote scan source against the real hosted handlers, which is the coverage the unit tests cannot give: they stand
 * their own server in for the app, so a source that reads the wrong document shape or sends a request shape the app
 * refuses passes them. Both happened, and both are asserted here.
 */

const TOKEN = "integration-remote-agent-token-xyz";
/** The deployment runs behind an access code, the way an owner locks a hosted app to strangers. */
const ACCESS_CODE = "integration-access-code";

let fixture: FixtureServer;
let app: http.Server;
let appOrigin: string;
let appPosts: string[];
/** A second hosted app, which records what it is asked and answers no scan: enough to show a request was really sent. */
let other: http.Server;
let otherOrigin: string;
let otherPosts: string[];
let cacheRoot: string;
let env: typeof process.env;

/** The node request as a `Request`, so the route handlers run exactly as they do on the hosted app. */
function toRequest(incoming: http.IncomingMessage, body: Buffer): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value === undefined) continue;
    for (const one of Array.isArray(value) ? value : [value]) headers.append(name, one);
  }
  const method = incoming.method ?? "GET";
  return new Request(`https://assets.example.com${incoming.url ?? "/"}`, {
    method,
    headers,
    ...(method === "GET" || method === "HEAD" ? {} : { body: new Uint8Array(body) }),
  });
}

async function send(answer: Response, response: http.ServerResponse): Promise<void> {
  const bytes = Buffer.from(await answer.arrayBuffer());
  response.writeHead(answer.status, Object.fromEntries(answer.headers));
  response.end(bytes);
}

beforeAll(async () => {
  env = { ...process.env };
  fixture = await serveAssetsFixture();
  process.env.AGENT_TOKENS = TOKEN;
  process.env.ACCESS_CODE = ACCESS_CODE;
  appPosts = [];
  app = http.createServer((incoming, response) => {
    if (incoming.method === "POST") appPosts.push((incoming.url ?? "").split("?")[0]);
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      const request = toRequest(incoming, Buffer.concat(chunks));
      const path = (incoming.url ?? "").split("?")[0];
      const answer = path === "/api/v1/scan" ? POST(request) : path === "/api/asset" ? handleAssetRequest(request) : null;
      if (!answer) {
        response.writeHead(404).end();
        return;
      }
      void answer.then((result) => send(result, response)).catch(() => response.writeHead(500).end());
    });
  });
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  appOrigin = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;

  otherPosts = [];
  other = http.createServer((incoming, response) => {
    incoming.resume();
    otherPosts.push(`${incoming.method} ${(incoming.url ?? "").split("?")[0]}`);
    response.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: "unavailable", message: "this app is down" } }));
  });
  await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
  otherOrigin = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;

  // The scan cache is on disk and shared by every caller, so these tests get one of their own.
  cacheRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "remote-source-")));
  process.env.XDG_CACHE_HOME = cacheRoot;
}, 60_000);

afterAll(async () => {
  for (const server of [app, other]) {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  }
  await fixture?.close();
  if (cacheRoot) fs.rmSync(cacheRoot, { recursive: true, force: true });
  process.env = env;
});

const source = (deps: { fetch?: SafeFetch } = {}) => createRemoteScanSource({ remote: appOrigin, token: TOKEN, accessCode: ACCESS_CODE }, deps);

describe("the remote source against the hosted app", () => {
  /**
   * The app asks a token holder for the access code too (spec section 8), and the client had no way to send it, so
   * turning ACCESS_CODE on locked every remote CLI and MCP scan out. Every scan in this file now goes through it.
   */
  it("is refused by a deployment behind an access code until it sends the code", async () => {
    const before = appPosts.length;
    const refused = await createRemoteScanSource({ remote: appOrigin, token: TOKEN, accessCode: "" })
      .scan(`${fixture.origin}/`)
      .then(() => null, (error: unknown) => error as RemoteScanError);

    expect(refused).toMatchObject({ name: "RemoteScanError", code: "unauthorized", status: 401 });
    expect(refused?.message).toContain("x-access-code");
    expect(appPosts.slice(before)).toEqual(["/api/v1/scan"]);
  }, 30_000);

  it("reads the document POST /api/v1/scan actually answers", async () => {
    const scan = await source().scan(`${fixture.origin}/`);

    expect(scan.source).toBe("remote");
    expect(scan.page.host).toBe("127.0.0.1");
    expect(scan.assets.length).toBeGreaterThan(0);
    expect(scan.fonts.map((family) => family.name)).toContain("Inter");
    expect(scan.stats.assets).toBe(scan.assets.length);
    expect(scan.scanId).toMatch(/^[A-Za-z0-9._-]{1,120}$/);
  }, 150_000);

  /**
   * The cache scoping against a real server rather than an in-memory fake: a warm local scan of the same page must not
   * answer a remote run, and a scan of this hosted app must not answer a run pointed at another one. The fakes in
   * `src/agent/cli.test.ts` assert a constant `kind`; only a server can show that the request was really sent.
   */
  it("asks the hosted app even when a local scan of the same page is warm, and never answers another app from it", async () => {
    const url = `${fixture.origin}/`;
    const page = { url, finalUrl: url, host: "127.0.0.1", title: "Fixture" };
    await saveScan(testScan({ scanId: "warm-local-scan", source: "local", scannedAt: new Date().toISOString(), page }));
    const before = appPosts.length;

    const first = await scanPage(url, source(), {});

    expect(first.reused).toBe(false);
    expect(first.scan.source).toBe("remote");
    expect(first.scan.remote).toBe(appOrigin);
    expect(first.scan.scanId).not.toBe("warm-local-scan");
    expect(appPosts.slice(before)).toEqual(["/api/v1/scan"]);

    // The remote answer is cached for this hosted app, so a second run of the same URL sends nothing
    const second = await scanPage(url, source(), {});
    expect(second).toMatchObject({ reused: true, scan: { scanId: first.scan.scanId } });
    expect(appPosts).toHaveLength(before + 1);

    // A run pointed at a different hosted app reaches that app, and fails on its answer rather than reusing this one
    const elsewhere = createRemoteScanSource({ remote: otherOrigin, token: TOKEN });
    await expect(scanPage(url, elsewhere, {})).rejects.toBeInstanceOf(RemoteScanError);
    expect(otherPosts).toEqual(["POST /api/v1/scan"]);
  }, 150_000);

  it("gets the bytes of an http asset through the hosted proxy, which the agent token opens", async () => {
    const url = `${fixture.origin}/assets/photo-large.png`;
    const proxy = createSigner().sign(url);
    // The direct fetch is never tried for an `http:` URL, so this is the proxy path and nothing else.
    const refuse: SafeFetch = () => Promise.reject(new Error("the direct fetch must not be used here"));

    const bytes = await source({ fetch: refuse }).fetchBytes({ url, proxy, format: "png" });

    expect(bytes.subarray(0, 8)).toEqual(Buffer.from("\x89PNG\r\n\x1a\n", "latin1"));
  }, 30_000);

  it("still refuses the proxy to a caller with no token and no same-origin header", async () => {
    const url = `${fixture.origin}/assets/photo-large.png`;
    const response = await fetch(`${appOrigin}${createSigner().sign(url)}`);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "cross-site" } });
  }, 30_000);
});
