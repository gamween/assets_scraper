import { readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Asset } from "@/lib/contract";
import { ScanFailure } from "@/server/errors";
import { SafeFetchError } from "@/server/net/safe-fetch";
import { buildFallback, directAsset } from "@/server/scan/fallback";
import { parseHead, preflight } from "@/server/scan/preflight";
import type { SafeFetch } from "@/server/scan/types";
import { serveFixture, type FixtureServer } from "../../fixtures/serve";
import { createFakeFetch, createFakeSigner } from "./helpers";

let fixture: FixtureServer;
let victim: FixtureServer;
let victimHits = 0;
let fetch: ReturnType<typeof createFakeFetch>;

beforeAll(async () => {
  fixture = await serveFixture({
    "/report.pdf": (_req, res) => {
      res.writeHead(200, { "content-type": "application/pdf" });
      res.end("%PDF-1.7 fake");
    },
    "/forbidden": (_req, res) => {
      res.writeHead(403, { "content-type": "text/html" });
      res.end('<html><head><title>Access denied</title><link rel="icon" href="/assets/touch.png"></head></html>');
    },
    "/wall": (_req, res) => {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("error code: 1010");
    },
    "/limited": (_req, res) => {
      res.writeHead(429, { "content-type": "application/json" });
      res.end('{"error":"rate limited"}');
    },
    "/large.html": (_req, res) => {
      const body = Buffer.from(`<!doctype html><html><head><title>Large</title><link rel="icon" href="/large.png"></head><body>${"<p>filler</p>".repeat(2000)}</body></html>`);
      res.writeHead(200, { "content-type": "text/html", "content-length": String(body.length) });
      res.end(body);
    },
    "/shift-jis": (_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=Shift_JIS" });
      // og:site_name "テスト" in Shift_JIS.
      res.end(Buffer.concat([Buffer.from('<html><head><title>Shop</title><meta property="og:site_name" content="'), Buffer.from([0x83, 0x65, 0x83, 0x58, 0x83, 0x67]), Buffer.from('"></head></html>')]));
    },
    "/gone": (_req, res) => {
      res.writeHead(404, { "content-type": "text/html" });
      res.end("<title>Not found</title>");
    },
    "/trickle": (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.write("<html><head><title>Trickle</title></head>");
      const timer = setInterval(() => res.write(" "), 100);
      res.on("close", () => clearInterval(timer));
    },
    "/endless": (_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.write('<html><head><title>Endless</title><meta property="og:image" content="/og.png"></head><body>');
      const timer = setInterval(() => res.write("<p>more</p>".repeat(100)), 5);
      res.on("close", () => clearInterval(timer));
    },
  });
  victim = await serveFixture({
    "/": (_req, res) => {
      victimHits += 1;
      res.end("secret");
    },
  });
  fetch = createFakeFetch({ allow: [fixture.host] });
});

