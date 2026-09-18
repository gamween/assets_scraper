import { downloadZip as clientZip } from "client-zip";
import type { Asset, FontFamily } from "@/lib/contract";
import { getAssetBlob, getFontFileBlob } from "./asset-bytes";
import { saveBlob } from "./download";
import { fontFileEntries, getFontTtfBlob, safeSegment, withUniqueName } from "./font-files";

export type ZipItem = { type: "asset"; asset: Asset } | { type: "font"; font: FontFamily };

export interface ZipFailure {
  /** Display name for the "Show" list. */
  name: string;
  /** Entry path the file would have had. */
  path: string;
}

export interface ZipOptions {
  signal?: AbortSignal;
  /** `bytes` is what the entries loaded so far weigh: the only size the client knows for files the scan never sized. */
  onProgress?: (done: number, total: number, bytes: number) => void;
  concurrency?: number;
}

interface PlannedEntry {
  path: string;
  label: string;
  load: (signal?: AbortSignal) => Promise<Blob>;
}

export const zipFileName = (host: string) => `${safeSegment(host, "site")}-assets.zip`;

/** Spec 12.4 layout: `<host>-assets/svg/`, `images/`, `fonts/<family>/`, with converted TTFs next to open WOFF2 files. */
export function planZip(items: ZipItem[], host: string): PlannedEntry[] {
  const root = `${safeSegment(host, "site")}-assets`;
  const usedByFolder = new Map<string, Set<string>>();
  const add = (entries: PlannedEntry[], folder: string, name: string, label: string, load: PlannedEntry["load"]) => {
    let used = usedByFolder.get(folder);
    if (!used) usedByFolder.set(folder, (used = new Set()));
    entries.push({ path: `${folder}/${withUniqueName(name, used)}`, label, load });
  };

  const entries: PlannedEntry[] = [];
  for (const item of items) {
    if (item.type === "asset") {
      const { asset } = item;
      const folder = `${root}/${asset.kind === "svg" ? "svg" : "images"}`;
      add(entries, folder, safeSegment(asset.filename, `${asset.id}.${asset.format}`), asset.name, (signal) => getAssetBlob(asset, "original", { signal }));
      continue;
    }
    const { font } = item;
    if (!font.downloadable) continue;
    const folder = `${root}/fonts/${safeSegment(font.name, "font")}`;
    for (const entry of fontFileEntries(font)) {
      add(entries, folder, entry.name, `${font.name} ${entry.name}`, (signal) => getFontFileBlob(entry.file, { signal }));
      if (entry.ttfName) add(entries, folder, entry.ttfName, `${font.name} ${entry.ttfName}`, (signal) => getFontTtfBlob(entry.file, { signal }));
    }
  }
  return entries;
}

type Loaded = { ok: true; blob: Blob } | { ok: false; error: unknown };

/**
 * Builds the ZIP as a streamed Response. Entries load 6 at a time, in order; an entry that fails is skipped and listed
 * in `result.failed`. `result` settles once the response body has been read to the end (or rejects on abort).
 */
export function buildZip(items: ZipItem[], host: string, options: ZipOptions = {}) {
  const { signal, onProgress, concurrency = 6 } = options;
  const plan = planZip(items, host);
  const failed: ZipFailure[] = [];
  let settle!: { resolve: (value: { failed: ZipFailure[] }) => void; reject: (error: unknown) => void };
  const result = new Promise<{ failed: ZipFailure[] }>((resolve, reject) => {
    settle = { resolve, reject };
  });
  result.catch(() => {});

  async function* entries() {
    try {
      const pending = new Map<number, Promise<Loaded>>();
      let next = 0;
      let bytes = 0;
      for (let i = 0; i < plan.length; i++) {
        signal?.throwIfAborted();
        while (next < plan.length && next < i + concurrency) {
          const entry = plan[next];
          pending.set(
            next,
            entry.load(signal).then(
              (blob): Loaded => ({ ok: true, blob }),
              (error): Loaded => ({ ok: false, error }),
            ),
          );
          next += 1;
        }
        const loaded = await pending.get(i)!;
        pending.delete(i);
        signal?.throwIfAborted();
        if (loaded.ok) bytes += loaded.blob.size;
        onProgress?.(i + 1, plan.length, bytes);
        if (!loaded.ok) {
          failed.push({ name: plan[i].label, path: plan[i].path });
          continue;
        }
        yield { name: plan[i].path, input: loaded.blob, lastModified: new Date() };
      }
      settle.resolve({ failed });
    } catch (error) {
      settle.reject(error);
      throw error;
    }
  }

  const response = clientZip(entries(), { buffersAreUTF8: true });
  return { response, total: plan.length, result };
}

interface SaveFilePickerWindow {
  showSaveFilePicker?: (options: { suggestedName: string; types?: { description: string; accept: Record<string, string[]> }[] }) => Promise<FileSystemFileHandle>;
}

export interface SaveZipResult {
  failed: ZipFailure[];
  cancelled: boolean;
}

/**
 * Asks for a file first when the File System Access API exists (streams to disk), otherwise buffers the ZIP and
 * downloads it. Call it synchronously from the click handler: the picker needs the user gesture.
 */
export async function saveZip(items: ZipItem[], host: string, options: ZipOptions = {}): Promise<SaveZipResult> {
  const name = zipFileName(host);
  const picker = (globalThis as SaveFilePickerWindow).showSaveFilePicker;
  let writable: FileSystemWritableFileStream | null = null;
  if (picker) {
    try {
      const handle = await picker({ suggestedName: name, types: [{ description: "ZIP archive", accept: { "application/zip": [".zip"] } }] });
      writable = await handle.createWritable();
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return { failed: [], cancelled: true };
      writable = null;
    }
  }

  const { response, result } = buildZip(items, host, options);
  if (writable && response.body) {
    await response.body.pipeTo(writable, { signal: options.signal });
  } else {
    const blob = await response.blob();
    saveBlob(blob, name);
  }
  const { failed } = await result;
  return { failed, cancelled: false };
}
