const MB = 1024 * 1024;

/**
 * Every server limit and budget (spec section 14), in one place.
 *
 * Each value can be overridden with an environment variable named after its key in SCREAMING_SNAKE_CASE
 * (`queueWaitMs` reads `QUEUE_WAIT_MS`, `scansPerDay` reads `SCANS_PER_DAY`). Overrides are read on every access,
 * so tests can set them at runtime. Values that are not finite numbers above 0 are ignored.
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

  // Verification and probes (spec 8.4)
  verifyMs: 8_000,
  verifyConcurrency: 16,
  maxDeclaredProbes: 150,

  // Egress proxy and network capture (spec 7.4, 11.1)
  egressMaxBytes: 400 * MB,
  egressMaxSockets: 96,
  bodyMaxBytes: 15 * MB,
  bodyReadMs: 8_000,
  bodyConcurrency: 24,
  bodyTotalBytes: 250 * MB,
  // `blob:` image bytes kept for the client, also passed to the collector as maxBlobBytes and maxBlobTotalBytes
  blobMaxBytes: 2 * MB,
  blobTotalBytes: 16 * MB,

  // In-page collector, passed through CollectorOptions (spec 7.5, 8.1, 8.6)
  collectorMaxElements: 80_000,
  svgMaxBytes: 1 * MB,
  svgTotalBytes: 12 * MB,
  svgMaxNormalizations: 400,
  spriteFetchMs: 4_000,
  maxBrandLinks: 6,

  // Results
  maxAssets: 1_500,
  maxSignedUrls: 800,
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
  wikidataMs: 3_000,

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
  return Number.isFinite(value) && value > 0 ? value : fallback;
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
