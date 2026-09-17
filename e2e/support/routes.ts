import { readFileSync } from "node:fs";
import type { Page, Route } from "@playwright/test";
import type { Asset, ScanEvent } from "../../src/lib/contract";
import { assetsOf, fontFileFor, toNdjson } from "./fixtures";
import { standInPng } from "./png";

export const ASSET_ORIGIN = "https://e2e.test";

export interface AssetRouteOptions {
  /** Paths (no query) whose direct fetch answers 404, so the client falls back to the proxy. */
  failDirect?: string[];
  /** Paths whose proxy fetch answers 404 too: the asset is unavailable. */
  failProxy?: string[];
}

export interface AssetRequestLog {
  direct: string[];
  proxy: string[];
}

const MIME: Record<string, string> = {
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
  avif: "image/avif",
  gif: "image/gif",
  ico: "image/x-icon",
  woff2: "font/woff2",
  ttf: "font/ttf",
};

function decodeProxyTarget(url: URL): string | null {
  const encoded = url.searchParams.get("u");
  return encoded ? Buffer.from(encoded, "base64url").toString("utf8") : null;
}

/** Serves every https://e2e.test/e2e-assets/... URL and the /api/asset proxy for the given scan events. */
export async function mockAssetRoutes(page: Page, events: ScanEvent[], options: AssetRouteOptions = {}): Promise<AssetRequestLog> {
  const log: AssetRequestLog = { direct: [], proxy: [] };
  const byPath = new Map<string, Asset>();
  for (const asset of [...assetsOf(events), ...events.flatMap((event) => (event.type === "error" ? (event.fallback ?? []) : []))]) {
    for (const source of [asset.display, asset.original]) if (source) byPath.set(new URL(source.url).pathname, asset);
  }
  const failDirect = new Set(options.failDirect ?? []);
  const failProxy = new Set(options.failProxy ?? []);

  const respond = async (route: Route, target: URL, viaProxy: boolean, fmt?: string | null) => {
    const pathname = target.pathname;
    const headers = { "access-control-allow-origin": "*", "cache-control": "no-store" };
    if ((viaProxy ? failProxy : failDirect).has(pathname)) return route.fulfill({ status: 404, headers, body: "Not found" });
    const fontPath = fontFileFor(pathname);
    if (fontPath) {
      if (fmt === "ttf") return route.fulfill({ status: 200, headers: { ...headers, "content-type": "font/ttf" }, body: Buffer.from([0, 1, 0, 0, 0x54, 0x54, 0x46]) });
      return route.fulfill({ status: 200, headers: { ...headers, "content-type": MIME.woff2 }, body: readFileSync(fontPath) });
    }
    const asset = byPath.get(pathname);
    if (!asset) return route.fulfill({ status: 404, headers, body: "Unknown e2e asset" });
    if (asset.format === "svg") {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${asset.width ?? 64}" height="${asset.height ?? 64}"><rect x="8" y="8" width="48" height="48" rx="12" fill="${asset.tone === "light" ? "#f4f4f5" : "#27272a"}"/></svg>`;
      return route.fulfill({ status: 200, headers: { ...headers, "content-type": MIME.svg }, body: svg });
    }
    const png = standInPng(pathname, asset.width ?? 400, asset.height ?? 300, asset.tone);
    return route.fulfill({ status: 200, headers: { ...headers, "content-type": MIME[asset.format] ?? "image/png" }, body: png });
  };

  await page.route(`${ASSET_ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url());
    log.direct.push(url.pathname + url.search);
    await respond(route, url, false);
  });
  await page.route("**/api/asset?**", async (route) => {
    const url = new URL(route.request().url());
    log.proxy.push(url.search);
    const target = decodeProxyTarget(url);
    if (!target) return route.fulfill({ status: 400, body: "Bad request" });
    await respond(route, new URL(target), true, url.searchParams.get("fmt"));
  });
  return log;
}

export type ScanResponse = ScanEvent[] | { status: number; json: unknown } | { status: number; text: string };

/** Answers POST /api/scan with the given responses in order (the last one repeats). Returns the request bodies. */
export async function mockScan(page: Page, ...responses: ScanResponse[]): Promise<{ bodies: unknown[]; headers: Record<string, string>[] }> {
  const record = { bodies: [] as unknown[], headers: [] as Record<string, string>[] };
  let index = 0;
  await page.route("**/api/scan", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    record.bodies.push(route.request().postDataJSON());
    record.headers.push(route.request().headers());
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (Array.isArray(response)) {
      return route.fulfill({ status: 200, contentType: "application/x-ndjson", body: toNdjson(response) });
    }
    if ("json" in response) return route.fulfill({ status: response.status, contentType: "application/json", body: JSON.stringify(response.json) });
    return route.fulfill({ status: response.status, contentType: "text/plain", body: response.text });
  });
  return record;
}

/**
 * A scan stream the test drives event by event. `page.route` can only fulfill a whole body, so this replaces
 * `fetch` for /api/scan in the page with a ReadableStream the test feeds through `push`.
 */
export async function installControlledScan(page: Page) {
  await page.addInitScript(() => {
    type Controller = ReadableStreamDefaultController<Uint8Array>;
    const state = { controllers: [] as Controller[], requests: 0, aborted: 0 };
    (window as unknown as { __e2eScan: typeof state }).__e2eScan = state;
    const original = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (new URL(raw, location.href).pathname !== "/api/scan") return original(input, init);
      state.requests += 1;
      let controller!: Controller;
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
      });
      state.controllers.push(controller);
      init?.signal?.addEventListener("abort", () => {
        state.aborted += 1;
        try {
          controller.error(new DOMException("Aborted", "AbortError"));
        } catch {}
      });
      return new Response(body, { status: 200, headers: { "content-type": "application/x-ndjson" } });
    };
  });

  return {
    async push(...events: ScanEvent[]) {
      // BotID wraps fetch in an async function, so the stream exists a moment after the scan starts.
      await page.waitForFunction(() => (window as unknown as { __e2eScan: { controllers: unknown[] } }).__e2eScan.controllers.length > 0);
      await page.evaluate((lines) => {
        const state = (window as unknown as { __e2eScan: { controllers: ReadableStreamDefaultController<Uint8Array>[] } }).__e2eScan;
        const controller = state.controllers.at(-1)!;
        for (const line of lines) controller.enqueue(new TextEncoder().encode(`${line}\n`));
      }, events.map((event) => JSON.stringify(event)));
    },
    async close() {
      await page.evaluate(() => (window as unknown as { __e2eScan: { controllers: ReadableStreamDefaultController<Uint8Array>[] } }).__e2eScan.controllers.at(-1)!.close());
    },
    async stats() {
      return page.evaluate(() => {
        const state = (window as unknown as { __e2eScan: { requests: number; aborted: number } }).__e2eScan;
        return { requests: state.requests, aborted: state.aborted };
      });
    },
  };
}
