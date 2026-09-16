const MB = 1024 * 1024;

const envNumber = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

export const limits = {
  scanDeadlineMs: 90_000,
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
  verifyMs: 8_000,
  verifyConcurrency: 16,
  maxDeclaredProbes: 150,
  egressMaxBytes: 400 * MB,
  egressMaxSockets: 96,
  bodyMaxBytes: 15 * MB,
  bodyReadMs: 8_000,
  bodyConcurrency: 24,
  bodyTotalBytes: 250 * MB,
  blobMaxBytes: 2 * MB,
  blobTotalBytes: 16 * MB,
  svgMaxBytes: 1 * MB,
  svgTotalBytes: 12 * MB,
  svgMaxNormalizations: 400,
  collectorMaxElements: 80_000,
  maxAssets: 1_500,
  maxSignedUrls: 800,
  ndjsonLineBytes: 256_000,
  proxyMaxBytes: 25 * MB,
  proxyTimeoutMs: 20_000,
  proxyMaxRedirects: 5,
  toneMaxRasters: 300,
  toneMaxSvgs: 400,
  toneBudgetMs: 3_000,
  toneMaxBytes: 3 * MB,
  minTmpFreeMb: 250,
  minMemAvailableMb: 900,
  watchdogMemMb: 350,
  get scansPerDay() {
    return envNumber("SCANS_PER_DAY", 80);
  },
  get scansPerMonth() {
    return envNumber("SCANS_PER_MONTH", 800);
  },
  get proxyBytesPerDay() {
    return envNumber("PROXY_BYTES_PER_DAY", 300 * MB);
  },
} as const;
