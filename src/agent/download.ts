import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createFileInside, FILE_MODE, resolveDestination } from "./dest";
import { bytesSource, inlineAssetBytes, type ManifestFile, manifestRow, sourceUrl } from "./entries";
import { agentLimits } from "./limits";
import { assetFileName, nameCandidates } from "./names";
import { selectAssets } from "./select";
import type {
  AgentScan,
  DownloadResult,
  DownloadedFile,
  DropReason,
  ScanSource,
  SelectionBudget,
  SelectionOptions,
  SelectionProfile,
} from "./types";

/**
 * Writing a selection to disk (spec 4, last paragraph): `svg/` and `images/` inside the destination, plus a
 * `manifest.json` saying what every file is and why it was kept. The hosted ZIP (`src/app/api/v1/zip.ts`) builds the
 * same archive from the same helpers (`names.ts` for the file name, `entries.ts` for the bytes of an inline asset and
 * the manifest row), so unzipping it into `scrap/<host>` gives what this writes.
 *
 * Selection runs twice. The name and size rules run before anything is fetched, so bytes are only spent on files that
 * could be kept, and the byte rules (exact and perceptual duplicates) run once the bytes are in hand. Files are written
 * after that second pass, so a duplicate the bytes revealed is never on disk at all rather than written and deleted.
 * That holds the kept bytes in memory for the length of one download, which is what the perceptual pass needs anyway
 * and is bounded by `maxDownloadBytes`.
 */

export interface DownloadOptions extends SelectionOptions {
  /**
   * An explicit destination directory, used as is (a relative one resolves against `cwd`). A `dest` that came from an
   * agent is resolved and confined by the caller first (`resolveDestination` with `restrictToProject`, as the MCP
   * `download_assets` tool does), and arrives here as the absolute directory that produced.
   */
  dest?: string;
  /** Working directory the project rule walks up from. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Parallel fetches. Defaults to `agentLimits.downloadConcurrency`. */
  concurrency?: number;
  signal?: AbortSignal;
}

/**
 * `manifest.json`. `files` lists every file this tool wrote into the folder that is still there, earlier downloads into
 * the same folder included, so a second `get` with other filters extends the listing rather than hiding the first one's
 * files. Everything else (the counts, the drops, the budget, the failures) describes this download.
 */
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
  /** The byte rules this download ran under: what it could take in total, what one file could take, what it took. */
  budget: SelectionBudget;
  failed: DownloadResult["failed"];
}

export const MANIFEST_NAME = "manifest.json";
/**
 * Where the manifest goes when the folder already holds a `manifest.json` this tool did not write: a PWA's
 * `public/manifest.json` or a browser extension's own, reached through a `--out` the user typed. Those are never touched.
 */
export const FALLBACK_MANIFEST_NAME = "assets-scraper-manifest.json";

/** Candidate names one file tries before the download gives up on it. */
const MAX_NAME_ATTEMPTS = 50;
/** Bytes of an existing manifest this reads before deciding it is not one of ours. */
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;

const oneLine = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim().slice(0, 200) || "unknown error";

interface WrittenFile {
  path: string;
  /** True when the file was already on disk with these exact bytes, so nothing was written. */
  reused: boolean;
}

/**
 * Writes `data` inside `root` as `folder/name`, never overwriting: identical bytes already on disk are left alone, and
 * different bytes get `-2`, `-3` and so on (spec 4, last paragraph). `taken` holds the names this run already used,
 * without case like the archive's rule (`nameCandidates`), so two assets that sanitize to one name get a file each on
 * every file system.
 */
