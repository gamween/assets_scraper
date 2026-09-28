import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRemoteScanSource } from "@/agent/source-remote";
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

let fixture: FixtureServer;
let app: http.Server;
let appOrigin: string;
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
  app = http.createServer((incoming, response) => {
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
}, 60_000);

afterAll(async () => {
  app?.closeAllConnections();
  await new Promise<void>((resolve) => (app ? app.close(() => resolve()) : resolve()));
  await fixture?.close();
  process.env = env;
});

const source = (deps: { fetch?: SafeFetch } = {}) => createRemoteScanSource({ remote: appOrigin, token: TOKEN }, deps);

describe("the remote source against the hosted app", () => {
  it("reads the document POST /api/v1/scan actually answers", async () => {
    const scan = await source().scan(`${fixture.origin}/`);

    expect(scan.source).toBe("remote");
    expect(scan.page.host).toBe("127.0.0.1");
    expect(scan.assets.length).toBeGreaterThan(0);
    expect(scan.fonts.map((family) => family.name)).toContain("Inter");
    expect(scan.stats.assets).toBe(scan.assets.length);
    expect(scan.scanId).toMatch(/^[A-Za-z0-9._-]{1,120}$/);
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
