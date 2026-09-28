import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as z from "zod";
import { Asset, Diagnostics, FontFamily, Palette, ScanStats } from "@/lib/contract";
import { buildIdentity } from "./build-id";
import { agentLimits } from "./limits";
import type { AgentScan, ScanSource } from "./types";

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
  // Stamped with the build that produced it, and read back only by that build: see `readScan`.
  await fs.writeFile(temporary, JSON.stringify({ ...scan, build: buildIdentity() }), { mode: 0o600 });
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
 * The whole `AgentScan` shape, from the `src/lib/contract.ts` schemas the scan itself is built from. A file is only a
 * scan when every field is there: checking a few of them and casting the rest turns one bad file in the directory into a
 * failure for every caller, because `summarize` reads `stats`, `fonts` and `palette` the moment a load returns and
 * `findRecentScan` prefers the newest file it accepted, so a shaped but incomplete file shadows a good older scan of the
 * same URL until it ages out a day later.
 */
const AgentScanFile = z.object({
  /** The build that wrote the file (`src/agent/build-id.ts`). Absent in a file written before this field existed. */
  build: z.string().optional(),
  scanId: z.string(),
  scannedAt: z.string(),
  source: z.enum(["local", "remote"]),
  remote: z.string().optional(),
  page: z.object({
    url: z.string(),
    finalUrl: z.string(),
    host: z.string(),
    title: z.string(),
    siteName: z.string().optional(),
  }),
  assets: z.array(Asset),
  fonts: z.array(FontFamily),
  palette: Palette.nullable(),
  stats: ScanStats,
  warnings: z.array(z.string()),
  diagnostics: Diagnostics.optional(),
});

/**
 * Whether a parsed file is a scan this build may answer with. The parsed value is thrown away and the original object
 * returned, so a field the schema does not know about survives the round trip instead of being stripped.
 *
 * The build stamp is part of being readable, not a detail of the answer. A scan is what this code found on a page, so a
 * file another build wrote is another program's answer: an upgrade that fixes what a scan collects, or what the
 * selection keeps, would otherwise go unnoticed while the cache serves the old results for an hour, and the first thing
 * anyone does with a fix is run it on the page that showed the bug. A file with no stamp, or one from another build, is
 * a cache miss like any other: it costs a rescan and never a wrong answer.
 */
function isAgentScan(value: unknown): value is AgentScan {
  const parsed = AgentScanFile.safeParse(value);
  return parsed.success && parsed.data.build === buildIdentity();
}

async function readScan(file: string): Promise<AgentScan | null> {
  try {
    const value: unknown = JSON.parse(await fs.readFile(file, "utf8"));
    if (!isAgentScan(value)) return null;
    // The stamp belongs to the file, not to the scan: a caller gets back what `saveScan` was given, and re-saving the
    // scan stamps it with the build doing the saving rather than carrying a stale one forward.
    const scan = { ...value } as AgentScan & { build?: string };
    delete scan.build;
    return scan;
  } catch {
    return null;
  }
}

/**
 * Where a scan ran: the kind of source, and for a remote one which hosted app. Every `ScanSource` is one, which is how
 * a caller passes its source rather than restating what it is and forgetting half of it.
 */
export type ScanOrigin = Pick<ScanSource, "kind" | "remote">;

/**
 * Two spellings of one hosted app: a trailing slash and the case of the scheme and the host do not make it another
 * one. The path keeps its case, because a path can be case sensitive. Anything that is not a URL is compared as it is.
 */
function normalizeRemote(remote: string | undefined): string {
  const trimmed = (remote ?? "").trim().replace(/\/+$/, "");
  if (trimmed === "") return "";
  try {
    const url = new URL(trimmed);
    return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return trimmed;
  }
}

/** Whether a cached scan came from the same place a lookup is asking about: the same kind, and the same hosted app. */
const sameOrigin = (scan: AgentScan, origin: ScanOrigin): boolean =>
  scan.source === origin.kind && normalizeRemote(scan.remote) === normalizeRemote(origin.remote);

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
 * The newest cached scan of `url` that `source` produced and that is younger than `ttlMs`, or null. Every failure is a
 * cache miss: a file that is missing, unparseable or not a scan is skipped rather than failing the lookup.
 *
 * The source is part of the lookup, not a detail of the answer: a local scan and a remote one answer the same URL from
 * different engines, so serving one for the other makes `--remote` a claim the answer does not back. A remote run
 * therefore never reads a locally produced scan, and a local run never reads a remote one (review issue: misleading
 * `--remote`).
 *
 * "Remote" is not one bucket either. `--remote-url` and `ASSETS_SCRAPER_REMOTE` name which hosted app runs the scan,
 * and two of them are two engines with two deployments: a scan of production must not answer a run pointed at staging.
 * The base URL the scan ran against is therefore compared too, so a source only ever reads its own scans.
 *
 * A scan file is written once and never touched again, so its mtime is when the scan ran. Files older than the TTL are
 * therefore skipped on the stat, without parsing them: this runs on the hot path of every scan, the cache holds a day
 * of files, and a scan of a page with inline assets carries its base64 bytes and can be megabytes. A file whose mtime
 * was moved backwards by something other than this tool (a restored backup, a `touch`) is therefore invisible here even
 * when its `scannedAt` is inside the TTL, which costs a rescan and never a wrong answer.
 */
export async function findRecentScan(url: string, source: ScanOrigin, ttlMs: number = agentLimits.scanCacheTtlMs): Promise<AgentScan | null> {
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
      if (!scan || !sameOrigin(scan, source)) continue;
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