afterAll(async () => {
  await fixture.close();
  await victim.close();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const signal = () => new AbortController().signal;
const failure = (promise: Promise<unknown>) => promise.then(() => undefined, (error: unknown) => error as ScanFailure);

describe("preflight", () => {
  it("reads the page head of an HTML page", async () => {
    const result = await preflight(`${fixture.origin}/`, { fetch, signal: signal() });
    expect(result).toMatchObject({ finalUrl: `${fixture.origin}/`, status: 200, contentType: "text/html" });
    expect(result.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(result.head?.title).toBe("Fixture Co");
    expect(result.head?.icons).toContainEqual({ href: `${fixture.origin}/assets/touch.png`, rel: "apple-touch-icon" });
    expect(result.head?.ogImages).toEqual([`${fixture.origin}/assets/og.png`]);
  });

  it("decodes the head with the page's charset", async () => {
    const result = await preflight(`${fixture.origin}/shift-jis`, { fetch, signal: signal() });
    expect(result.head).toMatchObject({ title: "Shop", siteName: "テスト" });
  });

  it("returns no head for a file", async () => {
    const result = await preflight(`${fixture.origin}/report.pdf`, { fetch, signal: signal() });
    expect(result).toMatchObject({ status: 200, contentType: "application/pdf", head: null, file: true });
    expect((await preflight(`${fixture.origin}/`, { fetch, signal: signal() })).file).toBe(false);
  });

  it("never calls a bot wall answered in text or JSON a file", async () => {
    expect(await preflight(`${fixture.origin}/wall`, { fetch, signal: signal() })).toMatchObject({ status: 403, contentType: "text/plain", head: null, file: false });
    expect(await preflight(`${fixture.origin}/limited`, { fetch, signal: signal() })).toMatchObject({ status: 429, contentType: "application/json", head: null, file: false });
  });

  it("reads the head of a page whose declared length is over the preflight cap", async () => {
    vi.stubEnv("PREFLIGHT_MAX_BYTES", "4096");
    const result = await preflight(`${fixture.origin}/large.html`, { fetch, signal: signal() });
    expect(result.head).toMatchObject({ title: "Large", icons: [{ href: `${fixture.origin}/large.png`, rel: "icon" }] });
  });

  it("leaves a page that redirects too many times to the browser", async () => {
    const looping: SafeFetch = async () => {
      throw new SafeFetchError("too-many-redirects", "More than 5 redirects");
    };
    expect(await preflight("https://example.com/", { fetch: looping, signal: signal() })).toEqual({ finalUrl: "https://example.com/", status: 0, contentType: "", headers: {}, head: null, file: false });
  });

  it("maps blocked addresses and DNS failures", async () => {
    expect(await failure(preflight(`http://127.0.0.1:${victim.port}/`, { fetch, signal: signal() }))).toMatchObject({ name: "ScanFailure", code: "blocked-address" });
    expect(await failure(preflight("https://does-not-exist.invalid/", { fetch, signal: signal() }))).toMatchObject({ name: "ScanFailure", code: "dns" });
    expect(victimHits).toBe(0);
  });

  it.each([
    ["timeout", "timeout"],
    ["connect", "connect"],
    ["own-host", "own-host"],
    ["unsupported-port", "unsupported-port"],
  ] as const)("maps safeFetch %s to %s", async (code, expected) => {
    const failing: SafeFetch = async () => {
      throw new SafeFetchError(code, code);
    };
    expect(await failure(preflight("https://example.com/", { fetch: failing, signal: signal() }))).toMatchObject({ code: expected });
  });

  it("goes on after 403, 429 and 503 but stops on other HTTP errors", async () => {
    const forbidden = await preflight(`${fixture.origin}/forbidden`, { fetch, signal: signal() });
    expect(forbidden.status).toBe(403);
    expect(forbidden.head?.icons).toHaveLength(1);
    const gone = await failure(preflight(`${fixture.origin}/gone`, { fetch, signal: signal() }));
    expect(gone).toBeInstanceOf(ScanFailure);
    expect(gone).toMatchObject({ code: "http", options: { httpStatus: 404 } });
  });

  it("reads at most preflightMaxBytes of an endless page", async () => {
    vi.stubEnv("PREFLIGHT_MAX_BYTES", "4096");
    const started = Date.now();
    const result = await preflight(`${fixture.origin}/endless`, { fetch, signal: signal() });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(result.head).toMatchObject({ title: "Endless", ogImages: [`${fixture.origin}/og.png`] });
  });

  it("stops reading a slow body at the preflight deadline", async () => {
    vi.stubEnv("PREFLIGHT_MS", "800");
    const started = Date.now();
    const result = await preflight(`${fixture.origin}/trickle`, { fetch, signal: signal() });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(result.head?.title).toBe("Trickle");
  });

  it("rejects with the abort reason when the scan is cancelled", async () => {
    const controller = new AbortController();
    controller.abort(new Error("client went away"));
    await expect(preflight(`${fixture.origin}/`, { fetch, signal: controller.signal })).rejects.toThrow("client went away");
  });
});

describe("buildFallback", () => {
  const png = () => sharp({ create: { width: 256, height: 256, channels: 4, background: "#123456" } }).png().toBuffer();

  it("combines the page head, the favicon service and the Wikidata logo", async () => {
    const icon = await png();
    const wikidataRequests: { url: string; headers?: Record<string, string> }[] = [];
    const publicFetch = createFakeFetch({
      routes: {
        "https://www.google.com/s2/favicons": () => new Response(new Uint8Array(icon), { headers: { "content-type": "image/png" } }),
        "https://query.wikidata.org/sparql": (url) => {
          wikidataRequests.push({ url: url.href });
          return Response.json({
            results: {
              bindings: [
                { logo: { value: "http://commons.wikimedia.org/wiki/Special:FilePath/Other%20logo.svg" }, site: { value: "https://www.notexample.com/" } },
                { logo: { value: "http://commons.wikimedia.org/wiki/Special:FilePath/Example%20logo.svg" }, site: { value: "https://www.example.com/" } },
              ],
            },
          });
        },
      },
    });
    const spy = vi.fn(publicFetch);
    const html = await readFile(path.join(import.meta.dirname, "../../fixtures/site/index.html"), "utf8");
    const head = parseHead(html, "https://www.example.com/");
    const signer = createFakeSigner();
    const assets = await buildFallback({ host: "www.example.com", head, fetch: spy, signer, signal: signal() });

    for (const asset of assets) {
      expect(() => Asset.parse(asset)).not.toThrow();
      expect(asset.foundIn).toEqual(["public-source"]);
      expect(asset.original?.proxy).toBe(`/api/asset?u=${encodeURIComponent(asset.original?.url ?? "")}`);
    }
    const byUrl = new Map(assets.map((asset) => [asset.original?.url, asset]));
    expect(byUrl.get("https://commons.wikimedia.org/wiki/Special:FilePath/Example%20logo.svg")).toMatchObject({ role: "site-logo", kind: "svg", format: "svg" });
    expect(byUrl.has("https://commons.wikimedia.org/wiki/Special:FilePath/Other%20logo.svg")).toBe(false);
    expect(byUrl.get("https://www.google.com/s2/favicons?domain=www.example.com&sz=256")).toMatchObject({ role: "favicon", format: "png", width: 256, height: 256, bytes: icon.length });
    expect(byUrl.get("https://www.example.com/assets/touch.png")).toMatchObject({ role: "favicon", kind: "image", format: "png" });
    expect(byUrl.get("https://www.example.com/assets/logo.svg")).toMatchObject({ role: "favicon", kind: "svg" });
    expect(byUrl.get("https://www.example.com/assets/og.png")).toMatchObject({ role: "social" });
    expect(byUrl.get("https://example.invalid/jsonld-logo.png")).toMatchObject({ role: "site-logo" });
    expect(assets[0].role).toBe("site-logo");
    expect(new Set(assets.map((asset) => asset.filename)).size).toBe(assets.length);
    expect(new Set(assets.map((asset) => asset.id)).size).toBe(assets.length);
    expect(assets.every((asset) => /^example-[a-z0-9-]+\.(png|svg)$/.test(asset.filename))).toBe(true);
    expect(assets.find((asset) => asset.role === "site-logo")?.name).toBe("Fixture logo");
    expect(signer.count).toBe(assets.length);

    const wikidataCall = spy.mock.calls.find(([url]) => url.startsWith("https://query.wikidata.org/"));
    expect(wikidataCall?.[1]?.headers?.["user-agent"]).toBe("AssetsScraper/1.0 (+https://github.com/gamween/assets_scraper)");
    expect(wikidataCall?.[1]?.timeoutMs).toBe(3000);
    const query = new URL(wikidataRequests[0].url).searchParams.get("query") ?? "";
    expect(query).toContain("wdt:P856");
    expect(query).toContain("wdt:P154");
    // Exact website IRIs, which the query service answers from its index; a text filter would time out.
    expect(query).toContain("VALUES ?site { <https://example.com/> <https://example.com> <https://www.example.com/> <https://www.example.com>");
    expect(query).not.toContain("FILTER");
  });

  it("keeps the fallback small enough for one NDJSON line, with every source represented", async () => {
    const icon = await png();
    const longPath = (i: number, size: number) => `/icons/${i}-${"a".repeat(size)}.png`;
    // og:site_name goes into the name of every asset.
    const html = `<html><head>
      <meta property="og:site_name" content="${"S".repeat(15_000)}">
      ${Array.from({ length: 200 }, (_, i) => `<link rel="icon" href="${longPath(i, i % 2 ? 3000 : 1500)}">`).join("")}
      ${Array.from({ length: 30 }, (_, i) => `<meta property="og:image" content="${longPath(1000 + i, 1500)}">`).join("")}
      <script type="application/ld+json">${JSON.stringify({ "@graph": Array.from({ length: 30 }, (_, i) => ({ logo: `https://www.example.com${longPath(2000 + i, 1500)}` })) })}</script>
      </head></html>`;
    const publicFetch = createFakeFetch({
      routes: {
        "https://www.google.com/s2/favicons": () => new Response(new Uint8Array(icon), { headers: { "content-type": "image/png" } }),
        "https://query.wikidata.org/sparql": () =>
          Response.json({
            results: {
              bindings: [
                { logo: { value: `http://commons.wikimedia.org/wiki/Special:FilePath/${"L".repeat(3000)}.svg` }, site: { value: "https://www.example.com/" } },
                { logo: { value: "http://commons.wikimedia.org/wiki/Special:FilePath/Example.svg" }, site: { value: "https://www.example.com/" } },
              ],
            },
          }),
      },
    });
    // Signed proxy paths as long as the real signer's: the URL in base64url plus the expiry and the signature.
    const signer = { sign: (url: string) => `/api/asset?u=${Buffer.from(url).toString("base64url")}&e=1790000000&s=${"s".repeat(32)}`, count: 0 };
    const assets = await buildFallback({ host: "www.example.com", head: parseHead(html, "https://www.example.com/"), fetch: publicFetch, signer, signal: signal() });

    expect(assets.length).toBeLessThanOrEqual(20);
    for (const asset of assets) {
      expect(asset.original?.url.length).toBeLessThanOrEqual(2048);
      expect(asset.name.length).toBeLessThanOrEqual(300);
    }
    const line = JSON.stringify({ type: "error", code: "blocked", message: "The site blocked the scan", fallback: assets });
    expect(Buffer.byteLength(line)).toBeLessThan(256_000);
    const urls = assets.map((asset) => asset.original?.url ?? "");
    expect(urls[0]).toBe("https://commons.wikimedia.org/wiki/Special:FilePath/Example.svg");
    expect(urls).toContain("https://www.google.com/s2/favicons?domain=www.example.com&sz=256");
    expect(assets.filter((asset) => asset.role === "site-logo").length).toBeGreaterThan(1);
    expect(assets.filter((asset) => asset.role === "favicon").length).toBeGreaterThan(1);
    expect(assets.filter((asset) => asset.role === "social").length).toBeGreaterThan(0);
  });

  it("never throws: network failures give only what the head had", async () => {
    const broken: SafeFetch = async () => {
      throw new SafeFetchError("connect", "down");
    };
    expect(await buildFallback({ host: "example.com", head: null, fetch: broken, signer: createFakeSigner(), signal: signal() })).toEqual([]);

    const notFound = createFakeFetch({ routes: { "https://": () => new Response("nope", { status: 404 }) } });
    const head = parseHead('<link rel="icon" href="/favicon.ico">', "https://example.com/");
    const assets = await buildFallback({ host: "example.com", head, fetch: notFound, signer: createFakeSigner(), signal: signal() });
    expect(assets.map((asset) => [asset.role, asset.format, asset.original?.url])).toEqual([["favicon", "ico", "https://example.com/favicon.ico"]]);

    const refusing = { sign: () => { throw new Error("sign limit"); }, count: 800 };
    expect(await buildFallback({ host: "example.com", head, fetch: broken, signer: refusing, signal: signal() })).toEqual([]);
  });
});

describe("directAsset", () => {
  it("describes a URL that is a file", () => {
    const asset = directAsset({ url: "https://files.example.com/docs/Annual%20Report.pdf?v=2", contentType: "application/pdf", signer: createFakeSigner() });
    expect(() => Asset.parse(asset)).not.toThrow();
    expect(asset).toMatchObject({ kind: "image", role: "image", format: "other", name: "Annual Report", filename: "files-annual-report.pdf", original: { url: "https://files.example.com/docs/Annual%20Report.pdf?v=2" } });
    expect(directAsset({ url: "https://example.com/logo.svg", contentType: "image/svg+xml", signer: createFakeSigner() })).toMatchObject({ kind: "svg", format: "svg", filename: "example-logo.svg" });
  });

  it("keeps a file name with a malformed percent escape as it is", () => {
    const asset = directAsset({ url: "https://example.com/docs/100%25%zz.pdf", contentType: "application/pdf", signer: createFakeSigner() });
    expect(asset).toMatchObject({ name: "100%25%zz", filename: "example-100-25-zz.pdf", original: { url: "https://example.com/docs/100%25%zz.pdf" } });
  });
});
