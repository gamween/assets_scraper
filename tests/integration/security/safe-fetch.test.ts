import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serveFixture, type FixtureServer } from "../../fixtures/serve";
import { safeFetch, SafeFetchError } from "@/server/net/safe-fetch";

let allowed: FixtureServer;
let victim: FixtureServer;
let victimHits = 0;

beforeAll(async () => {
  victim = await serveFixture({ "/secret": (_q, s) => { victimHits++; s.end("SECRET"); } });
  allowed = await serveFixture({
    "/redirect-victim": (_q, s) => { s.writeHead(302, { location: `${victim.origin}/secret` }); s.end(); },
    "/redirect-loop": (_q, s) => { s.writeHead(302, { location: "/redirect-loop" }); s.end(); },
    "/big": (_q, s) => { s.writeHead(200, { "content-type": "application/octet-stream" }); s.end(Buffer.alloc(2 * 1024 * 1024)); },
    "/slow": () => {},
    // extra routes
    "/redirect-chain": (_q, s) => { s.writeHead(301, { location: "/redirect-relative" }); s.end(); },
    "/redirect-relative": (_q, s) => { s.writeHead(307, { location: "echo?x=1" }); s.end(); },
    "/echo": (q, s) => { s.writeHead(200, { "content-type": "application/json" }); s.end(JSON.stringify({ method: q.method, url: q.url, headers: q.headers })); },
    "/redirect-ipv6": (_q, s) => { s.writeHead(302, { location: `http://[::1]:${victim.port}/secret` }); s.end(); },
    "/redirect-zero": (_q, s) => { s.writeHead(302, { location: `http://0.0.0.0:${victim.port}/secret` }); s.end(); },
    "/redirect-localhost": (_q, s) => { s.writeHead(302, { location: `http://localhost:${victim.port}/secret` }); s.end(); },
    "/redirect-decimal": (_q, s) => { s.writeHead(302, { location: `http://2130706433:${victim.port}/secret` }); s.end(); },
    "/redirect-mapped": (_q, s) => { s.writeHead(302, { location: `http://[::ffff:127.0.0.1]:${victim.port}/secret` }); s.end(); },
    "/redirect-file": (_q, s) => { s.writeHead(302, { location: "file:///etc/passwd" }); s.end(); },
    "/redirect-own": (_q, s) => { s.writeHead(302, { location: "https://scraper.example.com/" }); s.end(); },
    "/redirect-port": (_q, s) => { s.writeHead(302, { location: "http://example.com:8080/" }); s.end(); },
    "/trickle": (_q, s) => {
      s.writeHead(200, { "content-type": "image/png" });
      const timer = setInterval(() => s.write("x"), 50);
      s.on("close", () => clearInterval(timer));
    },
    "/declared-large": (_q, s) => { s.writeHead(200, { "content-type": "image/png", "content-length": String(10 * 1024) }); s.end(Buffer.alloc(10 * 1024)); },
  });
  process.env.SCAN_TEST_ALLOW_HOSTS = allowed.host;
});
afterAll(async () => {
  delete process.env.SCAN_TEST_ALLOW_HOSTS;
  delete process.env.APP_HOSTS;
  await allowed.close();
  await victim.close();
});

