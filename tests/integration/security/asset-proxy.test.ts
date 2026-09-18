import { readFileSync } from "node:fs";
import type http from "node:http";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { serveFixture, type FixtureServer } from "../../fixtures/serve";

const fonts = vi.hoisted(() => ({
  parseFontBinary: vi.fn((buffer: Buffer) => ({ format: ({ wOF2: "woff2", OTTO: "otf", "\0\x01\0\0": "ttf" } as Record<string, string>)[buffer.subarray(0, 4).toString("latin1")] ?? "other" })),
  isConvertibleFont: vi.fn(async () => true),
}));
vi.mock("@/server/scan/fonts/index", () => fonts);
const functions = vi.hoisted(() => ({ waitUntil: vi.fn() }));
vi.mock("@vercel/functions", async (importOriginal) => ({ ...(await importOriginal<typeof import("@vercel/functions")>()), waitUntil: functions.waitUntil }));

import { handleAssetRequest } from "@/server/security/asset-proxy";
import { MemoryBudgetStore, setBudgetStoreForTests, takeProxyBytes } from "@/server/security/budget";
import { createSigner } from "@/server/security/sign";

const SITE = path.join(import.meta.dirname, "../../fixtures/site");
const png = readFileSync(path.join(SITE, "assets/bg.png"));
const jpg = readFileSync(path.join(SITE, "assets/hero.jpg"));
const gif = readFileSync(path.join(SITE, "assets/pixel.gif"));
const woff2 = readFileSync(path.join(SITE, "assets/__inter.woff2"));
const CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; sandbox";
const MiB = 1024 * 1024;

/** An upstream that streams `total` bytes in 64 KiB chunks, with a `content-length` only when `sized`. */
function streamed(total: number, { sized = false, cutAfter }: { sized?: boolean; cutAfter?: number } = {}): http.RequestListener {
  return (_q, s) => {
    s.writeHead(200, { "content-type": "image/png", ...(sized && { "content-length": String(total) }) });
    let sent = 0;
    const pump = () => {
      while (sent < total) {
        if (cutAfter !== undefined && sent >= cutAfter) {
          s.destroy();
          return;
        }
        const size = Math.min(64 * 1024, total - sent);
        sent += size;
        if (!s.write(Buffer.alloc(size))) {
          s.once("drain", pump);
          return;
        }
      }
      s.end();
    };
    pump();
  };
}

const MAGIC: Record<string, [string, Buffer]> = {
  png: ["image/png", png],
  jpeg: ["image/jpeg", jpg],
  gif: ["image/gif", gif],
  webp: ["image/webp", Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 "), Buffer.alloc(16)])],
  avif: ["image/avif", Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from("ftypavif"), Buffer.alloc(16)])],
  "avif-compatible": ["image/avif", Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from("ftypmif1"), Buffer.alloc(4), Buffer.from("mif1avif"), Buffer.alloc(8)])],
  ico: ["image/x-icon", Buffer.concat([Buffer.from([0, 0, 1, 0, 1, 0]), Buffer.alloc(16)])],
  woff: ["font/woff", Buffer.concat([Buffer.from("wOFF"), Buffer.alloc(16)])],
  woff2: ["font/woff2", woff2],
  ttf: ["font/ttf", Buffer.concat([Buffer.from([0, 1, 0, 0]), Buffer.alloc(16)])],
  otf: ["font/otf", Buffer.concat([Buffer.from("OTTO"), Buffer.alloc(16)])],
  svg: ["image/svg+xml", Buffer.from('\uFEFF<?xml version="1.0"?>\n<!-- logo -->\n<!DOCTYPE svg>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>')],
  "svg-comments": ["image/svg+xml", Buffer.from(`${"<!---->".repeat(80)}<svg xmlns="http://www.w3.org/2000/svg"></svg>`)],
};
/** Untyped text that made the former SVG pattern backtrack for seconds (exponential in the comment count). */
const COMMENTS = `${"<!---->".repeat(24)}<html></html>`;

