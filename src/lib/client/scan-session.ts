import { normalizeInputUrl, type UrlInputResult } from "@/lib/url";
import { revokePreviewUrls } from "./preview-urls";
import { addRecent, readRecent, removeRecent } from "./recent";
import { startScan, type ScanHandle } from "./scan-client";
import { appStore } from "./store";
import { dropZipJob } from "./zip-job";

/** Spec 13: the inline message under the input for `invalid-url`. */
export const INVALID_URL_MESSAGE = "Enter a web address, like linear.app";
/** Spec 13 `unsupported-port`, inline: the address is a web address, and its port is what cannot be scanned. */
export const UNSUPPORTED_PORT_MESSAGE = "Only ports 80 and 443 are supported";

const inputMessage = (code: Extract<UrlInputResult, { ok: false }>["code"]) => (code === "unsupported-port" ? UNSUPPORTED_PORT_MESSAGE : INVALID_URL_MESSAGE);

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

/**
 * Ends what belongs to the results on screen, before a new scan or the landing replaces them: the scan in flight, the
 * `&asset=` waiting for it, a ZIP being built from them, and the object URLs of their inline previews. The store
 * resets itself; this is everything it holds no reference to.
 */
function leaveResults() {
  current?.abort();
  current = null;
  pendingDetail = null;
  dropZipJob();
  revokePreviewUrls();
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
  leaveResults();
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
 * Normalizes user input and scans it. When the input cannot be scanned it only shows the inline error under the field
 * the user typed in (spec 13 `invalid-url`, `unsupported-port`) and returns false: a scan in flight, its results and
 * the address bar stay.
 */
export function submitUrl(raw: string, history: HistoryMode = "push"): boolean {
  const result = normalizeInputUrl(raw);
  if (!result.ok) {
    const store = appStore.getState();
    store.setInput(raw);
    store.setInputError(inputMessage(result.code));
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
  leaveResults();
  const { url, input } = appStore.getState();
  appStore.getState().reset(url ?? input);
  writeHistory("/", "push");
}

export function goHome(): void {
  leaveResults();
  appStore.getState().reset("");
  writeHistory("/", "push");
}

export function forgetRecent(host: string): void {
  appStore.getState().setRecent(removeRecent(host));
}

/**
 * Reads the address bar: `?url=` scans (after hydration), no param shows the landing. Runs on load and on back and
 * forward navigation, so history entries behave like pages: within the same results, `&asset=` opens the detail view
 * and its absence closes it (see `syncDetailToLocation`).
 */
export function syncFromLocation(): void {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get("url");
  const store = appStore.getState();
  if (!raw) {
    if (store.phase !== "idle") {
      leaveResults();
      store.reset(store.url ?? store.input);
    }
    return;
  }
  const result = normalizeInputUrl(raw);
  if (!result.ok) {
    // `/?url=` with something that cannot be scanned: the landing with the inline message, at `/` like any landing.
    leaveResults();
    store.reset(raw);
    appStore.getState().setInputError(inputMessage(result.code));
    writeHistory("/", "replace");
    return;
  }
  const asset = params.get("asset");
  if (store.url === result.url && store.phase !== "idle") {
    if (store.phase === "scanning") pendingDetail = asset;
    else if (asset) store.openDetail(asset);
    else if (store.detailId) store.closeDetail();
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

/**
 * `history.state` of the entry the page pushes when it opens a detail view. Only an entry marked so is gone back over
 * when the view closes: a detail opened from a shared `&asset=` link has none, and going back there would leave the
 * app. Next keeps the keys of a state it is given and adds its own.
 */
const DETAIL_ENTRY = "detailEntry";

const onDetailEntry = () => (window.history.state as Record<string, unknown> | null)?.[DETAIL_ENTRY] === true;

/**
 * Keeps `&asset=` in the address bar in step with the detail view. Opening one pushes an entry, so Back closes the view
 * and keeps the results: on a phone the view is a full-screen sheet, and the Back gesture used to leave the results
 * for the landing. Moving to another asset replaces the entry, and closing the view from the page goes back over it,
 * so Close and Back leave the same history behind.
 */
export function syncDetailToLocation(detailId: string | null): void {
  const { url } = appStore.getState();
  if (!url || typeof window === "undefined") return;
  const params = new URLSearchParams(window.location.search);
  if (params.get("url") === null) return;
  const shown = params.get("asset");
  if (shown === detailId) return;
  if (detailId === null) {
    if (onDetailEntry()) window.history.back();
    else window.history.replaceState(null, "", shareablePath(url));
  } else if (shown === null) {
    window.history.pushState({ [DETAIL_ENTRY]: true }, "", shareablePath(url, detailId));
  } else {
    window.history.replaceState(onDetailEntry() ? { [DETAIL_ENTRY]: true } : null, "", shareablePath(url, detailId));
  }
}
