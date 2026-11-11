import type http from "node:http";
import { chromium, type Browser, type Page } from "playwright-core";
import { buildZip, TEST_PNG, TEST_SVG } from "@/agent/testing";
import { localExecutablePath } from "@/server/browser/launch";
import { limits } from "@/server/config/limits";
import { safeFetch } from "@/server/net/safe-fetch";
import { collectorBrandFileLinks } from "@/server/scan/brand-files";
import { startCapture } from "@/server/scan/capture";
import { COLLECTOR_SOURCE } from "@/server/scan/inpage/generated/collector";
import { MAX_TITLE_CHARS } from "@/server/scan/navigate";
import { MAX_SITE_NAME_CHARS } from "@/server/scan/preflight";
import type {
  CapturedNetwork,
  CollectorOptions,
  RawCollectorOutput,
  SafeFetch,
} from "@/server/scan/types";
import { serveFixture, type FixtureServer } from "../../fixtures/serve";

/**
 * Test helpers for the assets tests. They run the collector without the engine, with the same contracts: the collector
 * runs in a CDP isolated world like `runInPage` does (spec 7.5), and the network is read by the engine's own capture
 * (spec 7.4).
 */

/** How long `capture.settle()` waits for the bodies still being read: a fixture page lands them in milliseconds. */
const SETTLE_MS = 30_000;

export function launchChrome(): Promise<Browser> {
  return chromium.launch({
    executablePath: localExecutablePath(),
    headless: true,
    args: ["--disable-blink-features=AutomationControlled", "--hide-scrollbars", "--mute-audio"],
  });
}

export function collectorOptions(host: string, siteName: string, patch: Partial<CollectorOptions> = {}): CollectorOptions {
  return {
    host,
    siteName,
    timeBudgetMs: limits.collectMs,
    deadline: Date.now() + limits.collectMs,
    maxElements: limits.collectorMaxElements,
    maxSvgNormalizations: limits.svgMaxNormalizations,
    maxSvgBytes: limits.svgMaxBytes,
    maxSvgTotalBytes: limits.svgTotalBytes,
    spriteFetchMs: limits.spriteFetchMs,
    blobFetchMs: limits.blobFetchMs,
    maxTextNodes: limits.collectorMaxTextNodes,
    maxBrandLinks: limits.maxBrandLinks,
    maxBrandFiles: collectorBrandFileLinks(),
    maxBlobBytes: limits.blobMaxBytes,
    maxBlobTotalBytes: limits.blobTotalBytes,
    maxOutputChars: limits.collectorMaxOutputChars,
    maxTitleChars: MAX_TITLE_CHARS,
    maxSiteNameChars: MAX_SITE_NAME_CHARS,
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

/**
 * Opens `url` in a fresh 1440x900 context with the engine's network capture (`startCapture`, spec 7.4), waits for load
 * and fonts. `capture.settle()` stops it and gives what it read.
 */
export async function openPage(browser: Browser, url: string) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const handle = startCapture(page, { signal: new AbortController().signal });
  await page.goto(url, { waitUntil: "load" });
  await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => {});
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const capture = { settle: (): Promise<CapturedNetwork> => handle.settle(SETTLE_MS) };
  return { context, page, capture };
}

/** The kit archive the brand kit fixture page links, laid out as macOS zips a folder, with one entry trying to leave. */
export const FIXTURE_KIT = buildZip([
  { name: "Fixture Logos/" },
  { name: "__MACOSX/Fixture Logos/._Fixture Logo.svg", data: "metadata" },
  { name: "Fixture Logos/Fixture Logo.svg", data: TEST_SVG },
  { name: "Fixture Logos/Fixture Mark.png", data: TEST_PNG },
  { name: "Fixture Logos/../../escape.svg", data: TEST_SVG },
]);

/**
 * The files `brand-kit.html` links or names in its script, as a kit host serves them: one honours a range, as S3 and
 * the CDNs do, so the scan's size probe reads `content-range`; the other answers whole, with its length.
 */
export function brandKitRoutes(): Record<string, http.RequestListener> {
  const serve = (body: Buffer, type: string, ranges: boolean): http.RequestListener => (request, response) => {
    const range = ranges ? /^bytes=0-(\d+)$/.exec(request.headers.range ?? "") : null;
    if (range) {
      const end = Math.min(Number(range[1]), body.length - 1);
      response.writeHead(206, { "content-type": type, "content-range": `bytes 0-${end}/${body.length}`, "content-length": String(end + 1) });
      response.end(body.subarray(0, end + 1));
      return;
    }
    response.writeHead(200, { "content-type": type, "content-length": String(body.length) });
    response.end(body);
  };
  return {
    "/brandkit/downloads/Fixture_Logo_all.zip": serve(FIXTURE_KIT, "application/zip", true),
    "/brandkit/downloads/Fixture_Logo_FullColor.zip": serve(FIXTURE_KIT, "application/zip", false),
    "/brand-page-assets/Fixture Brand and Media Kit.zip": serve(FIXTURE_KIT, "application/octet-stream", true),
    "/brand-page-assets/Logomark.svg": serve(Buffer.from(TEST_SVG), "image/svg+xml", true),
    "/brandkit/fixture-wordmark.svg": serve(Buffer.from(TEST_SVG), "image/svg+xml", true),
  };
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

/** `safeFetch`, which reaches the fixture host through SCAN_TEST_ALLOW_HOSTS (see `serveAssetsFixture`). */
export const testFetch: SafeFetch = safeFetch;
