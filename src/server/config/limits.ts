const MB = 1024 * 1024;

/**
 * Every server limit and budget (spec section 14), in one place.
 *
 * Each value can be overridden with an environment variable named after its key in SCREAMING_SNAKE_CASE
 * (`queueWaitMs` reads `QUEUE_WAIT_MS`, `scansPerDay` reads `SCANS_PER_DAY`). Overrides are read on every access,
 * so tests can set them at runtime. Every limit is a whole number (ms, bytes or a count), so values that are not
 * whole numbers above 0 (`1.5`, `0`, `soon`) are ignored.
 */
const defaults = {
  // Scan pipeline (spec 7.2, 7.3)
  scanDeadlineMs: 90_000,
  maxConcurrentScans: 1,
  queueWaitMs: 15_000,
  preflightMs: 8_000,
  preflightMaxBytes: 1 * MB,
  launchMs: 20_000,
  gotoMs: 25_000,
  loadMs: 10_000,
  networkIdleMs: 3_000,
  scrollMs: 8_000,
  scrollStepMs: 180,
  scrollIdleMs: 2_500,
  animationsMs: 2_000,
  collectMs: 15_000,
  settleMs: 5_000,
  minTmpFreeMb: 250,
  minMemAvailableMb: 900,
  watchdogMemMb: 350,
  /** Graceful browser close before the kill (critic R6). */
  gracefulCloseMs: 5_000,
  /** How long shutdown waits for `browser.close()` after the kill, before it moves on. */
  killedCloseMs: 2_000,
  /** The small in-page reads after navigation: title, element count, markup sample. */
  readMs: 3_000,
  /** Scrolling back to the top after the lazy scroll. */
  backToTopMs: 1_000,
  /** The palette phase's share of `collectMs` (spec 10: about 200 ms of work). */
  paletteBudgetMs: 3_000,
  /**
   * How far past `paletteBudgetMs` the engine's own stop for the palette phase lands: extractPalette's signal aborts at
   * budget plus this, in case it overruns its budget, so raising the budget moves the stop with it.
   */
  paletteOverrunMs: 1_000,
  /** After that abort, how long extractPalette gets to put the page back before the collector runs. */
  paletteStopMs: 1_000,
  /**
   * CPU time post-processing gets at least after its network deadline: page work stops this long before the scan
   * deadline, so that what it gathered still turns into results by the deadline.
   */
  postGraceMs: 5_000,
  /** How long a cancelled scan waits for its cleanup (browser kill, proxy close) before the stream ends anyway. */
  cancelCleanupMs: 10_000,
  /** How long a scan waits for its egress proxy to stop, so a close that hangs never holds the scan past its deadline. */
  egressCloseMs: 1_000,

  // Verification and probes (spec 8.4)
  verifyMs: 8_000,
  verifyConcurrency: 16,
  maxDeclaredProbes: 150,
  /**
   * URLs read from captured stylesheet text that the network did not load. Only `maxDeclaredProbes` of them are ever
   * checked, and a page controls how many its sheets declare (a 15 MB sheet holds hundreds of thousands).
   */
  maxStylesheetUrls: 2_000,

  // Egress proxy and network capture (spec 7.4, 11.1)
  egressMaxBytes: 400 * MB,
  egressMaxSockets: 96,
  bodyMaxBytes: 15 * MB,
  bodyReadMs: 8_000,
  bodyConcurrency: 24,
  bodyTotalBytes: 250 * MB,
  /**
   * Font parsing in capture. Parsing is synchronous on the event loop (a 5 MB WOFF2 takes about 200 ms) and a page
   * controls how many fonts it serves and how large, so past any of these a font is hashed but gets no metadata.
   */
  fontParseMaxBytes: 5 * MB,
  fontParseBudgetMs: 1_500,
  fontParseMaxFiles: 40,
  // `blob:` image bytes kept for the client, also passed to the collector as maxBlobBytes and maxBlobTotalBytes
  blobMaxBytes: 2 * MB,
  blobTotalBytes: 16 * MB,

  // In-page collector, passed through CollectorOptions (spec 7.5, 8.1, 8.6)
  collectorMaxElements: 80_000,
  svgMaxBytes: 1 * MB,
  svgTotalBytes: 12 * MB,
  svgMaxNormalizations: 400,
  spriteFetchMs: 4_000,
  /** Fetch of one `blob:` image in the page. */
  blobFetchMs: 3_000,
  /** Text nodes the collector reads for font usage (spec 9). */
  collectorMaxTextNodes: 20_000,
  maxBrandLinks: 6,
  /**
   * JSON characters of the whole collector output. Node holds the result several times while Playwright and the engine
   * parse it, so this bounds the memory a page can make the scan use. The collector cuts its lists to stay under it.
   */
  collectorMaxOutputChars: 32_000_000,

  // Results
  maxAssets: 1_500,
  maxSignedUrls: 2_000,
  /**
   * Batching target for `assets` lines. It is not a hard cap: one asset larger than this on its own
   * (a blob image can reach `blobMaxBytes` before base64) is sent alone on its own line.
   */
  ndjsonLineBytes: 256_000,

  // Tone (spec 8.8)
  toneMaxRasters: 300,
  toneMaxSvgs: 400,
  toneBudgetMs: 3_000,
  toneMaxBytes: 3 * MB,

  // Fonts, palette and fallback lookups (spec 8.9, 9, 10)
  googleFontsMs: 2_000,
  googleFontsMaxFamilies: 8,
  paletteFetchMs: 600,
  /** Web app manifest icons read by the assets step (spec 8.1). */
  manifestMs: 3_000,
  manifestMaxBytes: 512_000,
  wikidataMs: 3_000,
  faviconServiceMs: 3_000,

  // Asset proxy (spec 11.2)
  proxyMaxBytes: 25 * MB,
  proxyTimeoutMs: 20_000,
  proxyMaxRedirects: 5,

  // Budgets (spec 11.3)
  scansPerDay: 80,
  scansPerMonth: 800,
  proxyBytesPerDay: 300 * MB,
};

export type LimitName = keyof typeof defaults;
export type Limits = { readonly [K in LimitName]: number };

/** `queueWaitMs` to `QUEUE_WAIT_MS`. */
export const limitEnvName = (name: LimitName): string => name.replace(/[A-Z]/g, (char) => `_${char}`).toUpperCase();

const envNumber = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
};

export const limits: Limits = Object.freeze(
  Object.defineProperties(
    {},
    Object.fromEntries(
      (Object.keys(defaults) as LimitName[]).map((name) => [
        name,
        { enumerable: true, get: () => envNumber(limitEnvName(name), defaults[name]) },
      ]),
    ),
  ) as Limits,
);
