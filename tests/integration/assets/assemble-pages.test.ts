import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type http from "node:http";
import path from "node:path";
import type { Browser } from "playwright-core";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Asset } from "@/lib/contract";
import { assembleAssets } from "@/server/scan/post/assemble";
import type { AssetsOutput } from "@/server/scan/types";
import type { FixtureServer } from "../../fixtures/serve";
import { collectorOptions, launchChrome, openPage, runCollector, serveAssetsFixture, testFetch } from "./harness";

/** Pages built for the post-processing paths the fixture page does not reach. */

const SITE = path.join(import.meta.dirname, "../../fixtures/site/assets");
const html = (body: string): http.RequestListener => (_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><head><title>Pages</title>${body}`);
};

let server: FixtureServer;
let browser: Browser;
let noisePng: Buffer;
let bigPng: Buffer;

const css = (text: string): http.RequestListener => (_req, res) => {
  res.writeHead(200, { "content-type": "text/css" });
  res.end(text);
};
const withEnv = async <T>(env: Record<string, string>, run: () => Promise<T>): Promise<T> => {
  Object.assign(process.env, env);
  try {
    return await run();
  } finally {
    for (const name of Object.keys(env)) delete process.env[name];
  }
};

/** A Next.js-style image optimizer: serves a 64 px wide PNG of `url`, cropped square when `crop=1`. */
const nextImage: http.RequestListener = async (req, res) => {
  const params = new URL(req.url ?? "/", "http://x").searchParams;
  const source = readFileSync(path.join(SITE, path.basename(params.get("url") ?? "")));
  const body = await sharp(source).resize(64, params.get("crop") ? 64 : undefined, { fit: "cover" }).png().toBuffer();
  res.writeHead(200, { "content-type": "image/png" });
  res.end(body);
};

async function scan(pathname: string, siteName = "Pages"): Promise<AssetsOutput> {
  const { context, page, capture } = await openPage(browser, `${server.origin}${pathname}`);
  const collector = await runCollector(page, collectorOptions(server.host, siteName));
  const network = await capture.settle();
  await context.close();
  const output = await assembleAssets({
    collector,
    network,
    page: { requestedUrl: `${server.origin}${pathname}`, finalUrl: `${server.origin}${pathname}`, host: server.host, siteName, title: "Pages" },
    signer: { sign: (url) => `/api/asset?u=${url}`, count: 0 },
    fetch: testFetch,
    signal: new AbortController().signal,
    deadline: Date.now() + 8_000,
  });
  for (const asset of output.assets) Asset.parse(asset);
  return output;
}

beforeAll(async () => {
  const noise = (width: number, height: number) => sharp(randomBytes(width * height * 3), { raw: { width, height, channels: 3 } }).png().toBuffer();
  noisePng = await noise(2, 2);
  bigPng = await noise(96, 96);
  server = await serveAssetsFixture({
    "/_next/image": nextImage,
    "/originals.html": html(`</head><body>
      <img src="/_next/image?url=%2Fassets%2Fphoto-large.png&w=64" alt="Team">
      <img src="/_next/image?url=%2Fassets%2Fhero.jpg&w=64&crop=1" alt="Cover">
      <img src="/_next/image?url=%2Fassets%2Flogo.svg&w=64" alt="Partner">
    </body></html>`),
    "/manifest.html": html(`<link rel="manifest" href="/site.webmanifest"></head><body><p>No icons here</p></body></html>`),
    "/site.webmanifest": (_req, res) => {
      res.writeHead(200, { "content-type": "application/manifest+json" });
      res.end(JSON.stringify({ icons: [{ src: "/assets/touch.png", sizes: "180x180", type: "image/png" }, { src: "/missing-icon.png", sizes: "512x512" }] }));
    },
    "/cross.html": (req, res) => {
      const other = `http://localhost:${server.port}`;
      html(`<link rel="stylesheet" href="${other}/cross.css"></head><body><div class="card">Card</div></body></html>`)(req, res);
    },
    "/cross.css": (_req, res) => {
      res.writeHead(200, { "content-type": "text/css" });
      res.end(".card { background-image: url(/assets/bg.png); width: 40px; height: 40px } .card:hover { background-image: url(/assets/hover.png) }");
    },
    "/bare.html": html(`</head><body><img src="/assets/poster.jpg" alt="Poster"></body></html>`),
    "/sheets.html": (req, res) => {
      const other = `http://localhost:${server.port}`;
      html(`<link rel="stylesheet" href="${other}/parent.css"><link rel="stylesheet" href="/moved.css"></head><body><p>Nothing rendered</p></body></html>`)(req, res);
    },
    "/parent.css": css(`@import url("/child.css");
      .hero { background-image: image-set("/assets/imgset-1x.png" 1x, "/assets/imgset-2x.png" 2x) }
      .card { background-image: image-set("/assets/poster.jpg" 1x, "/assets/noscript.jpg" 2x) }`),
    "/child.css": css(".child:hover { background-image: url(/assets/pseudo.png) }"),
    "/moved.css": (_req, res) => {
      res.writeHead(302, { location: `http://localhost:${server.port}/moved-target.css` });
      res.end();
    },
    "/moved-target.css": css(".moved:hover { background-image: url(/assets/iframe.png) }"),
    "/slow.html": html(`<style>.later:hover { background-image: url(/slow.png) }</style></head><body>
      <header><a href="/" aria-label="Pages home"><svg width="120" height="40" viewBox="0 0 120 40"><circle cx="20" cy="20" r="18" fill="#fff"/></svg></a></header>
    </body></html>`),
    "/slow.png": (_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(bigPng);
      }, 800);
    },
    "/noise.html": (req, res) => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><path d="${"M0 0h40v40H0z ".repeat(200)}"/></svg>`;
      html(`<style>.later:hover { background-image: url(/tiny.png) }</style></head><body>
        <img src="data:image/svg+xml,${encodeURIComponent(svg)}" alt="Big vector">
        <img src="data:image/png;base64,${bigPng.toString("base64")}" alt="Big raster">
      </body></html>`)(req, res);
    },
    "/tiny.png": (_req, res) => {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(noisePng);
    },
    "/favicon.ico": (_req, res) => {
      res.writeHead(200, { "content-type": "image/x-icon" });
      res.end(readFileSync(path.join(import.meta.dirname, "../../../src/app/favicon.ico")));
    },
  });
  browser = await launchChrome();
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

describe("assembleAssets on purpose-built pages", () => {
  it("verifies CDN originals, flags a changed framing and moves an SVG original to the SVG kind", async () => {
    const { assets, warnings } = await scan("/originals.html");
    expect(warnings).toEqual([]);
    const team = assets.find((a) => a.name === "Team")!;
    expect(team.display).toMatchObject({ format: "png", width: 64 });
    expect(team.display!.url).toContain("/_next/image?url=");
    expect(team.original).toMatchObject({ url: `${server.origin}/assets/photo-large.png`, format: "png", width: 1600, height: 800 });
    expect(team.aspectChanged).toBeUndefined();

    const cover = assets.find((a) => a.name === "Cover")!;
    expect(cover.original).toMatchObject({ url: `${server.origin}/assets/hero.jpg`, format: "jpg", width: 1200, height: 600 });
    expect(cover.display).toMatchObject({ width: 64, height: 64 });
    expect(cover.aspectChanged).toBe(true);

    const partner = assets.find((a) => a.name === "Partner")!;
    expect(partner).toMatchObject({ kind: "svg", format: "svg", filename: "pages-partner.svg" });
    expect(partner.original?.url).toBe(`${server.origin}/assets/logo.svg`);
    expect(partner.display?.format).toBe("png");
  });

  it("adds web manifest icons and drops the ones that fail their probe", async () => {
    const { assets, hidden } = await scan("/manifest.html");
    const icons = assets.filter((a) => a.foundIn.includes("manifest"));
    expect(icons).toEqual([expect.objectContaining({ role: "favicon", name: "Pages favicon", width: 180, height: 180, visible: false })]);
    expect(hidden["probe-failed"]).toBe(1);
    expect(assets.some((a) => a.original?.url.endsWith("/favicon.ico"))).toBe(false);
  });

  it("reads image URLs from stylesheets the page cannot read", async () => {
    const { assets } = await scan("/cross.html");
    const hover = assets.find((a) => a.original?.url === `http://localhost:${server.port}/assets/hover.png`);
    expect(hover).toMatchObject({ declaredOnly: true, foundIn: ["stylesheet"], visible: false });
    const bg = assets.find((a) => a.original?.url === `http://localhost:${server.port}/assets/bg.png`);
    expect(bg).toMatchObject({ declaredOnly: false, visible: true, role: "icon" });
    expect(bg?.foundIn).toEqual(["css-background", "stylesheet"]);
  });

  it("probes /favicon.ico when the page declares no icon", async () => {
    const { assets } = await scan("/bare.html", "");
    const favicon = assets.find((a) => a.original?.url === `${server.origin}/favicon.ico`);
    expect(favicon).toMatchObject({ role: "favicon", format: "ico", foundIn: ["icon-link"], width: expect.any(Number) });
    expect(favicon?.filename).toBe("site-favicon.ico");
  });

  it("reads captured stylesheets the page could not walk and keeps image-set declarations apart", async () => {
    const { assets } = await scan("/sheets.html");
    const other = `http://localhost:${server.port}`;
    const declared = (name: string) => assets.filter((a) => a.original?.url === `${other}/assets/${name}`);
    const sets = [[...declared("imgset-1x.png"), ...declared("imgset-2x.png")], [...declared("poster.jpg"), ...declared("noscript.jpg")]];
    expect(sets).toEqual([
      [expect.objectContaining({ declaredOnly: true, foundIn: ["stylesheet"] })],
      [expect.objectContaining({ declaredOnly: true, foundIn: ["stylesheet"] })],
    ]);
    expect(declared("pseudo.png")).toEqual([expect.objectContaining({ declaredOnly: true })]);
    expect(declared("iframe.png")).toEqual([expect.objectContaining({ declaredOnly: true })]);
  });

  it("tones inline SVGs within the tone budget however long verification took", async () => {
    const { assets } = await withEnv({ TONE_BUDGET_MS: "300" }, () => scan("/slow.html"));
    const logo = assets.find((a) => a.role === "site-logo");
    expect(logo).toMatchObject({ kind: "svg", tone: "light" });
    expect(assets.find((a) => a.original?.url.endsWith("/slow.png"))).toMatchObject({ declaredOnly: true });
  });

  it("applies the noise rules to probed files and caps inline bytes", async () => {
    const { assets, hidden, warnings } = await withEnv({ SVG_MAX_BYTES: "2000", BLOB_MAX_BYTES: "1000" }, () => scan("/noise.html"));
    expect(assets.some((a) => a.original?.url.endsWith("/tiny.png"))).toBe(false);
    expect(hidden.pixel).toBe(1);
    expect(hidden["probe-failed"]).toBeUndefined();
    expect(assets.filter((a) => a.inline)).toEqual([]);
    expect(hidden["svg-too-large"]).toBe(1);
    expect(warnings).toContain("truncated");
  });
});
