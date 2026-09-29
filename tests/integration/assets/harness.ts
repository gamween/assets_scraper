import type http from "node:http";
import { chromium, type Browser, type Page } from "playwright-core";
import { limits } from "@/server/config/limits";
import { safeFetch } from "@/server/net/safe-fetch";
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
    deadline: Date.now() + limits.collectMs,
    maxElements: limits.collectorMaxElements,
    maxSvgNormalizations: limits.svgMaxNormalizations,
    maxSvgBytes: limits.svgMaxBytes,
    maxSvgTotalBytes: limits.svgTotalBytes,
    spriteFetchMs: limits.spriteFetchMs,
    blobFetchMs: limits.blobFetchMs,
    maxTextNodes: limits.collectorMaxTextNodes,
    maxBrandLinks: limits.maxBrandLinks,
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