describe("safeFetch", () => {
  it("fetches an allowed URL", async () => {
    const res = await safeFetch(`${allowed.origin}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Fixture Co");
  });

  it("blocks private addresses directly and through redirects", async () => {
    await expect(safeFetch(`${victim.origin}/secret`)).rejects.toMatchObject({ code: "blocked-address" });
    await expect(safeFetch(`${allowed.origin}/redirect-victim`)).rejects.toMatchObject({ code: "blocked-address" });
    await expect(safeFetch("http://127.0.0.1.nip.io/")).rejects.toBeInstanceOf(SafeFetchError);
    expect(victimHits).toBe(0);
  });

  it("enforces redirects, size and time caps", async () => {
    await expect(safeFetch(`${allowed.origin}/redirect-loop`, { maxRedirects: 3 })).rejects.toMatchObject({ code: "too-many-redirects" });
    const big = await safeFetch(`${allowed.origin}/big`, { maxBytes: 1024 });
    await expect(big.buffer()).rejects.toMatchObject({ code: "too-large" });
    await expect(safeFetch(`${allowed.origin}/slow`, { timeoutMs: 500 })).rejects.toMatchObject({ code: "timeout" });
  });

  it("rejects non-http schemes and odd ports", async () => {
    await expect(safeFetch("file:///etc/passwd")).rejects.toMatchObject({ code: "invalid-url" });
    await expect(safeFetch("http://example.com:8080/")).rejects.toMatchObject({ code: "unsupported-port" });
  });

  it("re-validates every redirect hop against every loopback spelling", async () => {
    for (const path of ["/redirect-ipv6", "/redirect-zero", "/redirect-localhost", "/redirect-decimal", "/redirect-mapped"]) {
      await expect(safeFetch(`${allowed.origin}${path}`), path).rejects.toMatchObject({ code: "blocked-address" });
    }
    await expect(safeFetch(`${allowed.origin}/redirect-file`)).rejects.toMatchObject({ code: "invalid-url" });
    await expect(safeFetch(`${allowed.origin}/redirect-port`)).rejects.toMatchObject({ code: "unsupported-port" });
    process.env.APP_HOSTS = "scraper.example.com";
    await expect(safeFetch(`${allowed.origin}/redirect-own`)).rejects.toMatchObject({ code: "own-host" });
    await expect(safeFetch("https://scraper.example.com./x")).rejects.toMatchObject({ code: "own-host" });
    delete process.env.APP_HOSTS;
    await expect(safeFetch("http://localhost/")).rejects.toMatchObject({ code: "blocked-address" });
    await expect(safeFetch("http://[::ffff:a00:1]/")).rejects.toMatchObject({ code: "blocked-address" });
    await expect(safeFetch("not a url")).rejects.toMatchObject({ code: "invalid-url" });
    expect(victimHits).toBe(0);
  });

  it("follows relative redirects, sends the default user agent and reports the final URL", async () => {
    const res = await safeFetch(`${allowed.origin}/redirect-chain`);
    expect(res.redirected).toBe(true);
    expect(res.url).toBe(`${allowed.origin}/echo?x=1`);
    const body = await res.json<{ headers: Record<string, string> }>();
    expect(body.headers["user-agent"]).toBe("Mozilla/5.0 (compatible; AssetsScraper/1.0; +https://github.com/gamween/assets_scraper)");
    const custom = await safeFetch(`${allowed.origin}/echo`, { method: "HEAD", headers: { "User-Agent": "Custom/1.0" } });
    expect(custom.status).toBe(200);
    expect(custom.redirected).toBe(false);
    expect(custom.headers.get("content-type")).toBe("application/json");
    const echoed = await (await safeFetch(`${allowed.origin}/echo`, { headers: { "User-Agent": "Custom/1.0", Range: "bytes=0-10" } })).json<{ headers: Record<string, string> }>();
    expect(echoed.headers).toMatchObject({ "user-agent": "Custom/1.0", range: "bytes=0-10" });
  });

  it("caps a never-ending body by time and a declared length by size", async () => {
    const trickle = await safeFetch(`${allowed.origin}/trickle`, { timeoutMs: 600 });
    await expect(trickle.buffer()).rejects.toMatchObject({ code: "timeout" });
    const declared = await safeFetch(`${allowed.origin}/declared-large`, { maxBytes: 1024 });
    await expect(declared.text()).rejects.toMatchObject({ code: "too-large" });
    const ok = await safeFetch(`${allowed.origin}/declared-large`, { maxBytes: 10 * 1024 });
    expect((await ok.buffer()).length).toBe(10 * 1024);
  });

  it("reports a caller abort as aborted, not timeout", async () => {
    const controller = new AbortController();
    const pending = safeFetch(`${allowed.origin}/slow`, { signal: controller.signal, timeoutMs: 5_000 });
    setTimeout(() => controller.abort(), 100);
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
    const already = new AbortController();
    already.abort();
    await expect(safeFetch(`${allowed.origin}/`, { signal: already.signal })).rejects.toMatchObject({ code: "aborted" });
  });

  it("maps unreachable hosts to dns and connect", async () => {
    await expect(safeFetch("https://assets-scraper-does-not-exist.invalid/")).rejects.toMatchObject({ code: "dns" });
    const closed = await serveFixture();
    const origin = closed.origin;
    process.env.SCAN_TEST_ALLOW_HOSTS = `${allowed.host},${closed.host}`;
    await closed.close();
    await expect(safeFetch(`${origin}/`, { timeoutMs: 3_000 })).rejects.toMatchObject({ code: "connect" });
    process.env.SCAN_TEST_ALLOW_HOSTS = allowed.host;
  });
});
