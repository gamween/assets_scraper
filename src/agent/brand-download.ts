import fs from "node:fs";
import path from "node:path";
import type { BrandFile } from "@/lib/contract";
import { limits } from "@/server/config/limits";
import { SafeFetchError, safeFetch } from "@/server/net/safe-fetch";
import { isOpaqueName } from "@/server/scan/brand-files";
import type { SafeFetch } from "@/server/scan/types";
import { declaredType } from "@/server/security/sniff";
import { ArchiveError, type ArchiveLimits, logoFilesIn, looksLike } from "./archive";
import { resolveDestination } from "./dest";
import { writeManifest, writeUnique } from "./download";
import { agentLimits } from "./limits";
import { safeFileName } from "./names";
import type { AgentScan, BrandArchiveReport, BrandDownloadFile, BrandDownloadResult } from "./types";

/**
 * Downloading the brand files a scan reported (`page.brandFiles`): the official kits the asset list never holds. The
 * audit of 11/11/2026 had to fetch them outside the tool, since `download_assets` only takes assets.
 *
 * A brand file goes from its host to this machine through `safeFetch`, never through the hosted app, whichever source
 * scanned the page: the hosted proxy takes images and fonts of up to 25 MB against a shared daily budget, and a kit is an
 * archive of up to `brandFileMaxBytes`. A ZIP is unpacked by default (`archive.ts`): its logo files are written under a
 * folder named after it and the archive itself is not, since a vector the agent can read is what it came for. One that
 * cannot be read is written as it is. Everything lands in `<destination>/brand`, with a `manifest.json` of its own.
 */

export interface BrandDownloadOptions {
  /** Brand file ids, from the summary. Left out, every brand file of the scan. */
  ids?: string[];
  /** Unpack the logo files of an archive instead of writing the archive. True by default. */
  extract?: boolean;
  /** An explicit destination, as `downloadAssets` takes it: an agent's is confined by the caller first. */
  dest?: string;
  cwd?: string;
  signal?: AbortSignal;
  /** The guarded fetch. Overridden by the tests. */
  fetch?: SafeFetch;
}

/** The folder of the destination brand files go in, beside `svg/` and `images/`. */
const BRAND_DIR = "brand";

/** Declared types that are a page rather than a file: a sign-in, a bot check, an error page. */
const PAGE_TYPES = new Set(["text/html", "application/xhtml+xml", "application/json"]);

const oneLine = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim().slice(0, 200) || "unknown error";

const archiveLimits = (): ArchiveLimits => ({
  maxEntries: agentLimits.archiveMaxEntries,
  maxFiles: agentLimits.archiveMaxFiles,
  maxFileBytes: agentLimits.archiveMaxFileBytes,
  maxTotalBytes: agentLimits.archiveMaxBytes,
});

/**
 * The name a brand file is written under: its own file name, unless that is a hash, else the name the scan gave it, with
 * the extension of its type whatever the URL said. stellar.org's logo pack is `9ef5ab89...zip` on its CDN and lands as
 * `Stellar logo pack.zip`.
 */
export function brandFileName(file: BrandFile): string {
  let segment = "";
  try {
    segment = decodeURIComponent(new URL(file.url).pathname.split("/").pop() ?? "");
  } catch {
    segment = "";
  }
  const stem = segment.replace(/\.[a-z0-9]{1,5}$/i, "").trim();
  const name = safeFileName(stem && !isOpaqueName(stem) ? stem : file.name, file.id);
  return `${name}.${file.type}`;
}

/**
 * The bytes of one brand file, held to being that kind of file. A host that answers with a page instead (Cloudflare's
 * challenge, which arbitrum.io serves its archives behind to anything but a browser) is named for what it is.
 */
async function fetchBrandFile(file: BrandFile, fetch: SafeFetch, signal?: AbortSignal): Promise<Buffer> {
  const max = agentLimits.brandFileMaxBytes;
  let bytes: Buffer;
  try {
    const response = await fetch(file.url, {
      maxBytes: max,
      timeoutMs: agentLimits.brandFileTimeoutMs,
      maxRedirects: limits.proxyMaxRedirects,
      ...(signal ? { signal } : {}),
    });
    const type = declaredType(response.headers.get("content-type"));
    if (response.status >= 400 || PAGE_TYPES.has(type)) {
      await response.cancel();
      const page = PAGE_TYPES.has(type) ? ` with a ${type} page rather than the file, likely a sign-in or a bot check only a browser passes` : "";
      throw new Error(`${new URL(file.url).host} answered HTTP ${response.status}${page}`);
    }
    bytes = await response.buffer();
  } catch (error) {
    if (error instanceof SafeFetchError && error.code === "too-large") {
      throw new Error(`it is larger than the ${Math.round(max / (1024 * 1024))} MB one brand file may take (AGENT_BRAND_FILE_MAX_BYTES)`);
    }
    throw error;
  }
  if (!looksLike(file.type, bytes)) throw new Error(`the bytes of ${file.url} are not a ${file.type} file`);
  return bytes;
}

