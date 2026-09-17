"use client";

import { notify } from "@/components/results/asset-actions";
import { toast } from "@/components/ui/toast";
import { formatBytes, formatCount } from "@/lib/format";
import { assetBytes, assetKey, fontBytes, fontKey } from "@/lib/client/filters";
import { appStore, getVisibleItems, type AppState, type ZipProgress } from "@/lib/client/store";
import { planZip, saveZip, type ZipFailure, type ZipItem } from "@/lib/client/zip";

const LARGE_ZIP_BYTES = 300 * 1024 * 1024;

let controller: AbortController | null = null;

const toZipItem = (item: ReturnType<typeof getVisibleItems>[number]): ZipItem =>
  item.kind === "asset" ? { type: "asset", asset: item.asset } : { type: "font", font: item.font };

/** Selected items in page order, across tabs and searches (the selection survives both). */
export function selectedItems(state: AppState = appStore.getState()): ZipItem[] {
  const assets = state.assets.length ? state.assets : (state.error?.fallback ?? []);
  return [
    ...assets.filter((asset) => state.selection.has(assetKey(asset.id))).map((asset): ZipItem => ({ type: "asset", asset })),
    ...state.fonts.filter((font) => state.selection.has(fontKey(font.id))).map((font): ZipItem => ({ type: "font", font })),
  ];
}

export function itemsBytes(items: ZipItem[]): number {
  return items.reduce((sum, item) => sum + (item.type === "asset" ? assetBytes(item.asset) : fontBytes(item.font)), 0);
}

function showFailures(failed: ZipFailure[]) {
  toast.add({
    title: `${formatCount(failed.length, "file")} couldn't be downloaded`,
    timeout: 8000,
    priority: "high",
    actionProps: { children: "Show", onClick: () => appStore.getState().setZipFailures(failed) },
  });
}

/**
 * Spec 12.4: builds the ZIP in the browser. Call from the click handler itself: the save picker needs the gesture.
 * Progress goes to the store (`Zipping 18 of 48`), failures to a toast with `Show`.
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
  const bytes = itemsBytes(items);
  if (bytes > LARGE_ZIP_BYTES && typeof (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker !== "function") {
    notify(`Large ZIP (${formatBytes(bytes)})`, { description: "Your browser keeps it in memory until it is saved." });
  }

  const current = new AbortController();
  controller = current;
  state.setZip({ source, done: 0, total });
  void saveZip(items, host, {
    signal: current.signal,
    onProgress: (done, count) => appStore.getState().setZip({ source, done, total: count }),
  })
    .then(({ failed }) => {
      if (failed.length) showFailures(failed);
    })
    .catch((error: unknown) => {
      if (current.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
      notify("The ZIP couldn't be created", { error: true });
    })
    .finally(() => {
      if (controller === current) controller = null;
      appStore.getState().setZip(null);
    });
}

/** `Download all`: every item of the current tab and search; collapsed sections stay out. */
export function downloadAll() {
  startZip(getVisibleItems(appStore.getState()).map(toZipItem), "all");
}

export function downloadSelection() {
  startZip(selectedItems(), "selection");
}

export function cancelZip() {
  controller?.abort();
}
