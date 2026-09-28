import fs from "node:fs";
import path from "node:path";
import type { Asset, AssetFormat, AssetKind, AssetRole } from "@/lib/contract";
import { createFileInside, resolveDestination } from "./dest";
import { agentLimits } from "./limits";
import { selectAssets } from "./select";
import type {
  AgentScan,
  DownloadResult,
  DownloadedFile,
  DropReason,
  ScanSource,
  SelectionOptions,
  SelectionProfile,
} from "./types";

/**
 * Writing a selection to disk (spec 4, last paragraph): `svg/` and `images/` inside the destination, plus a
 * `manifest.json` saying what every file is and why it was kept.
 *
 * Selection runs twice. The name and size rules run before anything is fetched, so bytes are only spent on files that
 * could be kept, and the byte rules (exact and perceptual duplicates) run once the bytes are in hand. Files are written
 * after that second pass, so a duplicate the bytes revealed is never on disk at all rather than written and deleted.
 * That holds the kept bytes in memory for the length of one download, which is what the perceptual pass needs anyway
 * and is bounded by `maxDownloadBytes`.
 */

export interface DownloadOptions extends SelectionOptions {
  /** An explicit destination directory, used as is. Relative paths resolve against `cwd`. */
  dest?: string;
  /** Working directory the project rule walks up from. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Confines an agent-supplied `dest` to the project's scrap directory (spec 10). */
  restrictToProject?: boolean;
  /** Parallel fetches. Defaults to `agentLimits.downloadConcurrency`. */
  concurrency?: number;
  /** Bytes this download may take before it stops. Defaults to `agentLimits.maxDownloadBytes`. */
  maxBytes?: number;
  signal?: AbortSignal;
}

/** One row of `manifest.json`: what the file is, where it came from, and why the selection kept it. */
export interface ManifestFile {
  id: string;
  name: string;
  /** Path inside the destination directory, with forward slashes. */
  file: string;
  /** The URL the bytes came from, or "" for an asset the page carried inline. */
  url: string;
  kind: AssetKind;
  role: AssetRole;
  format: AssetFormat;
  width?: number;
  height?: number;
  bytes: number;
  keptBecause: string;
  /** Ids of the assets this file won a duplicate group against. */
  duplicatesDropped?: string[];
}

export interface DownloadManifest {
  tool: "assets-scraper";
  manifestVersion: 1;
  scanId: string;
  scannedAt: string;
  downloadedAt: string;
  page: AgentScan["page"];
  profile: SelectionProfile;
  files: ManifestFile[];
  totalBytes: number;
  dropped: Partial<Record<DropReason, number>>;
  failed: DownloadResult["failed"];
}

export const MANIFEST_NAME = "manifest.json";

/** Candidate names one file tries before the download gives up on it. */
const MAX_NAME_ATTEMPTS = 50;

const FILE_MODE = 0o644;

/**
 * One file name from an asset: the last path segment only, so a name like `../../evil.svg` cannot walk anywhere, and
 * nothing a file system reads as special. `createFileInside` checks the result again, this only keeps names readable.
 */