function writeUnique(root: string, folder: string, name: string, data: Buffer, taken: Set<string>): WrittenFile {
  let attempts = 0;
  for (const candidateName of nameCandidates(name)) {
    if (++attempts > MAX_NAME_ATTEMPTS) break;
    const candidate = `${folder}/${candidateName}`;
    if (taken.has(candidate.toLowerCase())) continue;
    let file: { path: string; fd: number };
    try {
      file = createFileInside(root, candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = path.resolve(root, candidate);
      if (fs.readFileSync(existing).equals(data)) {
        taken.add(candidate.toLowerCase());
        return { path: existing, reused: true };
      }
      continue;
    }
    try {
      fs.writeFileSync(file.fd, data);
    } finally {
      fs.closeSync(file.fd);
    }
    taken.add(candidate.toLowerCase());
    return { path: file.path, reused: false };
  }
  throw new Error(`no free name for ${folder}/${name} after ${MAX_NAME_ATTEMPTS} attempts`);
}

/** Whether a manifest row names a file that is still on disk inside `dir`. */
const stillThere = (dir: string, row: ManifestFile): boolean => {
  const full = path.resolve(dir, row.file);
  if (!full.startsWith(dir + path.sep)) return false;
  try {
    return fs.lstatSync(full).isFile();
  } catch {
    return false;
  }
};

/** What sits at a manifest path: nothing, a manifest this tool wrote, or anything else, which is never touched. */
function existingManifest(file: string): { kind: "none" } | { kind: "ours"; manifest: DownloadManifest } | { kind: "foreign" } {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(file);
  } catch {
    return { kind: "none" };
  }
  if (!stats.isFile() || stats.size > MAX_MANIFEST_BYTES) return { kind: "foreign" };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<DownloadManifest>;
    if (parsed.tool === "assets-scraper" && parsed.manifestVersion === 1 && Array.isArray(parsed.files)) return { kind: "ours", manifest: parsed as DownloadManifest };
  } catch {
    // Not JSON, so not ours.
  }
  return { kind: "foreign" };
}

/**
 * Writes the manifest of this download into `dir` and returns where. It used to truncate whatever `manifest.json` was
 * there, so `get stripe.com --out ./public` replaced a PWA's manifest and `--out .` a browser extension's, and a second
 * download into the same folder dropped the first one's rows although its files were still on disk.
 *
 * A manifest this tool wrote is extended: its rows whose file is still there and that this download did not write again
 * are kept after this download's own. Anything else under that name is left alone, and the manifest goes to
 * `FALLBACK_MANIFEST_NAME` instead. The new document is written to a temporary name and renamed into place, so a
 * reader never sees half of it, and the rename replaces a name rather than following it.
 */
function writeDownloadManifest(dir: string, manifest: DownloadManifest): string {
  let target = path.join(dir, MANIFEST_NAME);
  let existing = existingManifest(target);
  if (existing.kind === "foreign") {
    target = path.join(dir, FALLBACK_MANIFEST_NAME);
    existing = existingManifest(target);
    if (existing.kind === "foreign") throw new Error(`${dir} already holds a ${MANIFEST_NAME} and a ${FALLBACK_MANIFEST_NAME} this tool did not write`);
  }
  const written = new Set(manifest.files.map((row) => row.file));
  const earlier = existing.kind === "ours" ? existing.manifest.files.filter((row) => !written.has(row.file) && stillThere(dir, row)) : [];
  const document = { ...manifest, files: [...manifest.files, ...earlier] };

  const temporary = path.join(dir, `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, FILE_MODE);
  try {
    try {
      fs.writeFileSync(fd, `${JSON.stringify(document, null, 2)}\n`);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, target);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  return target;
}

export async function downloadAssets(scan: AgentScan, source: ScanSource, options: DownloadOptions = {}): Promise<DownloadResult> {
  const destination = resolveDestination({
    host: scan.page.host,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.dest === undefined ? {} : { dest: options.dest }),
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
  const maxBytes = agentLimits.maxDownloadBytes;
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
      let inline: Buffer | null;
      try {
        inline = inlineAssetBytes(asset);
      } catch (error) {
        failed.push({ id: asset.id, name: asset.name, reason: oneLine(error) });
        continue;
      }
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
  const takenNames = new Set<string>();
  for (const asset of selected.keep) {
    const buffer = bytes.get(asset.id);
    if (!buffer) continue;
    const folder = asset.kind === "svg" ? "svg" : "images";
    let written: WrittenFile;
    try {
      written = writeUnique(dir, folder, assetFileName(asset), buffer, takenNames);
    } catch (error) {
      failed.push({ id: asset.id, name: asset.name, reason: oneLine(error) });
      continue;
    }
    files.push({
      id: asset.id,
      name: asset.name,
      path: written.path,
      bytes: buffer.length,
      kind: asset.kind,
      role: asset.role,
      ...(asset.width === undefined ? {} : { width: asset.width }),
      ...(asset.height === undefined ? {} : { height: asset.height }),
      url: sourceUrl(asset),
    });
    const duplicatesDropped = winners.get(asset.id);
    rows.push(
      manifestRow(asset, path.relative(dir, written.path).split(path.sep).join("/"), buffer.length, {
        profile,
        explicit: options.ids !== undefined,
        ...(duplicatesDropped === undefined ? {} : { duplicatesDropped }),
      }),
    );
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
    budget: selected.budget,
    failed,
  };
  const manifestPath = writeDownloadManifest(dir, manifest);

  return { dir, files, totalBytes, dropped, budget: selected.budget, failed, manifestPath };
}
