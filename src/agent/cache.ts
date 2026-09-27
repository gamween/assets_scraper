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

export async function saveScan(scan: AgentScan): Promise<string> {
  const file = scanCachePath(scan.scanId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(scan), { mode: 0o600 });
  await fs.rename(temporary, file);
  return file;
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

async function readScan(file: string): Promise<AgentScan | null> {
  try {
    const scan = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
    if (!scan || typeof scan !== "object") return null;
    const candidate = scan as AgentScan;
    if (typeof candidate.scanId !== "string" || typeof candidate.scannedAt !== "string" || !Array.isArray(candidate.assets)) return null;
    return candidate;
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

/** The newest cached scan of `url` that is younger than `ttlMs`, or null. Unreadable files are skipped. */
export async function findRecentScan(url: string, ttlMs: number = agentLimits.scanCacheTtlMs): Promise<AgentScan | null> {
  let names: string[];
  try {
    names = await fs.readdir(cacheDir());
  } catch {
    return null;
  }
  const oldest = Date.now() - ttlMs;
  let best: AgentScan | null = null;
  let bestAt = -Infinity;
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const scan = await readScan(path.join(cacheDir(), name));
    if (!scan) continue;
    const at = Date.parse(scan.scannedAt);
    if (!Number.isFinite(at) || at < oldest || at <= bestAt) continue;
    if (!sameUrl(scan.page.url, url) && !sameUrl(scan.page.finalUrl, url)) continue;
    best = scan;
    bestAt = at;
  }
  return best;
}
