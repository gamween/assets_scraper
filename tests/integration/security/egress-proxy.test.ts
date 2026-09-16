import http from "node:http";
import net from "node:net";
import { chromium, type Browser } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { serveFixture, type FixtureServer } from "../../fixtures/serve";
import { startEgressProxy, type EgressProxy } from "@/server/net/egress-proxy";

const CHROME = process.env.CHROME_EXECUTABLE_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** An "internal" service on every loopback address that counts TCP connections and HTTP requests. */
let victim: http.Server;
let victimPort = 0;
let victimConnections = 0;
const victimRequests: string[] = [];

let allowed: FixtureServer;
let attackHtml = "";
const canaryHits: string[] = [];

async function listenVictim(): Promise<void> {
  victim = http.createServer((req, res) => {
    victimRequests.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<title>internal secret</title>");
  });
  victim.on("connection", () => victimConnections++);
  victim.on("upgrade", (req, socket) => { victimRequests.push(`UPGRADE ${req.url}`); socket.destroy(); });
  try {
    await new Promise<void>((resolve, reject) => victim.once("error", reject).listen(0, "::", resolve));
  } catch {
    await new Promise<void>((resolve) => victim.listen(0, "0.0.0.0", resolve));
  }
  victimPort = (victim.address() as net.AddressInfo).port;
}

function attackPage(proxyPort: number): string {
  const v = victimPort;
  const a = allowed.port;
  return `<!doctype html><title>attack</title>
<img src="http://127.0.0.1:${v}/img">
<img src="http://127.0.0.1.nip.io:${v}/nip">
<img src="http://0.0.0.0:${v}/zero">
<img src="http://localhost:${v}/localhost">
<img src="http://2130706433:${v}/decimal">
<img src="http://[::ffff:127.0.0.1]:${v}/mapped">
<img src="https://127.0.0.1:${v}/tls">
<img src="/redirect-victim">
<img src="http://localhost:${a}/canary-localhost">
<img src="http://[::1]:${a}/canary-v6">
<link rel="stylesheet" href="http://127.0.0.1:${v}/css">
<script src="http://127.0.0.1:${v}/script.js"></script>
<iframe src="http://[::1]:${v}/iframe"></iframe>
<script>
  fetch("http://127.0.0.1:${v}/fetch", { mode: "no-cors" }).catch(() => {});
  fetch("http://127.0.0.1:${proxyPort}/proxy-itself", { mode: "no-cors" }).catch(() => {});
  navigator.sendBeacon("http://127.0.0.1:${v}/beacon", "x");
  try { new WebSocket("ws://127.0.0.1:${v}/ws"); } catch {}
  try { new WebSocket("ws://[::1]:${v}/ws6"); } catch {}
  try { new EventSource("http://127.0.0.1:${v}/sse"); } catch {}
  setTimeout(() => { location.href = "http://127.0.0.1:${v}/nav"; }, 500);
</script>`;
}

/** Sends raw bytes to the proxy and resolves with everything it answers before closing or going idle. */
function rawExchange(port: number, request: string, idleMs = 1_500): Promise<string> {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.write(request));
    let data = "";
    const finish = () => { socket.destroy(); resolve(data); };
    socket.setTimeout(idleMs, finish);
    socket.on("data", (chunk) => { data += chunk.toString("latin1"); });
    socket.on("close", finish);
    socket.on("error", finish);
  });
}

/** Opens a CONNECT tunnel and resolves once the proxy answered, keeping the socket open. */
function openTunnel(port: number, target: string): Promise<{ status: string; socket: net.Socket }> {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    socket.once("data", (chunk) => resolve({ status: chunk.toString("latin1").split("\r\n")[0], socket }));
    socket.once("close", () => resolve({ status: "closed", socket }));
    socket.on("error", () => {});
  });
}

function getVia(proxyPort: number, url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string } | "closed"> {
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port: proxyPort, path: url, headers: { host: new URL(url).host, ...headers }, agent: false }, (res) => {
      let body = "";
      res.setEncoding("latin1");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      res.on("error", () => resolve("closed"));
    });
    req.on("error", () => resolve("closed"));
    req.end();
  });
}

