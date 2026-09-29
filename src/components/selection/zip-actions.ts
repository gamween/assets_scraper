"use client";

import { notify } from "@/components/results/asset-actions";
import { toast, toastKeyboardHint } from "@/components/ui/toast";
import { formatBytes, formatCount } from "@/lib/format";
import { assetBytes, assetKey, fontBytes, fontKey } from "@/lib/client/filters";
import { appStore, getDownloadAllItems, type AppState, type ZipProgress } from "@/lib/client/store";
import { planZip, saveZip, type ZipFailure, type ZipItem } from "@/lib/client/zip";
import { beginZipJob, cancelZipJob, isCurrentZipJob, settleZipJob, type ZipAbortReason } from "@/lib/client/zip-job";

const LARGE_ZIP_BYTES = 300 * 1024 * 1024;

const toZipItem = (item: ReturnType<typeof getDownloadAllItems>[number]): ZipItem =>
  item.kind === "asset" ? { type: "asset", asset: item.asset } : { type: "font", font: item.font };

/** Selected items in page order, across tabs and searches (the selection survives both). */
export function selectedItems(state: AppState = appStore.getState()): ZipItem[] {
  const assets = state.assets.length ? state.assets : (state.error?.fallback ?? []);
  return [
    ...assets.filter((asset) => state.selection.has(assetKey(asset.id))).map((asset): ZipItem => ({ type: "asset", asset })),
    ...state.fonts.filter((font) => state.selection.has(fontKey(font.id))).map((font): ZipItem => ({ type: "font", font })),
  ];
}

/**
 * Total bytes of the files these items download, or `null` when the scan recorded no size for at least one of them:
 * a partial sum reads as the whole and is worse than no number at all (three stripe.com assets summed to 3.2 KB for
 * a 4.2 MB ZIP). Callers print a size only for a number.
 */
export function itemsBytes(items: ZipItem[]): number | null {
  let sum = 0;
  for (const item of items) {
    const bytes = item.type === "asset" ? assetBytes(item.asset) : fontBytes(item.font);
    if (!bytes) return null;
    sum += bytes;
  }
  return sum;
}

/** Stays until dismissed or replaced, so a keyboard user has the time to reach `Show` (F6, then Tab). */
function showFailures(failed: ZipFailure[]) {
  toast.add({
    title: `${formatCount(failed.length, "file")} couldn't be downloaded`,
    description: toastKeyboardHint("Show"),
    timeout: 0,
    priority: "high",
    actionProps: { children: "Show", onClick: () => appStore.getState().setZipFailures(failed) },
  });
}

/**
 * Spec 12.4: builds the ZIP in the browser. Call from the click handler itself: the save picker needs the gesture.
 * Progress goes to the store (`Zipping 18 of 48`), failures to a toast with `Show`, both only while the job is still
 * the current one: leaving the results drops it (see zip-job), and the next scan's state is not its to write.
 */
function startZip(items: ZipItem[], source: ZipProgress["source"]) {
  const state = appStore.getState();
  if (!items.length || state.zip) return;
  const host = state.page?.host ?? state.host ?? "site";
  const total = planZip(items, host).length;
  if (!total) {
    notify("Nothing here can be downloaded");
    return;
  }
  // Only the blob path holds the whole archive in memory. The planned size is unknown whenever one file was never
  // sized by the scan, so the same warning also watches what the entries actually weigh as they load, which the
  // `Cancel` link can still act on.
  const buffered = typeof (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker !== "function";
  const bytes = itemsBytes(items);
  let warned = false;
  const warnLarge = (size: number) => {
    warned = true;
    notify(`Large ZIP (${formatBytes(size)})`, { description: "Your browser keeps it in memory until it is saved." });
  };
  if (buffered && bytes !== null && bytes > LARGE_ZIP_BYTES) warnLarge(bytes);

  const job = beginZipJob();
  state.setZip({ source, done: 0, total });
  void saveZip(items, host, {
    signal: job.signal,
    onProgress: (done, count, loaded) => {
      if (!isCurrentZipJob(job)) return;
      appStore.getState().setZip({ source, done, total: count });
      if (buffered && !warned && loaded > LARGE_ZIP_BYTES) warnLarge(loaded);
    },
  })
    .then(({ failed }) => {
      if (isCurrentZipJob(job) && failed.length) showFailures(failed);
    })
    .catch((error: unknown) => {
      // Leaving the results is not a click on Cancel: say where the ZIP went. A picker save is discarded, not cut.
      if ((job.signal.reason as ZipAbortReason | undefined) === "left") return notify("ZIP cancelled", { description: "It stopped when the results were closed." });
      if (job.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
      if (isCurrentZipJob(job)) notify("The ZIP couldn't be created", { error: true });
    })
    .finally(() => {
      if (settleZipJob(job)) appStore.getState().setZip(null);
    });
}

/** `Download all`: every item of the current tab, whatever the search; small icons only when expanded. */
export function downloadAll() {
  startZip(getDownloadAllItems(appStore.getState()).map(toZipItem), "all");
}

export function downloadSelection() {
  startZip(selectedItems(), "selection");
}

export function cancelZip() {
  cancelZipJob();
}
