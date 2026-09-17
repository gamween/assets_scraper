import { createHash } from "node:crypto";
import type http from "node:http";
import { chromium, type Browser, type Page } from "playwright-core";
import sharp from "sharp";
import { limits } from "@/server/config/limits";
import { NotImplementedError } from "@/server/errors";
import { safeFetch } from "@/server/net/safe-fetch";
import { COLLECTOR_SOURCE } from "@/server/scan/inpage/generated/collector";
import { toneFromBytes } from "@/server/scan/post/tone";
import type {
  CapturedNetwork,
  CollectorOptions,
  RawCollectorOutput,
  SafeFetch,
  SafeFetchOptions,
  SafeResponse,
} from "@/server/scan/types";
import { serveFixture, type FixtureServer } from "../../fixtures/serve";

/**
 * Test helpers for Track C. Tracks A and B (safeFetch, runInPage, capture) are stubs on this branch, so these helpers
 * stand in for them with the same contracts: the collector runs in a CDP isolated world like `runInPage` does
 * (spec 7.5), and the network listener keeps what `startCapture` keeps (spec 7.4).
 */

const CHROME = process.env.CHROME_EXECUTABLE_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export function launchChrome(): Promise<Browser> {
  return chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--disable-blink-features=AutomationControlled", "--hide-scrollbars", "--mute-audio"],
  });
}

export function collectorOptions(host: string, siteName: string, patch: Partial<CollectorOptions> = {}): CollectorOptions {
  return {
    host,
    siteName,
    timeBudgetMs: limits.collectMs,
    maxElements: limits.collectorMaxElements,
    maxSvgNormalizations: limits.svgMaxNormalizations,
    maxSvgBytes: limits.svgMaxBytes,
    maxSvgTotalBytes: limits.svgTotalBytes,
    spriteFetchMs: limits.spriteFetchMs,
    maxBrandLinks: limits.maxBrandLinks,
    maxBlobBytes: limits.blobMaxBytes,
    maxBlobTotalBytes: limits.blobTotalBytes,
    maxOutputChars: limits.collectorMaxOutputChars,
    ...patch,
  };
}

/**
 * Runs the bundled collector in an isolated world of the main frame, or in the page's own world like the `runInPage`
 * fallback does when the isolated world cannot be created (spec 7.5).
 */
export async function runCollector(page: Page, options: CollectorOptions, world: "isolated" | "main" = "isolated"): Promise<RawCollectorOutput> {
  const expression = `${COLLECTOR_SOURCE}\n;globalThis.__assetsScraper.collect(${JSON.stringify(options)})`;
  if (world === "main") return (await page.evaluate(expression)) as RawCollectorOutput;
  const cdp = await page.context().newCDPSession(page);
  try {
    const { frameTree } = await cdp.send("Page.getFrameTree");
    const { executionContextId } = await cdp.send("Page.createIsolatedWorld", {
      frameId: frameTree.frame.id,
      worldName: "assets-scraper-test",
      grantUniveralAccess: false,
    });
    const result = await cdp.send("Runtime.evaluate", {
      expression,
      contextId: executionContextId,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    }
    return result.result.value as RawCollectorOutput;
  } finally {
    await cdp.detach().catch(() => {});
  }
}

/** Minimal network capture: image bodies hashed, measured and toned, SVG text, font hashes, stylesheet text. */
export function captureNetwork(page: Page): { settle(): Promise<CapturedNetwork> } {
  const network: CapturedNetwork = { images: [], fonts: [], sheets: [], bodyTimeouts: 0, skippedBodies: 0 };
  const pending: Promise<void>[] = [];
  page.on("response", (response) => {
    const url = response.url();
    const status = response.status();
    if (url.startsWith("data:") || (status >= 300 && status < 400)) return;
    const type = response.request().resourceType();
    const headers = response.headers();
    const contentType = headers["content-type"] ?? "";
    const isFont = type === "font" || /font|woff|opentype|truetype|sfnt/i.test(contentType) || /\.(?:woff2?|ttf|otf|eot)(?:\?|$)/i.test(url);
    const isImage = !isFont && (type === "image" || /^image\//i.test(contentType));
    const isSheet = type === "stylesheet" || /text\/css/i.test(contentType);
    if (!isFont && !isImage && !isSheet) return;
    pending.push(
      (async () => {
        const body = await response.body().catch(() => null);
        if (!body?.length) {
          network.bodyTimeouts++;
          return;
        }
        const sha1 = createHash("sha1").update(body).digest("hex");
        if (isSheet) network.sheets.push({ url, status, cssText: body.toString("utf8") });
        else if (isFont) network.fonts.push({ url, status, contentType, bytes: body.length, sha1, meta: null });
        else {
          const svg = /svg/i.test(contentType);
          const meta = svg ? null : await sharp(body).metadata().catch(() => null);
          network.images.push({
            url,
            status,
            contentType,
            server: headers.server,
            bytes: body.length,
            sha1,
            width: meta?.width,
            height: meta?.height,
            tone: status < 400 ? await toneFromBytes(body, contentType) : "unknown",
            ...(svg ? { svgText: body.toString("utf8") } : {}),
            ...(url.startsWith("blob:") ? { blobBase64: body.toString("base64") } : {}),
          });
        }
      })(),
    );
  });
  return {
    async settle() {
      await Promise.allSettled(pending);
      return network;
    },
  };
}

/** Opens `url` in a fresh 1440x900 context with network capture, waits for load and fonts. */
export async function openPage(browser: Browser, url: string) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const capture = captureNetwork(page);
  await page.goto(url, { waitUntil: "load" });
  await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => {});
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  return { context, page, capture };
}

/** Serves the fixture site plus extra routes, and allows its host for `safeFetch` in tests (spec 11.1). */
export async function serveAssetsFixture(routes: Record<string, http.RequestListener> = {}): Promise<FixtureServer> {
  const server = await serveFixture(routes);
  const allowed = new Set((process.env.SCAN_TEST_ALLOW_HOSTS ?? "").split(",").filter(Boolean));
  allowed.add(server.host);
  allowed.add(`localhost:${server.port}`);
  process.env.SCAN_TEST_ALLOW_HOSTS = [...allowed].join(",");
  return server;
}

/** Plain `fetch` with the `SafeFetch` shape, for as long as the real one is a stub. No address checks: tests only. */
const localFetch: SafeFetch = async (url: string, options: SafeFetchOptions = {}): Promise<SafeResponse> => {
  const controller = new AbortController();
  const timer = options.timeoutMs ? setTimeout(() => controller.abort(), options.timeoutMs) : undefined;
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const cleanup = () => {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  };
  let response: Response;
  try {
    response = await fetch(url, { method: options.method ?? "GET", headers: options.headers, signal: controller.signal, redirect: "follow" });
  } catch (error) {
    cleanup();
    throw error;
  }
  const empty = () => new ReadableStream<Uint8Array>({ start: (c) => c.close() });
  return {
    url: response.url,
    status: response.status,
    headers: response.headers,
    redirected: response.redirected,
    stream: () => response.body ?? empty(),
    buffer: async () => Buffer.from(await response.arrayBuffer()).subarray(0, options.maxBytes),
    text: () => response.text(),
    json: <T>() => response.json() as Promise<T>,
    cancel: async () => {
      cleanup();
      await response.body?.cancel().catch(() => {});
    },
  };
};

/** The real `safeFetch` once Track A lands, the local adapter until then. */
export const testFetch: SafeFetch = async (url, options) => {
  try {
    return await safeFetch(url, options);
  } catch (error) {
    if (!(error instanceof NotImplementedError)) throw error;
    return localFetch(url, options);
  }
};