/** One row of the brand `manifest.json`. */
interface BrandManifestRow {
  id: string;
  name: string;
  url: string;
  type: BrandDownloadFile["type"];
  file: string;
  bytes: number;
  from?: string;
}

export async function downloadBrandFiles(scan: AgentScan, options: BrandDownloadOptions = {}): Promise<BrandDownloadResult> {
  const fetch = options.fetch ?? safeFetch;
  const extract = options.extract ?? true;
  const known = scan.page.brandFiles ?? [];
  const wanted = options.ids === undefined ? known : known.filter((file) => options.ids?.includes(file.id));

  const destination = resolveDestination({
    host: scan.page.host,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.dest === undefined ? {} : { dest: options.dest }),
  });
  fs.mkdirSync(path.join(destination.dir, BRAND_DIR), { recursive: true });
  // The real path, so the manifest's relative paths stay inside the folder they describe (see `downloadAssets`).
  const dir = fs.realpathSync(path.join(destination.dir, BRAND_DIR));

  const files: BrandDownloadFile[] = [];
  const archives: BrandArchiveReport[] = [];
  const failed: BrandDownloadResult["failed"] = [];
  const rows: BrandManifestRow[] = [];
  const taken = new Set<string>();
  let fetched = 0;

  const record = (file: BrandFile, written: { path: string }, bytes: number, entry?: { name: string; type: BrandDownloadFile["type"] }) => {
    const row = { id: file.id, name: entry?.name ?? file.name, type: entry?.type ?? file.type, bytes, ...(entry ? { from: file.id } : {}) };
    files.push({ ...row, path: written.path });
    rows.push({ ...row, url: file.url, file: path.relative(dir, written.path).split(path.sep).join("/") });
  };

  for (const file of wanted) {
    options.signal?.throwIfAborted();
    // Brand files are fetched one at a time and never past the download's byte budget: a kit page can link sixteen.
    if (fetched >= agentLimits.maxDownloadBytes) {
      failed.push({ id: file.id, name: file.name, reason: `not fetched: the download already took ${agentLimits.maxDownloadBytes} bytes (AGENT_MAX_DOWNLOAD_BYTES)` });
      continue;
    }
    let bytes: Buffer;
    try {
      bytes = await fetchBrandFile(file, fetch, options.signal);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      failed.push({ id: file.id, name: file.name, reason: oneLine(error) });
      continue;
    }
    fetched += bytes.length;
    const name = brandFileName(file);

    if (file.type === "zip" && extract) {
      const report: BrandArchiveReport = { id: file.id, name: file.name, files: 0, skipped: {} };
      archives.push(report);
      const folder = name.slice(0, -".zip".length);
      try {
        for (const entry of logoFilesIn(bytes, archiveLimits(), report.skipped)) {
          const slash = entry.path.lastIndexOf("/");
          try {
            const written = writeUnique(dir, slash === -1 ? folder : `${folder}/${entry.path.slice(0, slash)}`, entry.path.slice(slash + 1), entry.bytes, taken);
            record(file, written, entry.bytes.length, { name: entry.path, type: entry.type });
            report.files += 1;
          } catch (error) {
            failed.push({ id: file.id, name: entry.path, reason: oneLine(error) });
          }
        }
        continue;
      } catch (error) {
        if (!(error instanceof ArchiveError)) throw error;
        // Not an archive this reader opens (split, or cut short): the file the page offers is still the file.
        report.error = error.message;
      }
    }

    try {
      record(file, writeUnique(dir, ".", name, bytes, taken), bytes.length);
    } catch (error) {
      failed.push({ id: file.id, name: file.name, reason: oneLine(error) });
    }
  }

  const manifestPath = writeManifest(dir, {
    tool: "assets-scraper" as const,
    manifestVersion: 1 as const,
    kind: "brand-files" as const,
    scanId: scan.scanId,
    scannedAt: scan.scannedAt,
    downloadedAt: new Date().toISOString(),
    page: { url: scan.page.url, finalUrl: scan.page.finalUrl, host: scan.page.host, title: scan.page.title },
    files: rows,
    archives,
    failed,
  });
  return { dir, files, archives, failed, totalBytes: files.reduce((total, file) => total + file.bytes, 0), manifestPath };
}
