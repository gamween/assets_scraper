import { createLocalScanSource } from "./source-local";
import type { ScanSource, ScanSourceOptions } from "./types";

/**
 * Picks where a scan runs (spec 2): locally through the v1 engine by default, remotely against the hosted app when
 * `remote` or `ASSETS_SCRAPER_REMOTE` names one.
 */

export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotImplementedError";
  }
}

/** The hosted app a remote scan runs against, with no trailing slash, or undefined for a local scan. */
export function remoteBaseUrl(options: ScanSourceOptions = {}): string | undefined {
  const remote = (options.remote ?? process.env.ASSETS_SCRAPER_REMOTE ?? "").trim();
  return remote === "" ? undefined : remote.replace(/\/+$/, "");
}

export function createScanSource(options: ScanSourceOptions = {}): ScanSource {
  const remote = remoteBaseUrl(options);
  if (remote === undefined) return createLocalScanSource();
  // The remote source is track G2 (plan Task G2.2): it lands in `src/agent/source-remote.ts` and is wired in here.
  throw new NotImplementedError(`remote scans are not available yet in this build (${remote})`);
}