export function safeFileName(value: string, fallback: string): string {
  const last = value.split(/[\\/]/).pop() ?? "";
  const cleaned = last
    .replace(/[\x00-\x1f\x7f:*?"<>|]+/g, "-")
    .replace(/^[\s.]+|[\s.]+$/g, "")
    .slice(0, 120);
  return cleaned || fallback;
}

/** The bytes an asset carries itself (inline SVG markup or inline base64), or null when it has to be fetched. */
function inlineBytes(asset: Asset): Buffer | null {
  const inline = asset.inline;
  if (!inline) return null;
  return "text" in inline ? Buffer.from(inline.text, "utf8") : Buffer.from(inline.base64, "base64");
}

/** The best source of an asset's bytes: the CDN original when the scan found one, the served file otherwise. */
const bytesSource = (asset: Asset) => asset.original ?? asset.display;

const sourceUrl = (asset: Asset): string => bytesSource(asset)?.url ?? "";

const oneLine = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim().slice(0, 200) || "unknown error";

/** Writes `data` to `target` even when it is already there, refusing a symlink at the final component. */
function writeFileNoFollow(target: string, data: string | Buffer): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW;
  const fd = fs.openSync(target, flags, FILE_MODE);
  try {
    fs.writeFileSync(fd, data);
  } finally {
    fs.closeSync(fd);
  }
}

interface WrittenFile {
  path: string;
  /** True when the file was already on disk with these exact bytes, so nothing was written. */
  reused: boolean;
}

/**
 * Writes `data` inside `root` as `folder/name`, never overwriting: identical bytes already on disk are left alone, and
 * different bytes get `-2`, `-3` and so on (spec 4, last paragraph). `taken` holds the paths this run already used, so
 * two assets that sanitize to one name get a file each.
 */
function writeUnique(root: string, folder: string, name: string, data: Buffer, taken: Set<string>): WrittenFile {
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt += 1) {
    const candidate = `${folder}/${attempt === 1 ? name : `${base}-${attempt}${extension}`}`;
    let file: { path: string; fd: number };
    try {
      file = createFileInside(root, candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = path.resolve(root, candidate);
      if (taken.has(existing)) continue;
      if (fs.readFileSync(existing).equals(data)) {
        taken.add(existing);
        return { path: existing, reused: true };
      }
      continue;
    }
    try {
      fs.writeFileSync(file.fd, data);
    } finally {
      fs.closeSync(file.fd);
    }
    taken.add(file.path);
    return { path: file.path, reused: false };
  }
  throw new Error(`no free name for ${folder}/${name} after ${MAX_NAME_ATTEMPTS} attempts`);
}

export async function downloadAssets(scan: AgentScan, source: ScanSource, options: DownloadOptions = {}): Promise<DownloadResult> {
  const destination = resolveDestination({
    host: scan.page.host,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.dest === undefined ? {} : { dest: options.dest }),
    ...(options.restrictToProject === undefined ? {} : { restrictToProject: options.restrictToProject }),
  });
  // The destination is created and resolved once, so `dir` is the same real path the writes come back with: on a
  // machine where the destination sits behind a link (`/tmp` on macOS is `/private/tmp`) the two spellings differ, and
  // the manifest's relative paths would climb out of the folder they describe.
  fs.mkdirSync(destination.dir, { recursive: true });
  const dir = fs.realpathSync(destination.dir);
  const profile = options.profile ?? "deck";
  // `DownloadOptions` extends `SelectionOptions`, so the download-only keys ride along and `selectAssets` ignores them.
  const selection: SelectionOptions = { ...options, profile };

  // Pass one: everything the name and size rules can decide without spending a byte.
  const planned = await selectAssets(scan.assets, selection);

  const bytes = new Map<string, Buffer>();
  const failed: DownloadResult["failed"] = [];
  const maxBytes = options.maxBytes ?? agentLimits.maxDownloadBytes;
  const concurrency = Math.max(1, options.concurrency ?? agentLimits.downloadConcurrency);
  let taken = 0;
  let cursor = 0;
  let stopped = false;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (stopped || cursor >= planned.keep.length) return;
      if (taken >= maxBytes) {
        stopped = true;
        return;
      }
      const asset = planned.keep[cursor++];
      const inline = inlineBytes(asset);
      if (inline) {
        bytes.set(asset.id, inline);
        taken += inline.length;
        continue;
      }
      const from = bytesSource(asset);
      if (!from) {
        failed.push({ id: asset.id, name: asset.name, reason: "no URL and no inline bytes" });
        continue;
      }
      try {
        const buffer = await source.fetchBytes(from, options.signal ? { signal: options.signal } : undefined);
        bytes.set(asset.id, buffer);
        taken += buffer.length;
      } catch (error) {
        if (options.signal?.aborted) throw error;
        failed.push({ id: asset.id, name: asset.name, reason: oneLine(error) });
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, planned.keep.length)) }, worker));

  // Pass two, over the assets whose bytes are in hand: the exact and perceptual duplicate rules, which only the bytes
  // can decide. The assets that failed or were never fetched are left out, so nothing is counted twice.
  const fetched = planned.keep.filter((asset) => bytes.has(asset.id));
  const selected = await selectAssets(fetched, selection, bytes);

  const dropped: Partial<Record<DropReason, number>> = { ...planned.dropped };
  for (const [reason, count] of Object.entries(selected.dropped)) {
    dropped[reason as DropReason] = (dropped[reason as DropReason] ?? 0) + (count ?? 0);
  }
  const unfetched = planned.keep.length - fetched.length - failed.length;
  if (unfetched > 0) dropped.unavailable = (dropped.unavailable ?? 0) + unfetched;

  const winners = new Map(selected.duplicates.map((group) => [group.keptId, group.droppedIds]));
  const files: DownloadedFile[] = [];
  const rows: ManifestFile[] = [];
  const takenPaths = new Set<string>();
  for (const asset of selected.keep) {
    const buffer = bytes.get(asset.id);
    if (!buffer) continue;
    const fallback = `${asset.id}.${asset.format}`;
    const name = safeFileName(asset.filename || asset.name || fallback, fallback);
    const folder = asset.kind === "svg" ? "svg" : "images";
    let written: WrittenFile;
    try {
      written = writeUnique(dir, folder, name, buffer, takenPaths);
    } catch (error) {
      failed.push({ id: asset.id, name: asset.name, reason: oneLine(error) });
      continue;
    }
    const dimensions = {
      ...(asset.width === undefined ? {} : { width: asset.width }),
      ...(asset.height === undefined ? {} : { height: asset.height }),
    };
    files.push({
      id: asset.id,
      name: asset.name,
      path: written.path,
      bytes: buffer.length,
      kind: asset.kind,
      role: asset.role,
      ...dimensions,
      url: sourceUrl(asset),
    });
    rows.push({
      id: asset.id,
      name: asset.name,
      file: path.relative(dir, written.path).split(path.sep).join("/"),
      url: sourceUrl(asset),
      kind: asset.kind,
      role: asset.role,
      format: asset.format,
      ...dimensions,
      bytes: buffer.length,
      keptBecause: options.ids ? "explicit id" : `${profile} profile (role ${asset.role})`,
      ...(winners.has(asset.id) ? { duplicatesDropped: winners.get(asset.id) } : {}),
    });
  }

  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  const manifest: DownloadManifest = {
    tool: "assets-scraper",
    manifestVersion: 1,
    scanId: scan.scanId,
    scannedAt: scan.scannedAt,
    downloadedAt: new Date().toISOString(),
    page: scan.page,
    profile,
    files: rows,
    totalBytes,
    dropped,
    failed,
  };
  const manifestPath = path.join(dir, MANIFEST_NAME);
  writeFileNoFollow(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return { dir, files, totalBytes, dropped, failed, manifestPath };
}
