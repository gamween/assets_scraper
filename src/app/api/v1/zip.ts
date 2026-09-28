import { makeZip } from "client-zip";
import { sanitizeHost } from "@/agent/dest";
import { type DownloadManifest, type ManifestFile, safeFileName } from "@/agent/download";
import { agentLimits } from "@/agent/limits";
import { selectAssets } from "@/agent/select";
import type { AgentScan, DropReason, ScanSource, SelectionOptions } from "@/agent/types";
import type { Asset } from "@/lib/contract";
import { meterProxyBytes, type ProxyBytesMeter } from "@/server/security/budget";

/**
 * The ZIP of a selection, built on the server (spec section 8). It is the same selection the CLI writes into `scrap/`,
 * run with `selectAssets` twice like a download does: the name and size rules before any fetch, the byte rules (exact
 * and perceptual duplicates) once the bytes are in, so a duplicate discovered from bytes never reaches the archive.
 *
 * The bytes are held in memory before the archive streams, because the byte rules decide which entries exist: the
 * per request cap and the daily proxy budget are what bound that, and reaching either ends the archive cleanly with a
 * note in the manifest rather than an error.
 */

/** Bytes one ZIP request serves, whatever the daily budget still allows: it is also what one function holds in memory. */
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

export const zipMaxBytes = (): number => {
  const value = Number(process.env.AGENT_ZIP_MAX_BYTES);
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_MAX_BYTES;
};

/**
 * The archive's `manifest.json` is the document `assets-scraper get` writes, field for field, plus what only an archive
 * has to say. That is what makes the header comment of the route true: llms.txt tells an agent to unzip this into
 * `scrap/<host>`, so a script keying on `files[].file` and `files[].keptBecause` has to read the same names either way.
 * It used to carry `path` and a `keptFor` enum, and no `manifestVersion`, `profile` or `downloadedAt` (review issue 18).
 */
export interface ZipManifest extends DownloadManifest {
  /** The selection the query asked for, which a local download has in the command line instead. */
  selection: SelectionOptions;
  duplicates: { keptId: string; droppedIds: string[] }[];
  /** True when the request cap or the daily byte budget ended the archive early; `note` then says so in words. */
  truncated: boolean;
  note?: string;
}

export interface BuiltZip {
  stream: ReadableStream<Uint8Array>;
  manifest: ZipManifest;
  filename: string;
}

export interface BuildZipOptions {
  signal?: AbortSignal;
  meter?: ProxyBytesMeter;
  maxBytes?: number;
  concurrency?: number;
}

/** The URL the file came from, or "" for markup the scan already held (inline SVG has no URL of its own). */
const sourceUrl = (asset: Asset): string => asset.original?.url ?? asset.display?.url ?? "";

/**
 * The name one file takes, then `-2`, `-3` and so on for a name already used, which is the rule a local download writes
 * by (`writeUnique` in `src/agent/download.ts`). Unzipping an archive into a project therefore gives the same names
 * `assets-scraper get` would have written.
 */
