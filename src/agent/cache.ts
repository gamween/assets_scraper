import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { agentLimits } from "./limits";
import type { AgentScan } from "./types";

/**
 * Scans on disk, so `download_assets` and `install_fonts` never rescan the page (spec 6). One JSON file per scan under
 * `~/.cache/assets-scraper` (`XDG_CACHE_HOME` wins), read back by id or by URL inside a TTL. Nothing here throws on a
 * file that is missing, corrupt or not ours: a cache that cannot be read is a cache miss.
 */

/** A scan id is a file name: letters, digits, dot, dash, underscore, and nothing that could leave the directory. */
const SCAN_ID = /^[A-Za-z0-9._-]{1,120}$/;

export function cacheDir(): string {
  const xdg = process.env.XDG_CACHE_HOME?.trim();
  return xdg ? path.join(xdg, "assets-scraper") : path.join(os.homedir(), ".cache", "assets-scraper");
}

export function scanCachePath(scanId: string): string {
  if (!SCAN_ID.test(scanId) || scanId === "." || scanId === "..") throw new Error(`invalid scan id: ${JSON.stringify(scanId)}`);
  return path.join(cacheDir(), `${scanId}.json`);
}

/** How long a scan file is kept on disk. Well past the reuse TTL, so nothing an agent may still ask for is deleted. */
export const SCAN_CACHE_KEEP_MS = 24 * 3_600_000;

export async function saveScan(scan: AgentScan): Promise<string> {
  const file = scanCachePath(scan.scanId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(scan), { mode: 0o600 });
  await fs.rename(temporary, file);
  await pruneScans();
  return file;
}

/**
 * Deletes the scan files older than `maxAgeMs`, so a page with hundreds of inline assets does not leave the cache
 * growing for ever. Every failure is ignored: pruning is housekeeping, never the reason a scan fails.
 */
export async function pruneScans(maxAgeMs: number = SCAN_CACHE_KEEP_MS): Promise<number> {
  const dir = cacheDir();
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return 0;
  }
  const oldest = Date.now() - maxAgeMs;
  let deleted = 0;
  for (const name of names) {
    if (!name.endsWith(".json") && !name.endsWith(".tmp")) continue;
    const file = path.join(dir, name);
    try {
      if ((await fs.stat(file)).mtimeMs >= oldest) continue;
      await fs.rm(file, { force: true });
      deleted += 1;
    } catch {
      continue;
    }
  }
  return deleted;
}

export async function loadScan(scanId: string): Promise<AgentScan | null> {
  let file: string;
  try {
    file = scanCachePath(scanId);
  } catch {
    return null;
  }
  return readScan(file);
}

/**
 * Whether a parsed file is a scan. Every field a caller reads straight after a load is checked, `page` included: a file
 * that passes part of the shape and is then cast turns one bad file in the directory into a failure for every URL.
 */
function isAgentScan(value: unknown): value is AgentScan {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const scan = value as Partial<AgentScan>;
  if (typeof scan.scanId !== "string" || typeof scan.scannedAt !== "string" || !Array.isArray(scan.assets)) return false;
  const page: unknown = scan.page;
  if (!page || typeof page !== "object") return false;
  const { url, finalUrl, host, title } = page as Partial<AgentScan["page"]>;
  return typeof url === "string" && typeof finalUrl === "string" && typeof host === "string" && typeof title === "string";
}

async function readScan(file: string): Promise<AgentScan | null> {
  try {
    const scan: unknown = JSON.parse(await fs.readFile(file, "utf8"));
    return isAgentScan(scan) ? scan : null;
  } catch {
    return null;
  }
}

/** `https://www.stripe.com/` and `stripe.com` are the same page to `findRecentScan`. */
const sameUrl = (a: string, b: string): boolean => normalizeUrl(a) === normalizeUrl(b);

const normalizeUrl = (url: string): string =>
  url
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/+$/, "");

/**
 * The newest cached scan of `url` that is younger than `ttlMs`, or null. Every failure is a cache miss: a file that is
 * missing, unparseable or not a scan is skipped rather than failing the lookup.
 *
 * A scan file is written once and never touched again, so its mtime is when the scan ran. Files older than the TTL are
 * therefore skipped on the stat, without parsing them: this runs on the hot path of every scan, the cache holds a day
 * of files, and a scan of a page with inline assets carries its base64 bytes and can be megabytes.
 */
export async function findRecentScan(url: string, ttlMs: number = agentLimits.scanCacheTtlMs): Promise<AgentScan | null> {
  const dir = cacheDir();
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return null;
  }
  const oldest = Date.now() - ttlMs;
  let best: AgentScan | null = null;
  let bestAt = -Infinity;
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      if ((await fs.stat(path.join(dir, name))).mtimeMs < oldest) continue;
      const scan = await readScan(path.join(dir, name));
      if (!scan) continue;
      const at = Date.parse(scan.scannedAt);
      if (!Number.isFinite(at) || at < oldest || at <= bestAt) continue;
      if (!sameUrl(scan.page.url, url) && !sameUrl(scan.page.finalUrl, url)) continue;
      best = scan;
      bestAt = at;
    } catch {
      continue;
    }
  }
  return best;
}