let upstream: FixtureServer;
let victim: FixtureServer;
let victimHits = 0;
const hits = new Map<string, number>();

beforeAll(async () => {
  victim = await serveFixture({ "/secret.png": (_q, s) => { victimHits++; s.end("SECRET"); } });
  const routes: Parameters<typeof serveFixture>[0] = {
    "/page.html": (_q, s) => { s.writeHead(200, { "content-type": "text/html; charset=utf-8" }); s.end("<!doctype html><script>alert(1)</script>"); },
    "/octet-text": (_q, s) => { s.writeHead(200, { "content-type": "application/octet-stream" }); s.end("<html><body>not an image</body></html>"); },
    "/octet-comments": (_q, s) => { s.writeHead(200, { "content-type": "application/octet-stream" }); s.end(COMMENTS); },
    "/no-type": (_q, s) => { s.writeHead(200); s.end(png); },
    "/declared-big": (_q, s) => { s.writeHead(200, { "content-type": "image/png", "content-length": String(4096) }); s.end(Buffer.alloc(4096)); },
    "/chunked-big": (_q, s) => { s.writeHead(200, { "content-type": "image/png" }); s.write(png); s.end(Buffer.alloc(4096)); },
    "/chunked-big-untyped": (_q, s) => { s.writeHead(200, { "content-type": "application/octet-stream" }); s.write(png); s.end(Buffer.alloc(4096)); },
    "/counted.png": (q, s) => { hits.set(q.url ?? "", (hits.get(q.url ?? "") ?? 0) + 1); s.writeHead(200, { "content-type": "image/png" }); s.end(png); },
    "/dl-counted.png": (q, s) => { hits.set("/dl-counted.png", (hits.get("/dl-counted.png") ?? 0) + 1); s.writeHead(200, { "content-type": "image/png" }); s.end(png); },
    // a typed image that sends its first bytes, then nothing for a long time
    "/png-slow": (_q, s) => { s.writeHead(200, { "content-type": "image/png" }); s.write(png.subarray(0, 64)); },
    "/big.woff2": (_q, s) => {
      s.writeHead(200, { "content-type": "font/woff2" });
      s.write(woff2.subarray(0, 64));
      for (let i = 0; i < 11; i++) s.write(Buffer.alloc(1024 * 1024));
      s.end();
    },
    "/woff2-stall": (_q, s) => { s.writeHead(200, { "content-type": "font/woff2" }); s.write(woff2.subarray(0, 64)); },
    "/woff2-truncated": (_q, s) => { s.writeHead(200, { "content-type": "font/woff2" }); s.end(woff2.subarray(0, 64)); },
    "/chunked-late": (_q, s) => {
      s.writeHead(200, { "content-type": "image/png" });
      s.write(Buffer.concat([png.subarray(0, 8), Buffer.alloc(4088)]));
      setTimeout(() => s.end(Buffer.alloc(8192)), 100);
    },
    "/missing.png": (_q, s) => { s.writeHead(404, { "content-type": "image/png" }); s.end(); },
    "/redirect-private": (_q, s) => { s.writeHead(302, { location: `${victim.origin}/secret.png` }); s.end(); },
    "/sized.png": (_q, s) => { s.writeHead(200, { "content-type": "image/png", "content-length": String(png.length) }); s.end(png); },
    "/not-a-png": (_q, s) => { s.writeHead(200, { "content-type": "image/png" }); s.end("MZ\x90\x00 this is not a png"); },
    "/png-then-stall": (_q, s) => { s.writeHead(200, { "content-type": "font/woff2" }); s.write(png.subarray(0, 64)); },
    "/chunked-2mib": streamed(2 * MiB),
    "/chunked-cut": streamed(2 * MiB, { cutAfter: 256 * 1024 }),
    "/sized-2mib": streamed(2 * MiB, { sized: true }),
    "/referer": (q, s) => { s.writeHead(200, { "content-type": "image/svg+xml" }); s.end(`<svg xmlns="http://www.w3.org/2000/svg"><title>${q.headers.referer}</title></svg>`); },
  };
  for (const [name, [, bytes]] of Object.entries(MAGIC)) {
    routes[`/magic/${name}`] = (_q, s) => { s.writeHead(200, { "content-type": "application/octet-stream" }); s.end(bytes); };
  }
  upstream = await serveFixture(routes);
  process.env.SCAN_TEST_ALLOW_HOSTS = upstream.host;
});