const uniqueName = (name: string, used: Set<string>): string => {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  let candidate = name;
  for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${stem}-${n}${extension}`;
  used.add(candidate.toLowerCase());
  return candidate;
};

/** Bytes of one asset: its own markup when the scan carries it, the original file otherwise, then what was displayed. */
async function assetBytes(asset: Asset, source: ScanSource, signal?: AbortSignal): Promise<Buffer> {
  const inline = asset.inline;
  if (inline) return "text" in inline ? Buffer.from(inline.text, "utf8") : Buffer.from(inline.base64, "base64");
  const target = asset.original ?? asset.display;
  if (!target) throw new Error("no bytes to fetch");
  return source.fetchBytes(target, signal ? { signal } : {});
}

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : "could not be fetched").slice(0, 200);

/**
 * Fetches the selection in relevance order, `concurrency` at a time, counting every byte against the daily proxy budget
 * before it is served. It stops at the first refusal of the budget or of the per request cap, so an archive is either
 * whole or the front of the selection with `truncated` set.
 */
async function fetchSelection(
  keep: Asset[],
  source: ScanSource,
  options: { maxBytes: number; concurrency: number; meter: ProxyBytesMeter; signal?: AbortSignal },
): Promise<{ bytes: Map<string, Buffer>; failed: ZipManifest["failed"]; truncated: boolean; unavailable: number }> {
  const bytes = new Map<string, Buffer>();
  const failed: ZipManifest["failed"] = [];
  let total = 0;
  let truncated = false;
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (truncated || options.signal?.aborted) return;
      const asset = keep[cursor++];
      if (asset === undefined) return;
      let buffer: Buffer;
      try {
        buffer = await assetBytes(asset, source, options.signal);
      } catch (error) {
        failed.push({ id: asset.id, name: asset.name, reason: reasonOf(error) });
        continue;
      }
      // `total` is read between awaits, so the request cap can be passed by what the other workers hold in flight, by
      // at most `concurrency` files. The budget is the exact one: `take` is atomic and counts nothing when it refuses.
      if (total + buffer.byteLength > options.maxBytes || !(await options.meter.take(buffer.byteLength))) {
        truncated = true;
        return;
      }
      total += buffer.byteLength;
      bytes.set(asset.id, buffer);
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, Math.min(options.concurrency, keep.length)) }, worker));
  const fetched = bytes.size + failed.length;
  return { bytes, failed, truncated, unavailable: truncated ? Math.max(0, keep.length - fetched) : 0 };
}

const sum = (into: Partial<Record<DropReason, number>>, from: Partial<Record<DropReason, number>>): Partial<Record<DropReason, number>> => {
  for (const [reason, count] of Object.entries(from) as [DropReason, number][]) {
    if (count > 0) into[reason] = (into[reason] ?? 0) + count;
  }
  return into;
};

export const TRUNCATED_NOTE =
  "This archive holds the front of the selection only: the request limit or the daily byte budget was reached. Ask for fewer files with max, kinds or roles.";

/** Builds the archive for `scan` and returns its stream, its manifest and the file name to offer it under. */
export async function buildAssetsZip(
  scan: AgentScan,
  source: ScanSource,
  selection: SelectionOptions,
  options: BuildZipOptions = {},
): Promise<BuiltZip> {
  const meter = options.meter ?? meterProxyBytes();
  const byName = await selectAssets(scan.assets, selection);
  let fetched: Awaited<ReturnType<typeof fetchSelection>>;
  try {
    fetched = await fetchSelection(byName.keep, source, {
      maxBytes: options.maxBytes ?? zipMaxBytes(),
      concurrency: options.concurrency ?? agentLimits.downloadConcurrency,
      meter,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } finally {
    await meter.settle();
  }

  const byBytes = await selectAssets(
    byName.keep.filter((asset) => fetched.bytes.has(asset.id)),
    selection,
    fetched.bytes,
  );

  const used = new Set<string>();
  const profile = selection.profile ?? "deck";
  const winners = new Map(byBytes.duplicates.map((group) => [group.keptId, group.droppedIds]));
  const files: ManifestFile[] = [];
  const entries: { name: string; input: Uint8Array; lastModified: Date }[] = [];
  for (const asset of byBytes.keep) {
    const buffer = fetched.bytes.get(asset.id);
    if (!buffer) continue;
    const folder = asset.kind === "svg" ? "svg" : "images";
    const fallback = `${asset.id}.${asset.format}`;
    // The download's own rule, so the two paths never name one asset two ways (plan Task G6.2).
    const file = `${folder}/${uniqueName(safeFileName(asset.filename || asset.name || fallback, fallback), used)}`;
    files.push({
      id: asset.id,
      name: asset.name,
      file,
      url: sourceUrl(asset),
      kind: asset.kind,
      role: asset.role,
      format: asset.format,
      ...(asset.width === undefined ? {} : { width: asset.width }),
      ...(asset.height === undefined ? {} : { height: asset.height }),
      bytes: buffer.byteLength,
      // The same sentence `src/agent/download.ts` writes, so the two manifests read alike.
      keptBecause: selection.ids ? "explicit id" : `${profile} profile (role ${asset.role})`,
      ...(winners.has(asset.id) ? { duplicatesDropped: winners.get(asset.id) } : {}),
    });
    entries.push({ name: file, input: buffer, lastModified: new Date(scan.scannedAt) });
  }

  const dropped = sum(sum({}, byName.dropped), byBytes.dropped);
  if (fetched.unavailable > 0) sum(dropped, { unavailable: fetched.unavailable });
  const manifest: ZipManifest = {
    tool: "assets-scraper",
    manifestVersion: 1,
    scanId: scan.scanId,
    scannedAt: scan.scannedAt,
    downloadedAt: new Date().toISOString(),
    page: scan.page,
    profile,
    selection,
    files,
    dropped,
    duplicates: byBytes.duplicates,
    failed: fetched.failed,
    totalBytes: files.reduce((total, file) => total + file.bytes, 0),
    truncated: fetched.truncated,
    ...(fetched.truncated ? { note: TRUNCATED_NOTE } : {}),
  };

  return {
    stream: makeZip([
      ...entries,
      { name: "manifest.json", input: `${JSON.stringify(manifest, null, 2)}\n`, lastModified: new Date(scan.scannedAt) },
    ]),
    manifest,
    filename: `${sanitizeHost(scan.page.host)}-assets.zip`,
  };
}
