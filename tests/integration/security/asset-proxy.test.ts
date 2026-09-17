import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { serveFixture, type FixtureServer } from "../../fixtures/serve";

const fonts = vi.hoisted(() => ({
  parseFontBinary: vi.fn((buffer: Buffer) => ({ format: buffer.subarray(0, 4).toString("latin1") === "wOF2" ? "woff2" : "other" })),
  isConvertibleFont: vi.fn(async () => true),
}));
vi.mock("@/server/scan/fonts/index", () => fonts);

import { handleAssetRequest } from "@/server/security/asset-proxy";
import { MemoryBudgetStore, setBudgetStoreForTests } from "@/server/security/budget";
import { createSigner } from "@/server/security/sign";

const SITE = path.join(import.meta.dirname, "../../fixtures/site");
const png = readFileSync(path.join(SITE, "assets/bg.png"));
const jpg = readFileSync(path.join(SITE, "assets/hero.jpg"));
const gif = readFileSync(path.join(SITE, "assets/pixel.gif"));
const woff2 = readFileSync(path.join(SITE, "assets/__inter.woff2"));
const CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; sandbox";

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

beforeAll(async () => {
  victim = await serveFixture({ "/secret.png": (_q, s) => { victimHits++; s.end("SECRET"); } });
  const routes: Parameters<typeof serveFixture>[0] = {
    "/page.html": (_q, s) => { s.writeHead(200, { "content-type": "text/html; charset=utf-8" }); s.end("<!doctype html><script>alert(1)</script>"); },
    "/octet-text": (_q, s) => { s.writeHead(200, { "content-type": "application/octet-stream" }); s.end("<html><body>not an image</body></html>"); },
    "/octet-comments": (_q, s) => { s.writeHead(200, { "content-type": "application/octet-stream" }); s.end(COMMENTS); },
    "/no-type": (_q, s) => { s.writeHead(200); s.end(png); },
    "/declared-big": (_q, s) => { s.writeHead(200, { "content-type": "image/png", "content-length": String(4096) }); s.end(Buffer.alloc(4096)); },
    "/chunked-big": (_q, s) => { s.writeHead(200, { "content-type": "image/png" }); s.write(png); s.end(Buffer.alloc(4096)); },
    "/chunked-late": (_q, s) => {
      s.writeHead(200, { "content-type": "image/png" });
      s.write(Buffer.concat([png.subarray(0, 8), Buffer.alloc(4088)]));
      setTimeout(() => s.end(Buffer.alloc(8192)), 100);
    },
    "/missing.png": (_q, s) => { s.writeHead(404, { "content-type": "image/png" }); s.end(); },
    "/redirect-private": (_q, s) => { s.writeHead(302, { location: `${victim.origin}/secret.png` }); s.end(); },
    "/sized.png": (_q, s) => { s.writeHead(200, { "content-type": "image/png", "content-length": String(png.length) }); s.end(png); },
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
  fonts.isConvertibleFont.mockClear();
  fonts.isConvertibleFont.mockResolvedValue(true);
});

afterEach(() => {
  setBudgetStoreForTests(null);
  vi.unstubAllEnvs();
});

const SAME_ORIGIN = { "sec-fetch-site": "same-origin" };

/** A request for the signed proxy path of an upstream asset, from this app's own pages unless `site` says otherwise. */
function proxied(assetPath: string, extra = "", site: string | null = "same-origin"): Request {
  const signed = createSigner().sign(`${upstream.origin}${assetPath}`);
  return new Request(`https://app.local${signed}${extra}`, { headers: site === null ? {} : { "sec-fetch-site": site } });
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
    expect(await errorOf(await handleAssetRequest(proxied("/chunked-big"), { maxBytes: 1024 }))).toMatchObject({ status: 413 });
    // past the sniffed head the status is already sent, so the body errors instead
    const late = await handleAssetRequest(proxied("/chunked-late"), { maxBytes: 8192 });
    expect(late.status).toBe(200);
    await expect(late.arrayBuffer()).rejects.toThrow();
  });

  it("sanitizes the download name", async () => {
    const response = await handleAssetRequest(proxied("/assets/logo.svg", "&dl=../../x.svg"));
    expect(response.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''x.svg");
    const tricky = await handleAssetRequest(proxied("/assets/logo.svg", `&dl=${encodeURIComponent("..\\Logo (dark)\u202Egvs.exe'\n.svg")}`));
    expect(tricky.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''Logo%20%28dark%29gvs.exe%27.svg");
    const dots = await handleAssetRequest(proxied("/assets/logo.svg", "&dl=.."));
    expect(dots.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''download");
  });

  it("decompresses an open-licence WOFF2 to its sfnt, labelled by outline format, and refuses other sources", async () => {
    const ttf = await handleAssetRequest(proxied("/assets/__inter.woff2", "&fmt=ttf&dl=inter.ttf"));
    expect(ttf.status).toBe(200);
    expect(ttf.headers.get("content-type")).toBe("font/ttf");
    expect(ttf.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''inter.ttf");
    const bytes = Buffer.from(await ttf.arrayBuffer());
    expect(bytes.subarray(0, 4).toString("hex")).toBe("00010000");
    expect(ttf.headers.get("content-length")).toBe(String(bytes.length));
    expect(fonts.isConvertibleFont).toHaveBeenCalledWith({ format: "woff2" }, expect.objectContaining({ fetch: expect.any(Function), signal: expect.any(AbortSignal) }));

    const otf = await handleAssetRequest(proxied("/assets/ss3.woff2", "&fmt=ttf"));
    expect(otf.headers.get("content-type")).toBe("font/otf");
    expect(Buffer.from(await otf.arrayBuffer()).subarray(0, 4).toString("latin1")).toBe("OTTO");

    fonts.isConvertibleFont.mockResolvedValue(false);
    expect(await errorOf(await handleAssetRequest(proxied("/assets/__inter.woff2", "&fmt=ttf")))).toMatchObject({ status: 403 });
    fonts.isConvertibleFont.mockResolvedValue(true);
    for (const source of ["/assets/bg.png", "/magic/ttf", "/magic/otf", "/magic/woff"]) {
      expect(await errorOf(await handleAssetRequest(proxied(source, "&fmt=ttf"))), source).toMatchObject({ status: 415, code: "not-convertible" });
    }
    expect(fonts.isConvertibleFont).toHaveBeenCalledTimes(3);
    expect(await errorOf(await handleAssetRequest(proxied("/assets/__inter.woff2", "&fmt=ttf"), { maxBytes: 1024 }))).toMatchObject({ status: 413 });
  });

  it("answers 429 once the daily proxied bytes are spent", async () => {
    vi.stubEnv("PROXY_BYTES_PER_DAY", String(png.length + 10));
    // refused requests are not counted: 4 KB and a converted font do not fit, the PNG still does
    expect(await errorOf(await handleAssetRequest(proxied("/declared-big")))).toMatchObject({ status: 429, code: "budget" });
    expect(await errorOf(await handleAssetRequest(proxied("/assets/__inter.woff2", "&fmt=ttf")))).toMatchObject({ status: 429, code: "budget" });
    expect((await handleAssetRequest(proxied("/sized.png"))).status).toBe(200);
    expect(await errorOf(await handleAssetRequest(proxied("/sized.png")))).toMatchObject({ status: 429 });

    setBudgetStoreForTests(new MemoryBudgetStore());
    vi.stubEnv("PROXY_BYTES_PER_DAY", "100");
    const streamed = await handleAssetRequest(proxied("/assets/bg.png"));
    expect(Buffer.from(await streamed.arrayBuffer())).toEqual(png);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await errorOf(await handleAssetRequest(proxied("/assets/logo.svg")))).toMatchObject({ status: 429 });
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