afterAll(async () => {
  delete process.env.SCAN_TEST_ALLOW_HOSTS;
  await upstream.close();
  await victim.close();
});

beforeEach(() => {
  setBudgetStoreForTests(new MemoryBudgetStore());
  functions.waitUntil.mockClear();
  fonts.parseFontBinary.mockClear();
  fonts.isConvertibleFont.mockClear();
  fonts.isConvertibleFont.mockResolvedValue(true);
});

afterEach(() => {
  setBudgetStoreForTests(null);
  vi.unstubAllEnvs();
});

const SAME_ORIGIN = { "sec-fetch-site": "same-origin" };

/** Today's proxied bytes in `store`. */
const spentIn = (store: MemoryBudgetStore) => store.incr(`proxy:d:${new Date().toISOString().slice(0, 10)}`, 0, 60);

/**
 * A request for the signed proxy path of an upstream asset, from this app's own pages unless `site` says otherwise.
 * A `dl` in `extra` goes through the signer, since the download name is part of the MAC.
 */
function proxied(assetPath: string, extra = "", site: string | null = "same-origin"): Request {
  const params = new URLSearchParams(extra.replace(/^&/, ""));
  const dl = params.get("dl");
  params.delete("dl");
  const signed = createSigner().sign(`${upstream.origin}${assetPath}`, dl ?? undefined);
  const rest = params.toString();
  return new Request(`https://app.local${signed}${rest ? `&${rest}` : ""}`, { headers: site === null ? {} : { "sec-fetch-site": site } });
}

/** Reads a whole body and returns how many bytes arrived before it ended or failed; 0 for a response that is not 200. */
async function bytesServed(response: Response): Promise<number> {
  if (response.status !== 200) {
    await response.body?.cancel();
    return 0;
  }
  const reader = response.body!.getReader();
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return size;
      size += value.byteLength;
    }
  } catch {
    return size;
  }
}

async function errorOf(response: Response): Promise<{ status: number; code: string }> {
  expect(response.headers.get("content-security-policy")).toBe(CSP);
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("vercel-cdn-cache-control")).toBeNull();
  const body = (await response.json()) as { error: { code: string } };
  return { status: response.status, code: body.error.code };
}

