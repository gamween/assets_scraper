import { createLocalScanSource } from "./source-local";
import { createRemoteScanSource } from "./source-remote";
import type { ScanSource, ScanSourceOptions } from "./types";

/**
 * Picks where a scan runs (spec 2): locally through the v1 engine by default, remotely against the hosted app when
 * `remote` or `ASSETS_SCRAPER_REMOTE` names one.
 */

/** The hosted app a remote scan runs against, with no trailing slash, or undefined for a local scan. */
export function remoteBaseUrl(options: ScanSourceOptions = {}): string | undefined {
  const remote = (options.remote ?? process.env.ASSETS_SCRAPER_REMOTE ?? "").trim();
  return remote === "" ? undefined : remote.replace(/\/+$/, "");
}

export function createScanSource(options: ScanSourceOptions = {}): ScanSource {
  const remote = remoteBaseUrl(options);
  if (remote === undefined) return createLocalScanSource();
  // A remote with no token throws here, which is what the caller has to report: the MCP server says it on the first tool
  // call, and the CLI turns it into its one line on stderr.
  return createRemoteScanSource({ remote, ...(options.token === undefined ? {} : { token: options.token }) });
}
