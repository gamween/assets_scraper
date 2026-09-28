const MB = 1024 * 1024;

/**
 * Agent-only limits, in the shape of `src/server/config/limits.ts`: every value can be overridden with an environment
 * variable named after its key in SCREAMING_SNAKE_CASE, prefixed with `AGENT_` (`minLongSide` reads
 * `AGENT_MIN_LONG_SIDE`). Overrides are read on every access, so tests can set them at runtime, and every value is a
 * whole number (a count, a distance, ms or bytes), so anything that is not a whole number above 0 is ignored.
 */
const defaults = {
  /** Longest side under which a raster is dropped by the `deck` profile (spec 4.2). */
  minLongSide: 600,
  /** Files one download keeps after sorting by relevance (spec 4.6). */
  maxFiles: 60,
  /**
   * Bytes a selection keeps in total, the budget the file count cap never was: 60 files of a page that serves 4 MB
   * photographs is a quarter of a gigabyte. The best scoring files inside the budget are the ones kept.
   */
  maxTotalBytes: 25 * MB,
  /** Bytes one file of the `deck` profile may take: past this it is a photograph, not an asset a deck can use. */
  maxFileBytes: 8 * MB,
  /** Hamming distance of two 256 bit fingerprint hashes that makes a pair worth confirming (spec 4.5). */
  nearDuplicateDistance: 20,
  /** How long a cached scan answers `download_assets` without rescanning (spec 6). */
  scanCacheTtlMs: 3_600_000,
  /** Parallel asset fetches of one download. */
  downloadConcurrency: 6,
  /** Bytes one download writes before it stops and reports the rest as unavailable. */
  maxDownloadBytes: 300 * MB,
  /** Bytes of one font file the installer accepts, before and after conversion. */
  fontInstallMaxBytes: 8 * MB,
};

export type AgentLimitName = keyof typeof defaults;
export type AgentLimits = { readonly [K in AgentLimitName]: number };

/** `minLongSide` to `AGENT_MIN_LONG_SIDE`. */
export const agentLimitEnvName = (name: AgentLimitName): string =>
  `AGENT_${name.replace(/[A-Z]/g, (char) => `_${char}`).toUpperCase()}`;

const envNumber = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
};

export const agentLimits: AgentLimits = Object.freeze(
  Object.defineProperties(
    {},
    Object.fromEntries(
      (Object.keys(defaults) as AgentLimitName[]).map((name) => [
        name,
        { enumerable: true, get: () => envNumber(agentLimitEnvName(name), defaults[name]) },
      ]),
    ),
  ) as AgentLimits,
);
