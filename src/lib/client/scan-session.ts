import { normalizeInputUrl } from "@/lib/url";
import { revokePreviewUrls } from "./preview-urls";
import { addRecent, readRecent, removeRecent } from "./recent";
import { startScan, type ScanHandle } from "./scan-client";
import { appStore } from "./store";

/** Spec 13: the inline message under the input for `invalid-url`. */
export const INVALID_URL_MESSAGE = "Enter a web address, like linear.app";

let current: ScanHandle | null = null;

/** `&asset=<id>` from the address bar waits for the scan to end. It belongs to the scan in flight and dies with it. */
let pendingDetail: string | null = null;

/** Opens the pending `&asset=<id>` once the scan has ended, with results or with an error that still carries assets. */
function openPendingDetail() {
  const id = pendingDetail;
  pendingDetail = null;
  // Does nothing when the scan has no such asset; the detail view then drops `&asset` from the address bar.
  if (id) appStore.getState().openDetail(id);
}

type HistoryMode = "push" | "replace" | "none";

/** `/?url=<encoded>`, plus `&asset=<id>` while a detail view is open (spec 12.1). */
export function shareablePath(url: string, assetId?: string | null): string {
  const params = new URLSearchParams({ url });
  if (assetId) params.set("asset", assetId);
  return `/?${params.toString()}`;
}

function writeHistory(path: string, mode: HistoryMode) {
  if (mode === "none" || typeof window === "undefined") return;
  if (`${window.location.pathname}${window.location.search}` === path && mode === "push") return;
  if (mode === "push") window.history.pushState(null, "", path);
  else window.history.replaceState(null, "", path);
}

/**
 * Starts a scan of an already normalized URL. Any scan in flight is aborted first. `detail` is an asset id from the
 * address bar to open when the scan ends.
 */
export function runScan(url: string, host: string, history: HistoryMode = "push", detail: string | null = null): void {
  current?.abort();
  revokePreviewUrls();
  pendingDetail = detail;
  const store = appStore.getState();
  store.beginScan({ url, host });
  writeHistory(shareablePath(url), history);

  const handle = startScan(url, {
    onEvent(event) {
      appStore.getState().applyEvent(event);
      if (event.type === "done") {
        appStore.getState().setRecent(addRecent(host));
        openPendingDetail();
      }
    },
    onError(error) {
      if (error.code === "invalid-url") {
        // The gate disagreed with the client normalization: back to the landing with the inline message.
        pendingDetail = null;
        appStore.getState().reset(url);
        appStore.getState().setInputError(INVALID_URL_MESSAGE);
        writeHistory("/", "replace");
        return;
      }
      appStore.getState().failScan(error);
      // A timeout can keep its assets and a blocked site its public-source fallback: both can open in detail.
      openPendingDetail();
    },
    onRetry() {
      appStore.getState().restartAttempt();
    },
  });
  current = handle;
  void handle.done.then(() => {
    if (current === handle) current = null;
  });
}

/**
 * Normalizes user input and scans it. When the input is not a URL it only shows the inline error under the field the
 * user typed in (spec 13 `invalid-url`) and returns false: a scan in flight, its results and the address bar stay.
 */
export function submitUrl(raw: string, history: HistoryMode = "push"): boolean {
  const result = normalizeInputUrl(raw);
  if (!result.ok) {
    const store = appStore.getState();
    store.setInput(raw);
    store.setInputError(INVALID_URL_MESSAGE);
    return false;
  }
  runScan(result.url, result.host, history);
  return true;
}

export function rescan(): void {
  const { url, host } = appStore.getState();
  if (url && host) runScan(url, host, "none");
}

/** Cancel returns to the landing with the URL kept in the input (spec 12.2). */
export function cancelScan(): void {
  current?.abort();
  current = null;
  pendingDetail = null;
  const { url, input } = appStore.getState();
  appStore.getState().reset(url ?? input);
  writeHistory("/", "push");
}

export function goHome(): void {
  current?.abort();
  current = null;
  pendingDetail = null;
  appStore.getState().reset("");
  writeHistory("/", "push");
}

export function forgetRecent(host: string): void {
  appStore.getState().setRecent(removeRecent(host));
}

/**
 * Reads the address bar: `?url=` scans (after hydration), no param shows the landing. Runs on load and on back and
 * forward navigation, so history entries behave like pages.
 */
export function syncFromLocation(): void {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get("url");
  const store = appStore.getState();
  if (!raw) {
    if (store.phase !== "idle") {
      current?.abort();
      current = null;
      pendingDetail = null;
      store.reset(store.url ?? store.input);
    }
    return;
  }
  const result = normalizeInputUrl(raw);
  if (!result.ok) {
    // `/?url=` with something that is not a URL: the landing with the inline message, at `/` like any landing.
    current?.abort();
    current = null;
    pendingDetail = null;
    store.reset(raw);
    appStore.getState().setInputError(INVALID_URL_MESSAGE);
    writeHistory("/", "replace");
    return;
  }
  const asset = params.get("asset");
  if (store.url === result.url && store.phase !== "idle") {
    if (store.phase === "scanning") pendingDetail = asset;
    else if (asset) store.openDetail(asset);
    return;
  }
  runScan(result.url, result.host, "none", asset);
}

let bootstrapped = false;

/** Runs once per page load (React StrictMode runs effects twice in development, which would scan twice). */
export function bootstrap(): void {
  if (bootstrapped) return;
  bootstrapped = true;
  const store = appStore.getState();
  store.loadPreferences();
  store.setRecent(readRecent());
  syncFromLocation();
  appStore.getState().setBooted();
}

/** Keeps `&asset=` in the address bar in step with the detail view, without adding history entries. */
export function syncDetailToLocation(detailId: string | null): void {
  const { url } = appStore.getState();
  if (!url || typeof window === "undefined") return;
  const params = new URLSearchParams(window.location.search);
  if (params.get("url") === null) return;
  if ((params.get("asset") ?? null) === detailId) return;
  window.history.replaceState(null, "", shareablePath(url, detailId));
}