beforeAll(async () => {
  await listenVictim();
  allowed = await serveFixture({
    "/redirect-victim": (_q, s) => { s.writeHead(302, { location: `http://127.0.0.1:${victimPort}/redirected` }); s.end(); },
    "/attack.html": (_q, s) => { s.writeHead(200, { "content-type": "text/html" }); s.end(attackHtml); },
    "/control.html": (_q, s) => { s.writeHead(200, { "content-type": "text/html" }); s.end("<!doctype html><title>Control page</title><p>ok</p>"); },
    "/canary-localhost": (q, s) => { canaryHits.push(q.url ?? ""); s.end(); },
    "/canary-v6": (q, s) => { canaryHits.push(q.url ?? ""); s.end(); },
    "/echo": (q, s) => { s.writeHead(200, { "content-type": "application/json", connection: "keep-alive" }); s.end(JSON.stringify(q.headers)); },
    "/big": (_q, s) => { s.writeHead(200, { "content-type": "application/octet-stream" }); s.end(Buffer.alloc(512 * 1024)); },
  });
  process.env.SCAN_TEST_ALLOW_HOSTS = allowed.host;
});

afterAll(async () => {
  delete process.env.SCAN_TEST_ALLOW_HOSTS;
  await allowed.close();
  victim.closeAllConnections();
  await new Promise<void>((resolve) => victim.close(() => resolve()));
});

describe("egress proxy with Chrome", () => {
  let proxy: EgressProxy;
  let browser: Browser;

  beforeAll(async () => {
    proxy = await startEgressProxy();
    attackHtml = attackPage(proxy.port);
    browser = await chromium.launch({
      executablePath: CHROME,
      headless: true,
      args: ["--force-webrtc-ip-handling-policy=disable_non_proxied_udp"],
      proxy: { server: `http://127.0.0.1:${proxy.port}` },
    });
  });

  afterAll(async () => {
    await browser?.close();
    await proxy?.close();
  });

  it("blocks every loopback vector from a page and still loads allowed pages", async () => {
    const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false });
    const page = await context.newPage();
    await page.goto(`${allowed.origin}/attack.html`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3_000);

    expect(victimRequests).toEqual([]);
    expect(victimConnections).toBe(0);
    expect(canaryHits).toEqual([]);
    const stats = proxy.stats();
    expect(stats.blocked).toBeGreaterThan(0);
    expect(stats.blockedHosts).toEqual(expect.arrayContaining(["127.0.0.1", "0.0.0.0", "localhost"]));

    await page.goto(`${allowed.origin}/control.html`);
    expect(await page.title()).toBe("Control page");
    expect(proxy.stats().bytes).toBeGreaterThan(0);
    await context.close();
  });

  it("fails top-level navigations to private addresses, directly and through a redirect", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await expect(page.goto(`http://127.0.0.1:${victimPort}/secret`, { timeout: 10_000 })).rejects.toThrow();
    await expect(page.goto(`${allowed.origin}/redirect-victim`, { timeout: 10_000 })).rejects.toThrow();
    await expect(page.goto(`http://[::1]:${victimPort}/secret`, { timeout: 10_000 })).rejects.toThrow();
    expect(victimRequests).toEqual([]);
    expect(victimConnections).toBe(0);
    await context.close();
  });
});