describe("handleAssetRequest", () => {
  it("streams a signed asset with the safety and cache headers", async () => {
    const response = await handleAssetRequest(proxied("/assets/logo.svg"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(response.headers.get("content-security-policy")).toBe(CSP);
    expect(response.headers.get("vercel-cdn-cache-control")).toBe("public, s-maxage=86400");
    expect(response.headers.get("cache-control")).toBe("private, max-age=3600");
    expect(response.headers.get("vary")).toBe("Sec-Fetch-Site");
    expect(response.headers.get("content-disposition")).toBe("inline");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(readFileSync(path.join(SITE, "assets/logo.svg")));

    const sized = await handleAssetRequest(proxied("/sized.png", "", "none"));
    expect(sized.status).toBe(200);
    expect(sized.headers.get("content-length")).toBe(String(png.length));
    expect(Buffer.from(await sized.arrayBuffer())).toEqual(png);
  });

  it("refuses HEAD and other methods without fetching the upstream", async () => {
    for (const method of ["HEAD", "POST"]) {
      const signed = proxied("/counted.png");
      const response = await handleAssetRequest(new Request(signed.url, { method, headers: SAME_ORIGIN }));
      expect(await errorOf(response), method).toMatchObject({ status: 405, code: "method" });
      expect(response.headers.get("allow")).toBe("GET");
    }
    expect(hits.get("/counted.png")).toBeUndefined();
    expect((await handleAssetRequest(proxied("/counted.png"))).status).toBe(200);
    expect(hits.get("/counted.png")).toBe(1);
  });

  it("sends the headers of a typed asset without waiting for a sniffing prefix", async () => {
    const start = performance.now();
    const response = await handleAssetRequest(proxied("/png-slow"), { timeoutMs: 10_000 });
    expect(performance.now() - start).toBeLessThan(5_000);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(Buffer.from(first.value!)).toEqual(png.subarray(0, 64));
    await reader.cancel();
  });

  it("refuses cross-site, same-site and header-less requests", async () => {
    expect(await errorOf(await handleAssetRequest(proxied("/assets/logo.svg", "", "cross-site")))).toMatchObject({ status: 403 });
    const sameSite = await handleAssetRequest(proxied("/assets/logo.svg", "", "same-site"));
    expect(sameSite.status).toBe(403);
    expect(sameSite.headers.get("vary")).toBe("Sec-Fetch-Site");
    // spec 11.2: same-origin or none only, so scripts and old clients without Fetch Metadata are refused too
    expect(await errorOf(await handleAssetRequest(proxied("/assets/logo.svg", "", null)))).toMatchObject({ status: 403, code: "cross-site" });
    expect(await errorOf(await handleAssetRequest(proxied("/assets/logo.svg", "", "")))).toMatchObject({ status: 403 });
  });

  it("checks the signature and params", async () => {
    const bad = proxied("/assets/logo.svg").url.replace(/s=[^&]+/, `s=${"A".repeat(32)}`);
    expect(await errorOf(await handleAssetRequest(new Request(bad, { headers: SAME_ORIGIN })))).toMatchObject({ status: 403, code: "bad-signature" });
    expect(await errorOf(await handleAssetRequest(proxied("/assets/logo.svg", "&x=1")))).toMatchObject({ status: 400 });
    expect(await errorOf(await handleAssetRequest(new Request("https://app.local/api/asset", { headers: SAME_ORIGIN })))).toMatchObject({ status: 400 });
  });

  it("refuses HTML and unknown bytes", async () => {
    expect(await errorOf(await handleAssetRequest(proxied("/page.html")))).toMatchObject({ status: 415 });
    expect(await errorOf(await handleAssetRequest(proxied("/octet-text")))).toMatchObject({ status: 415 });
  });

  it("sniffs comment-heavy untyped text in linear time, streamed or buffered for fmt=ttf", async () => {
    for (const extra of ["", "&fmt=ttf"]) {
      const start = performance.now();
      expect(await errorOf(await handleAssetRequest(proxied("/octet-comments", extra)))).toMatchObject({ status: 415 });
      expect(performance.now() - start, extra).toBeLessThan(1_000);
    }
  });

  it("serves octet-stream and untyped bytes by their magic bytes", async () => {
    const response = await handleAssetRequest(proxied("/no-type"));
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
    for (const [name, [type, bytes]] of Object.entries(MAGIC)) {
      const sniffed = await handleAssetRequest(proxied(`/magic/${name}`));
      expect(sniffed.status, name).toBe(200);
      expect(sniffed.headers.get("content-type"), name).toBe(type);
      expect(Buffer.from(await sniffed.arrayBuffer()), name).toEqual(bytes);
    }
  });

  it("answers 413 above the size cap", async () => {
    expect(await errorOf(await handleAssetRequest(proxied("/declared-big"), { maxBytes: 1024 }))).toMatchObject({ status: 413 });
    // an untyped body is sniffed first, so a cap crossed within the sniffed prefix still gets a status
    expect(await errorOf(await handleAssetRequest(proxied("/chunked-big-untyped"), { maxBytes: 1024 }))).toMatchObject({ status: 413 });
    // a typed body of unknown length streams at once, so the status is already sent and the body errors instead
    for (const [path, maxBytes] of [["/chunked-big", 1024], ["/chunked-late", 8192]] as const) {
      const streamed = await handleAssetRequest(proxied(path), { maxBytes });
      expect(streamed.status, path).toBe(200);
      await expect(streamed.arrayBuffer(), path).rejects.toThrow();
    }
  });

  it("refuses a swapped download name, so dl cannot bust the CDN cache", async () => {
    // dl is part of the request URL and therefore part of the cache key: unsigned, every name is a fresh miss, a
    // fresh invocation and a fresh upstream fetch on one signature.
    const signed = proxied("/dl-counted.png", "&dl=logo.png");
    expect((await handleAssetRequest(signed)).status).toBe(200);
    for (const name of ["a1", "a2", "a3"]) {
      const busted = new URL(signed.url);
      busted.searchParams.set("dl", name);
      const response = await handleAssetRequest(new Request(busted, { headers: SAME_ORIGIN }));
      expect(await errorOf(response), name).toMatchObject({ status: 403, code: "bad-signature" });
    }
    expect(hits.get("/dl-counted.png")).toBe(1);
  });

  it("sanitizes the download name", async () => {
    const response = await handleAssetRequest(proxied("/assets/logo.svg", "&dl=../../x.svg"));
    expect(response.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''x.svg");
    const tricky = await handleAssetRequest(proxied("/assets/logo.svg", `&dl=${encodeURIComponent("..\\Logo (dark)\u202Egvs.exe'\n.svg")}`));
    expect(tricky.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''Logo%20%28dark%29gvs.exe%27.svg");
    const dots = await handleAssetRequest(proxied("/assets/logo.svg", "&dl=.."));
    expect(dots.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''download.svg");
    const emoji = await handleAssetRequest(proxied("/assets/logo.svg", `&dl=${encodeURIComponent(`${"a".repeat(199)}\u{1F600}.svg`)}`));
    expect(emoji.status).toBe(200);
    expect(emoji.headers.get("content-disposition")).toBe(`attachment; filename*=UTF-8''${"a".repeat(199)}%F0%9F%98%80.svg`);
  });

  it("names a download after the served type, whatever extension the unsigned name asks for", async () => {
    // a signed image URL shared as an app link must not save its bytes as an executable
    const response = await handleAssetRequest(proxied("/not-a-png", "&dl=Invoice.exe", "none"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''Invoice.png");
    await response.arrayBuffer();
    const sniffed = await handleAssetRequest(proxied("/magic/webp", "&dl=hero.png"));
    expect(sniffed.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''hero.webp");
    await sniffed.arrayBuffer();
  });

  it("decompresses an open-licence WOFF2 to its sfnt, labelled by outline format, and refuses other sources", async () => {
    const ttf = await handleAssetRequest(proxied("/assets/__inter.woff2", "&fmt=ttf&dl=inter.ttf"));
    expect(ttf.status).toBe(200);
    expect(ttf.headers.get("content-type")).toBe("font/ttf");
    expect(ttf.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''inter.ttf");
    const bytes = Buffer.from(await ttf.arrayBuffer());
    expect(bytes.subarray(0, 4).toString("hex")).toBe("00010000");
    expect(ttf.headers.get("content-length")).toBe(String(bytes.length));
    // the licence is read from the decompressed sfnt
    expect(fonts.isConvertibleFont).toHaveBeenCalledWith({ format: "ttf" }, expect.objectContaining({ fetch: expect.any(Function), signal: expect.any(AbortSignal) }));

    const otf = await handleAssetRequest(proxied("/assets/ss3.woff2", "&fmt=ttf&dl=ss3.ttf"));
    expect(otf.headers.get("content-type")).toBe("font/otf");
    expect(otf.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''ss3.otf");
    expect(Buffer.from(await otf.arrayBuffer()).subarray(0, 4).toString("latin1")).toBe("OTTO");

    fonts.isConvertibleFont.mockResolvedValue(false);
    expect(await errorOf(await handleAssetRequest(proxied("/assets/__inter.woff2", "&fmt=ttf")))).toMatchObject({ status: 403 });
    fonts.isConvertibleFont.mockResolvedValue(true);
    for (const source of ["/assets/bg.png", "/magic/ttf", "/magic/otf", "/magic/woff"]) {
      expect(await errorOf(await handleAssetRequest(proxied(source, "&fmt=ttf"))), source).toMatchObject({ status: 415, code: "not-convertible" });
    }
    expect(fonts.isConvertibleFont).toHaveBeenCalledTimes(3);
    // the first bytes decide: a source that is not WOFF2 is refused without waiting for the rest of its body
    const start = performance.now();
    expect(await errorOf(await handleAssetRequest(proxied("/png-then-stall", "&fmt=ttf"), { timeoutMs: 10_000 }))).toMatchObject({ status: 415, code: "not-convertible" });
    expect(performance.now() - start).toBeLessThan(5_000);
    expect(await errorOf(await handleAssetRequest(proxied("/assets/__inter.woff2", "&fmt=ttf"), { maxBytes: 1024 }))).toMatchObject({ status: 413 });
  });

  it("caps font conversion sources at 10 MB, below the proxy cap", async () => {
    expect(await errorOf(await handleAssetRequest(proxied("/big.woff2", "&fmt=ttf")))).toMatchObject({ status: 413, code: "too-large" });
    // the same bytes without conversion are within the 25 MB proxy cap
    const plain = await handleAssetRequest(proxied("/big.woff2"));
    expect(plain.status).toBe(200);
    expect((await plain.arrayBuffer()).byteLength).toBe(64 + 11 * 1024 * 1024);
  });

  it("runs at most two conversions at once and answers 503 when no slot frees in time", async () => {
    const holders = [new AbortController(), new AbortController()];
    const held = holders.map((controller) => {
      const request = proxied("/woff2-stall", "&fmt=ttf");
      return handleAssetRequest(new Request(request.url, { headers: SAME_ORIGIN, signal: controller.signal }), { timeoutMs: 60_000 });
    });
    try {
      // a conversion that gets a slot before both holders do still succeeds, so retry until both slots are taken
      await vi.waitFor(async () => {
        const response = await handleAssetRequest(proxied("/assets/__inter.woff2", "&fmt=ttf"), { timeoutMs: 300 });
        expect(await errorOf(response)).toMatchObject({ status: 503, code: "busy" });
        expect(response.headers.get("retry-after")).toBe("5");
      }, { timeout: 10_000, interval: 50 });
      // a waiter takes the first slot that frees
      const waiting = handleAssetRequest(proxied("/assets/__inter.woff2", "&fmt=ttf"), { timeoutMs: 10_000 });
      holders[0].abort();
      expect((await waiting).status).toBe(200);
    } finally {
      for (const controller of holders) controller.abort();
      await Promise.all(held);
    }
    expect((await handleAssetRequest(proxied("/assets/__inter.woff2", "&fmt=ttf"))).status).toBe(200);
  });

  it("frees conversion slots when the licence check outlasts the proxy timeout", async () => {
    fonts.isConvertibleFont.mockImplementation(() => new Promise(() => {}));
    const start = performance.now();
    // both slots are held by checks that never answer
    const stuck = await Promise.all([0, 1].map(() => handleAssetRequest(proxied("/assets/__inter.woff2", "&fmt=ttf"), { timeoutMs: 1_000 })));
    for (const response of stuck) expect(await errorOf(response)).toMatchObject({ status: 504, code: "timeout" });
    expect(performance.now() - start).toBeLessThan(5_000);
    fonts.isConvertibleFont.mockResolvedValue(true);
    expect((await handleAssetRequest(proxied("/assets/__inter.woff2", "&fmt=ttf"), { timeoutMs: 1_000 })).status).toBe(200);
  });

  it("answers 429 once the daily proxied bytes are spent", async () => {
    vi.stubEnv("PROXY_BYTES_PER_DAY", String(png.length + 10));
    // a refused take is not counted: 4 KB do not fit, the PNG still does
    expect(await errorOf(await handleAssetRequest(proxied("/declared-big")))).toMatchObject({ status: 429, code: "budget" });
    expect((await handleAssetRequest(proxied("/sized.png"))).status).toBe(200);
    expect(await errorOf(await handleAssetRequest(proxied("/sized.png")))).toMatchObject({ status: 429 });

    // a body of unknown length needs a whole block before its status: the last block of the day serves known lengths only
    const store = new MemoryBudgetStore();
    setBudgetStoreForTests(store);
    vi.stubEnv("PROXY_BYTES_PER_DAY", String(MiB));
    const chunked = await handleAssetRequest(proxied("/assets/bg.png"));
    expect(Buffer.from(await chunked.arrayBuffer())).toEqual(png);
    await vi.waitFor(async () => expect(await spentIn(store)).toBe(png.length));
    expect(await errorOf(await handleAssetRequest(proxied("/assets/logo.svg")))).toMatchObject({ status: 429, code: "budget" });
    expect((await handleAssetRequest(proxied("/sized.png"))).status).toBe(200);
    expect(await takeProxyBytes(0)).toBe(true);
  });

  it("keeps concurrent bodies of unknown length within the daily budget plus one block each", async () => {
    // the upstream is the attacker's: chunked bodies skip the up-front take a content-length gets
    const budget = 3 * MiB;
    vi.stubEnv("PROXY_BYTES_PER_DAY", String(budget));
    const store = new MemoryBudgetStore();
    setBudgetStoreForTests(store);
    const responses = await Promise.all(Array.from({ length: 10 }, () => handleAssetRequest(proxied("/chunked-2mib"))));
    const served = await Promise.all(responses.map(bytesServed));
    const total = served.reduce((sum, size) => sum + size, 0);
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThanOrEqual(budget + 10 * MiB);
    expect(served.filter((size) => size === 2 * MiB).length).toBeLessThan(10);
    // refused blocks and the unserved part of the last block of each body are handed back
    await vi.waitFor(async () => expect(await spentIn(store)).toBe(total));
  });

  it("hands back reserved bytes a body did not serve when it ends, fails or is cancelled, after the response", async () => {
    const store = new MemoryBudgetStore();
    setBudgetStoreForTests(store);
    let expected = 0;
    const settled = async (bytes: number) => {
      expected += bytes;
      await vi.waitFor(async () => expect(await spentIn(store)).toBe(expected));
      // accounting that runs once the response is out is kept alive past it on Vercel
      expect(functions.waitUntil).toHaveBeenCalledTimes(1);
      expect(functions.waitUntil).toHaveBeenCalledWith(expect.any(Promise));
      functions.waitUntil.mockClear();
    };

    await settled(await bytesServed(await handleAssetRequest(proxied("/chunked-2mib"))));
    const failed = await bytesServed(await handleAssetRequest(proxied("/chunked-cut")));
    expect(failed).toBeLessThan(2 * MiB);
    await settled(failed);

    for (const source of ["/chunked-2mib", "/sized-2mib"]) {
      const reader = (await handleAssetRequest(proxied(source))).body!.getReader();
      const first = await reader.read();
      await reader.cancel();
      await settled(first.value!.byteLength);
    }
  });

  it("counts every source byte a conversion downloads, whatever the outcome", async () => {
    const store = new MemoryBudgetStore();
    setBudgetStoreForTests(store);
    fonts.isConvertibleFont.mockResolvedValue(false);
    expect(await errorOf(await handleAssetRequest(proxied("/assets/__inter.woff2", "&fmt=ttf")))).toMatchObject({ status: 403, code: "license" });
    expect(await spentIn(store)).toBe(woff2.length);
    fonts.isConvertibleFont.mockResolvedValue(true);
    expect(await errorOf(await handleAssetRequest(proxied("/woff2-truncated", "&fmt=ttf")))).toMatchObject({ status: 415, code: "not-convertible" });
    expect(await spentIn(store)).toBe(woff2.length + 64);
    // a source over the cap is counted up to where its download stopped
    expect(await errorOf(await handleAssetRequest(proxied("/big.woff2", "&fmt=ttf")))).toMatchObject({ status: 413, code: "too-large" });
    const overCap = (await spentIn(store)) - woff2.length - 64;
    expect(overCap).toBeGreaterThan(9 * 1024 * 1024);
    expect(overCap).toBeLessThanOrEqual(10 * 1024 * 1024);
    // a served conversion counts its source and its output; the rest of the output reservation is handed back
    const before = await spentIn(store);
    const ttf = await handleAssetRequest(proxied("/assets/__inter.woff2", "&fmt=ttf"));
    expect(ttf.status).toBe(200);
    const served = (await ttf.arrayBuffer()).byteLength;
    expect(await spentIn(store)).toBe(before + woff2.length + served);
  });

  it("stops downloading a conversion source once the budget refuses its next block", async () => {
    vi.stubEnv("PROXY_BYTES_PER_DAY", String(2 * MiB));
    const store = new MemoryBudgetStore();
    setBudgetStoreForTests(store);
    expect(await errorOf(await handleAssetRequest(proxied("/big.woff2", "&fmt=ttf")))).toMatchObject({ status: 429, code: "budget" });
    expect(fonts.isConvertibleFont).not.toHaveBeenCalled();
    const spent = await spentIn(store);
    expect(spent).toBeGreaterThan(0);
    expect(spent).toBeLessThanOrEqual(2 * MiB);
  });

  it("converts only once the budget covers the largest output woff2 can return", async () => {
    vi.stubEnv("PROXY_BYTES_PER_DAY", String(20 * 1024 * 1024));
    const store = new MemoryBudgetStore();
    setBudgetStoreForTests(store);
    expect(await errorOf(await handleAssetRequest(proxied("/assets/__inter.woff2", "&fmt=ttf")))).toMatchObject({ status: 429, code: "budget" });
    expect(fonts.parseFontBinary).not.toHaveBeenCalled();
    expect(fonts.isConvertibleFont).not.toHaveBeenCalled();
    // the source stays counted, the refused reservation does not
    expect(await spentIn(store)).toBe(woff2.length);
    expect((await handleAssetRequest(proxied("/sized.png"))).status).toBe(200);
  });

  it("maps upstream failures and never reaches private addresses", async () => {
    expect(await errorOf(await handleAssetRequest(proxied("/missing.png")))).toMatchObject({ status: 502 });
    expect(await errorOf(await handleAssetRequest(proxied("/redirect-private")))).toMatchObject({ status: 403, code: "blocked-address" });
    const direct = createSigner().sign(`${victim.origin}/secret.png`);
    expect(await errorOf(await handleAssetRequest(new Request(`https://app.local${direct}`, { headers: SAME_ORIGIN })))).toMatchObject({ status: 403, code: "blocked-address" });
    expect(victimHits).toBe(0);
  });

  it("sends the asset origin as Referer", async () => {
    const response = await handleAssetRequest(proxied("/referer"));
    expect(await response.text()).toContain(`<title>${upstream.origin}/</title>`);
  });
});