describe("egress proxy guard", () => {
  let proxy: EgressProxy;

  afterEach(async () => {
    delete process.env.APP_HOSTS;
    await proxy?.close();
  });

  it("refuses private, own and malformed CONNECT targets on allowed ports", async () => {
    proxy = await startEgressProxy();
    process.env.APP_HOSTS = "scraper.example.com";
    const targets = [
      "127.0.0.1:443", "[::1]:443", "localhost:443", "localhost.:80", "2130706433:443", "[::ffff:7f00:1]:443", "[::7f00:1]:443",
      "0.0.0.0:80", "169.254.169.254:80", "10.0.0.1:443", "[fd00::1]:443", "127.0.0.1.nip.io:443", "scraper.example.com:443",
      "example.com", "example.com:22", "[::1:443", "example.com:99999",
    ];
    for (const target of targets) {
      const answer = await rawExchange(proxy.port, `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
      expect(answer, target).toMatch(/^HTTP\/1\.1 403 /);
    }
    const stats = proxy.stats();
    expect(stats.blocked).toBe(targets.length);
    expect(stats.bytes).toBe(0);
    expect(stats.blockedHosts).toEqual(expect.arrayContaining(["127.0.0.1", "[::1]", "localhost", "169.254.169.254", "scraper.example.com"]));
  });

  it("refuses private, own and non-http absolute-form requests without answering", async () => {
    proxy = await startEgressProxy();
    for (const url of ["http://127.0.0.1/", "http://[::1]/", "http://169.254.169.254/latest/meta-data/", "http://localhost/", "http://[::ffff:a9fe:a9fe]/"]) {
      expect(await getVia(proxy.port, url), url).toBe("closed");
    }
    expect(await rawExchange(proxy.port, "GET https://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n")).not.toMatch(/^HTTP\/1\.1 200/);
    expect(await rawExchange(proxy.port, "GET / HTTP/1.1\r\nHost: example.com\r\n\r\n")).not.toMatch(/^HTTP\/1\.1 200/);
    expect(proxy.stats().blocked).toBe(7);
  });

  it("tunnels and forwards to allowed targets, stripping hop-by-hop headers", async () => {
    proxy = await startEgressProxy();
    const tunnel = await openTunnel(proxy.port, allowed.host);
    expect(tunnel.status).toBe("HTTP/1.1 200 Connection Established");
    const reply = await new Promise<string>((resolve) => {
      let data = "";
      tunnel.socket.on("data", (chunk) => { data += chunk.toString(); if (data.includes("Control page")) resolve(data); });
      tunnel.socket.write(`GET /control.html HTTP/1.1\r\nHost: ${allowed.host}\r\nConnection: close\r\n\r\n`);
    });
    expect(reply).toMatch(/^HTTP\/1\.1 200 OK/);
    tunnel.socket.destroy();

    const res = await getVia(proxy.port, `${allowed.origin}/echo?x=1`, {
      "proxy-authorization": "Basic c2VjcmV0",
      "proxy-connection": "keep-alive",
      connection: "x-drop-me",
      "x-drop-me": "1",
      "x-keep": "1",
    });
    expect(res).not.toBe("closed");
    const headers = JSON.parse((res as { body: string }).body) as Record<string, string>;
    expect(headers["x-keep"]).toBe("1");
    expect(headers.host).toBe(allowed.host);
    for (const name of ["proxy-authorization", "proxy-connection", "x-drop-me"]) expect(headers[name], name).toBeUndefined();
    expect(proxy.stats().blocked).toBe(0);
  });

  it("caps concurrent sockets and total bytes", async () => {
    proxy = await startEgressProxy({ maxSockets: 1 });
    const first = await openTunnel(proxy.port, allowed.host);
    expect(first.status).toBe("HTTP/1.1 200 Connection Established");
    expect((await openTunnel(proxy.port, allowed.host)).status).toMatch(/^HTTP\/1\.1 403 /);
    first.socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const again = await openTunnel(proxy.port, allowed.host);
    expect(again.status).toBe("HTTP/1.1 200 Connection Established");
    again.socket.destroy();
    await proxy.close();

    proxy = await startEgressProxy({ maxBytes: 64 * 1024 });
    const big = await getVia(proxy.port, `${allowed.origin}/big`);
    expect(big === "closed" || big.body.length < 512 * 1024).toBe(true);
    expect(proxy.stats().bytes).toBeGreaterThan(64 * 1024);
    expect((await openTunnel(proxy.port, allowed.host)).status).toMatch(/^HTTP\/1\.1 403 /);
  });

  it("closes open tunnels on close", async () => {
    proxy = await startEgressProxy();
    const tunnel = await openTunnel(proxy.port, allowed.host);
    expect(tunnel.status).toBe("HTTP/1.1 200 Connection Established");
    const closed = new Promise<void>((resolve) => tunnel.socket.once("close", () => resolve()));
    await proxy.close();
    await closed;
    expect(tunnel.socket.destroyed).toBe(true);
  });
});
