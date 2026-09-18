import { randomUUID } from "node:crypto";
import type { Page } from "playwright-core";
import { type Asset, type Diagnostics, HiddenReason, type PageInfo, type Palette, type ScanEvent, type StepId, type WarningCode } from "@/lib/contract";
import { chunkByBytes } from "@/lib/ndjson";
import { BusyError, readMemAvailableMb, withBrowser } from "@/server/browser/launch";
import { orAfter, untilAborted } from "@/server/async";
import { limits } from "@/server/config/limits";
import { ScanFailure } from "@/server/errors";
import { type EgressProxy, startEgressProxy } from "@/server/net/egress-proxy";
import { safeFetch } from "@/server/net/safe-fetch";
import { createSigner } from "@/server/security/sign";
import { detectBlock, detectChallenge } from "./block";
import { startCapture, type CaptureHandle } from "./capture";
import { buildFallback, directAsset } from "./fallback";
import { buildFontFamilies, signFontFiles } from "./fonts";
import { COLLECTOR_SOURCE } from "./inpage/generated/collector";
import { InPageTimeoutError, runInPage } from "./inpage/run";
import { loadAndScroll, MAX_TITLE_CHARS, openPage, prepareForCollection, readPageFacts, type NavigationResult } from "./navigate";
import { extractPalette } from "./palette";
import { assembleAssets } from "./post/assemble";
import { cutText, MAX_SITE_NAME_CHARS, preflight, type PreflightResult } from "./preflight";
import { NO_ORIGINAL_PROBES } from "./types";
import type { AssetsOutput, CapturedNetwork, CollectorOptions, FontsOutput, PageContext, PostInput, RawCandidate, RawCollectorOutput, RawSvg, SafeFetch, ScanBackend, Signer } from "./types";

export interface ScanEngineDeps {
  fetch: SafeFetch;
  startEgressProxy: (options?: { maxBytes?: number; maxSockets?: number }) => Promise<EgressProxy>;
  withBrowser: typeof withBrowser;
  createSigner: (options?: { max?: number }) => Signer;
  assembleAssets: (input: PostInput) => Promise<AssetsOutput>;
  buildFontFamilies: (input: PostInput) => Promise<FontsOutput>;
  /** `onNull` tells why the palette is null and `onSalvaged` why it is degraded, for the logs and for `diagnostics`. */
  extractPalette: (
    page: Page,
    options: {
      fetch: SafeFetch;
      signal: AbortSignal;
      timeBudgetMs: number;
      onNull?: (reason: string, error?: unknown) => void;
      onSalvaged?: (reason: string, error?: unknown) => void;
    },
  ) => Promise<Palette | null>;
  /** Bundled in-page collector that defines `globalThis.__assetsScraper.collect`. */
  collectorSource: string;
  /** MemAvailable in MB for the memory watchdog (spec 7.3); the watchdog is off without it. */
  readMemAvailableMb?: () => Promise<number | undefined>;
}

const defaultDeps: ScanEngineDeps = {
  fetch: safeFetch,
  startEgressProxy,
  withBrowser,
  createSigner,
  assembleAssets,
  buildFontFamilies,
  extractPalette,
  collectorSource: COLLECTOR_SOURCE,
  // `/proc/meminfo` only exists on Linux.
  readMemAvailableMb: process.platform === "linux" ? readMemAvailableMb : undefined,
};

const WATCHDOG_INTERVAL_MS = 500;

/** The fitted output can differ from the budget by a few characters (see FIT_COLLECTOR_OUTPUT). */
const COLLECTOR_RESULT_SLACK_CHARS = 1_024;
const COLLECTOR_LISTS = ["candidates", "svgs", "fontFaces", "fontStatuses", "fontUsage", "unreadableSheets", "blobs", "brandLinks"] as const;

/**
 * In-page code (a function of the collector output and a budget) that runs right after the collector, in its world.
 * It cuts the title and the site name to one character over their caps (the engine cuts them in Node, see
 * `pageContextFor`), then fits the output in `budget` characters of JSON: over it, list items go until it fits, first
 * the candidates that repeat the URL of an earlier candidate (they only add a use of an asset that stays), then the
 * largest items (the later one among equals), and `stats.truncated` is set. The collector fits its own output in the
 * same budget and order (`CollectorOptions.maxOutputChars`), so this is a safety net for a collector a main-world page
 * replaced or broke: without it, output over the budget would lose the whole collector result.
 *
 * It never stringifies the whole output, which could pass V8's maximum string length and throw: it sums the size of
 * each list item and of the rest, and an item that cannot be stringified (too long, or a cycle) counts as over the
 * budget, so it goes.
 *
 * Measured sizes count a comma per item, one too many for a list that ends up empty, so the loop keeps a character
 * of margin per list it touched and the result never goes over the budget.
 */
export const FIT_COLLECTOR_OUTPUT = `(output, budget) => {
  if (!output || typeof output !== "object") return output;
  const page = output.page;
  if (page && typeof page === "object") {
    if (typeof page.title === "string") page.title = page.title.slice(0, ${MAX_TITLE_CHARS + 1});
    if (typeof page.siteName === "string") page.siteName = page.siteName.slice(0, ${MAX_SITE_NAME_CHARS + 1});
  }
  const sizeOf = (value) => {
    try {
      return (JSON.stringify(value) ?? "null").length;
    } catch {
      return budget + 1;
    }
  };
  const shell = { ...output };
  const items = [];
  const urls = new Set();
  let total = 0;
  for (const key of ${JSON.stringify(COLLECTOR_LISTS)}) {
    const list = output[key];
    if (!Array.isArray(list)) continue;
    shell[key] = [];
    if (list.length > 0) total -= 1;
    for (let index = 0; index < list.length; index += 1) {
      const item = list[index];
      const url = key === "candidates" && item && typeof item.url === "string" ? item.url : undefined;
      const repeat = url !== undefined && urls.has(url);
      if (url !== undefined) urls.add(url);
      const size = sizeOf(item) + 1;
      items.push({ key, index, repeat, size });
      total += size;
    }
  }
  total += sizeOf(shell);
  if (total <= budget) return output;
  items.sort((a, b) => Number(b.repeat) - Number(a.repeat) || b.size - a.size || b.index - a.index);
  const dropped = new Map();
  for (const item of items) {
    if (total + dropped.size <= budget) break;
    if (!dropped.has(item.key)) dropped.set(item.key, new Set());
    dropped.get(item.key).add(item.index);
    total -= item.size;
  }
  for (const [key, indexes] of dropped) output[key] = output[key].filter((_, index) => !indexes.has(index));
  if (output.stats && typeof output.stats === "object") output.stats.truncated = true;
  return output;
}`;

class DeadlineReached extends Error {
  constructor() {
    super("The scan deadline was reached");
    this.name = "DeadlineReached";
  }
}

class LowMemory extends Error {
  constructor() {
    super("Memory ran low during the scan");
    this.name = "LowMemory";
  }
}

class BlockedPage extends Error {
  constructor(readonly reason: string) {
    super(`Blocked: ${reason}`);
    this.name = "BlockedPage";
  }
}

/** Reads the collector output of a scan whose collector never answered: the network capture still gives assets. */
function emptyCollectorOutput(nav: NavigationResult, network: CapturedNetwork): RawCollectorOutput {
  return {
    page: { title: nav.title, baseUrl: nav.finalUrl, elementCount: nav.elementCount },
    candidates: [],
    svgs: [],
    fontFaces: [],
    fontStatuses: [],
    fontUsage: [],
    unreadableSheets: network.sheets.map((sheet) => sheet.url),
    blobs: [],
    brandLinks: [],
    noise: {},
    stats: { elements: 0, ms: 0, truncated: true },
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const isCandidate = (value: unknown): value is RawCandidate =>
  isRecord(value) &&
  typeof value.url === "string" &&
  typeof value.foundIn === "string" &&
  typeof value.visible === "boolean" &&
  typeof value.declaredOnly === "boolean" &&
  Number.isFinite(value.group) &&
  Number.isFinite(value.order) &&
  isRecord(value.context);

const isSvg = (value: unknown): value is RawSvg =>
  isRecord(value) &&
  typeof value.markup === "string" &&
  typeof value.hash === "string" &&
  typeof value.visible === "boolean" &&
  typeof value.referenced === "boolean" &&
  typeof value.hasLiveText === "boolean" &&
  Number.isFinite(value.order) &&
  Number.isFinite(value.usedCount) &&
  Number.isFinite(value.elementCount) &&
  isRecord(value.context);

/**
 * The shape of collector output. A main-world page can overwrite the collector, and a bug can return nothing, so the
 * items of `candidates` and `svgs` are checked too: post-processing walks both and dereferences their fields, and a
 * TypeError there would end a recoverable scan as an `internal` error instead of the network-only partial result every
 * other collector failure degrades to. The other five lists are checked by post-processing itself.
 */
function isCollectorOutput(value: unknown): value is RawCollectorOutput {
  if (!isRecord(value) || !isRecord(value.page) || !isRecord(value.noise) || !isRecord(value.stats)) return false;
  const { page, stats } = value;
  return (
    typeof page.title === "string" &&
    typeof page.baseUrl === "string" &&
    typeof page.elementCount === "number" &&
    typeof stats.truncated === "boolean" &&
    COLLECTOR_LISTS.every((key) => Array.isArray(value[key])) &&
    (value.candidates as unknown[]).every(isCandidate) &&
    (value.svgs as unknown[]).every(isSvg)
  );
}

/**
 * The collector's drop counts as they seed `stats.hidden`: known hidden reasons with whole non-negative counts. A
 * main-world page can replace the collector and return any keys and numbers in `noise`.
 */
export function safeNoise(noise: unknown): RawCollectorOutput["noise"] {
  const kept: RawCollectorOutput["noise"] = {};
  if (!isRecord(noise)) return kept;
  for (const reason of HiddenReason.options) {
    const count = Object.hasOwn(noise, reason) ? noise[reason] : undefined;
    if (Number.isSafeInteger(count) && (count as number) >= 0) kept[reason] = count as number;
  }
  return kept;
}

/** Longest brand link text sent to the client, which shows it on a chip. */
const MAX_BRAND_LINK_TEXT_CHARS = 200;
const MAX_BRAND_LINK_URL_CHARS = 2_048;

/**
 * Brand links as they go to the client (spec 8.1): http and https links with their text, at most `limits.maxBrandLinks`,
 * text trimmed and cut to MAX_BRAND_LINK_TEXT_CHARS. The collector applies these rules already, but a main-world page
 * can replace the collector, so the engine checks its output again before it reaches the UI.
 */
export function safeBrandLinks(links: unknown): PageInfo["brandLinks"] {
  const kept: PageInfo["brandLinks"] = [];
  if (!Array.isArray(links)) return kept;
  const max = limits.maxBrandLinks;
  for (const link of links) {
    if (kept.length >= max) break;
    if (!isRecord(link) || typeof link.href !== "string" || typeof link.text !== "string" || link.href.length > MAX_BRAND_LINK_URL_CHARS) continue;
    let url: URL;
    try {
      url = new URL(link.href);
    } catch {
      continue;
    }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.href.length > MAX_BRAND_LINK_URL_CHARS) continue;
    const text = cutText(link.text.trim(), MAX_BRAND_LINK_TEXT_CHARS);
    kept.push({ href: url.href, text });
  }
  return kept;
}

/**
 * The page as post-processing and the final `page` event see it (spec 7.2 phase 10). The collector's title and site
 * name are cut like the early `page` event's title and the preflight's site name: a page can have a title of megabytes,
 * and a main-world page can replace the collector.
 */
export function pageContextFor(input: { requestedUrl: string; finalUrl: string; collected: RawCollectorOutput["page"]; earlyTitle: string; headSiteName?: string }): PageContext {
  const { collected } = input;
  const title = typeof collected.title === "string" ? cutText(collected.title, MAX_TITLE_CHARS).trim() : "";
  const siteName = typeof collected.siteName === "string" ? cutText(collected.siteName.trim(), MAX_SITE_NAME_CHARS) : "";
  return {
    requestedUrl: input.requestedUrl,
    finalUrl: input.finalUrl,
    host: new URL(input.finalUrl).hostname,
    siteName: siteName || input.headSiteName || "",
    title: title || input.earlyTitle,
  };
}

function mergeCounts(...sources: Partial<Record<string, number>>[]): Record<string, number> {
  const total: Record<string, number> = {};
  for (const source of sources)
    for (const [key, value] of Object.entries(source)) if (typeof value === "number" && value > 0) total[key] = (total[key] ?? 0) + value;
  return total;
}

/** When the engine aborts extractPalette's signal: always past the palette's own budget, which stops it first. */
export const paletteCap = (): number => limits.paletteBudgetMs + limits.paletteOverrunMs;

/**
 * How long page work (preflight and browser, spec 7.2 phases 1 to 9) may run: the scan deadline minus `limits.postGraceMs`,
 * so that at the deadline the scan has already emitted what is ready (spec 7.2).
 */
export function pageWorkMs(deadlineMs: number): number {
  return Math.max(0, deadlineMs - limits.postGraceMs);
}

/**
 * When post-processing (spec 7.2 phase 10) must end. Network work gets up to `limits.verifyMs`, cut so that CPU work
 * still gets `limits.postGraceMs` before the scan deadline; a scan whose page work was stopped by its deadline gets no network
 * time. CPU work (tone, SVG and font parsing) may use the rest of the scan: only the scan deadline stops it, so a slow
 * instance still gives whole results while time is left. Nothing runs past the scan deadline. The exception is reading
 * captured stylesheet text (assets and fonts): it is synchronous per sheet, so the scan deadline's abort cannot stop it,
 * and the engine drops a task that is still running then; it stops at the network deadline with `truncated`, leaving
 * the grace time to the rest. URLs only such an unread sheet declares, `data:` URIs included, are then lost.
 */
export function postProcessingWindow(input: { startedAt: number; now: number; deadlineMs: number; verifyMs: number }): { networkDeadline: number; endsAt: number } {
  const { startedAt, now, deadlineMs, verifyMs } = input;
  const scanEnds = startedAt + deadlineMs;
  const networkDeadline = Math.max(now, Math.min(now + verifyMs, scanEnds - limits.postGraceMs));
  return { networkDeadline, endsAt: scanEnds };
}

/** Internal errors reach the client without their message, which can hold paths or URLs; the server log keeps it. */
function logInternal(error: unknown, scanId?: string): void {
  console.error(scanId ? `Scan ${scanId} failed` : "Scan failed", error);
}

const INTERNAL_MESSAGE = "Something went wrong on our side";

/** Async queue behind the iterator: the pipeline pushes, the consumer pulls. */
function createEventQueue() {
  const items: ScanEvent[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  return {
    push(event: ScanEvent) {
      if (closed) return;
      items.push(event);
      wake?.();
    },
    close() {
      closed = true;
      wake?.();
    },
    async next(): Promise<IteratorResult<ScanEvent>> {
      while (!items.length && !closed) await new Promise<void>((resolve) => (wake = resolve));
      wake = undefined;
      const event = items.shift();
      return event ? { value: event, done: false } : { value: undefined, done: true };
    },
  };
}

interface ScanContext {
  url: string;
  deps: ScanEngineDeps;
  /** Request cancelled or consumer gone: stop at once and emit nothing more. */
  cancel: AbortSignal;
  emit: (event: ScanEvent) => void;
}

async function runScan({ url, deps, cancel, emit }: ScanContext): Promise<void> {
  const startedAt = Date.now();
  const scanId = randomUUID();
  const diagnostics: Diagnostics = {
    scanId,
    cold: false,
    phases: {},
    queueMs: 0,
    egress: { bytes: 0, blocked: 0, refused: 0 },
    bodyTimeouts: 0,
    skippedBodies: 0,
    originals: NO_ORIGINAL_PROBES,
    // Set by the collector when it starts in a world (see onWorld below).
    collector: "none",
    version: process.env.VERCEL_GIT_COMMIT_SHA ?? "dev",
  };
  const deadlineMs = limits.scanDeadlineMs;
  const scanEnds = startedAt + deadlineMs;
  // Page work stops before the scan deadline; post-processing gets the rest and ends by it (see postProcessingWindow).
  const pageDeadline = new AbortController();
  const pageDeadlineTimer = setTimeout(() => pageDeadline.abort(new DeadlineReached()), pageWorkMs(deadlineMs));
  const step = (id: StepId, state: "start" | "done") => emit({ type: "step", step: id, state });
  // Browser work abandoned at the deadline can still finish in the background and record a phase: send a copy.
  const snapshot = (): Diagnostics => structuredClone(diagnostics);
  const timed = async <T>(phase: string, task: () => Promise<T>): Promise<T> => {
    const started = performance.now();
    try {
      return await task();
    } finally {
      diagnostics.phases[phase] = Math.round(performance.now() - started);
    }
  };

  let pre: PreflightResult | undefined;
  let signer: Signer | undefined;
  const getSigner = () => (signer ??= deps.createSigner({ max: limits.maxSignedUrls }));

  try {
    emit({ type: "accepted", scanId, url });
    step("open", "start");

    // Phase 1: preflight.
    pre = await timed("preflight", () => preflight(url, { fetch: deps.fetch, signal: AbortSignal.any([cancel, pageDeadline.signal]) }));
    if (pre.file) {
      throw new ScanFailure("not-html", "This URL is a file, not a page", { fallback: [directAsset({ url: pre.finalUrl, contentType: pre.contentType, signer: getSigner() })] });
    }

    // Phases 2 to 9: browser.
    const browserStage = await runBrowserStage({ url, deps, cancel, emit, pre, diagnostics, deadline: pageDeadline.signal, timed });
    const { nav, network } = browserStage;
    const collector = browserStage.collector ?? emptyCollectorOutput(nav, network);

    // Phase 10: post-processing.
    step("process", "start");
    const context = pageContextFor({ requestedUrl: url, finalUrl: nav.finalUrl, collected: collector.page, earlyTitle: nav.title, headSiteName: pre.head?.siteName });
    const now = Date.now();
    const postWindow = postProcessingWindow({ startedAt, now, deadlineMs, verifyMs: limits.verifyMs });
    const postTimeout = new AbortController();
    const postTimer = setTimeout(() => postTimeout.abort(new DeadlineReached()), postWindow.endsAt - now);
    const postSignal = AbortSignal.any([cancel, postTimeout.signal]);
    const postInput: PostInput = { collector, network, page: context, signer: getSigner(), fetch: deps.fetch, signal: postSignal, deadline: postWindow.networkDeadline };
    /** The output of a task, or undefined when post-processing ran out of time before it finished. */
    const ready = <T>(task: Promise<T>) =>
      untilAborted(task, postSignal).then(
        (value): { value: T } => ({ value }),
        (error: unknown) => {
          if (cancel.aborted || !postTimeout.signal.aborted) throw error;
          return undefined;
        },
      );
    let outputs: [{ value: AssetsOutput } | undefined, { value: FontsOutput } | undefined];
    try {
      outputs = await timed("process", () => Promise.all([ready(deps.assembleAssets(postInput)), ready(deps.buildFontFamilies(postInput))]));
    } finally {
      clearTimeout(postTimer);
    }
    // Out of time, the scan still gives what is ready, as a partial result. With neither assets nor fonts, it is a timeout.
    const [assetsResult, fontsResult] = outputs;
    if (!assetsResult && !fontsResult) throw new ScanFailure("timeout", "Processing the page took too long");
    const processedPartly = !assetsResult || !fontsResult;
    // assembleAssets reports the collector's drops in its own `hidden`; when it ran out of time, they are reported here.
    const assetsOut: AssetsOutput = assetsResult?.value ?? { assets: [], hidden: collector.noise, warnings: [], originals: NO_ORIGINAL_PROBES };
    const fontsOut: FontsOutput = fontsResult?.value ?? { families: [], hidden: {} };
    diagnostics.originals = assetsOut.originals;
    // One signer and cap per scan (spec 11.2): assets sign inside assembleAssets, font files only after it, so the
    // assets keep the priority whichever task finishes first.
    const fontsCapped = signFontFiles(fontsOut.families, postInput.signer);
    step("process", "done");

    // Phase 11: results.
    emitResults(
      { url, nav, context, collector, network, palette: browserStage.palette, assetsOut, fontsOut, fontsCapped, pagePartial: browserStage.partial, processedPartly, diagnostics: snapshot(), startedAt },
      emit,
    );
  } catch (error) {
    if (cancel.aborted) return;
    if (error instanceof BlockedPage) {
      diagnostics.blockReason = error.reason;
      const lookups = AbortSignal.any([cancel, AbortSignal.timeout(Math.max(0, scanEnds - Date.now()))]);
      const fallback = await buildFallback({ host: new URL(url).hostname, head: pre?.head ?? null, fetch: deps.fetch, signer: getSigner(), signal: lookups }).catch(() => []);
      if (cancel.aborted) return;
      emit({ type: "error", code: "blocked", message: "The site blocked the scan", fallback, diagnostics: snapshot() });
    } else if (error instanceof ScanFailure) {
      const { httpStatus, fallback } = error.options;
      emit({ type: "error", code: error.code, message: error.message, ...(httpStatus ? { httpStatus } : {}), ...(fallback ? { fallback } : {}), diagnostics: snapshot() });
    } else if (error instanceof BusyError) {
      emit({ type: "error", code: "busy", message: "All browsers are busy", diagnostics: snapshot() });
    } else if (error instanceof DeadlineReached) {
      emit({ type: "error", code: "timeout", message: "The page took too long to load", diagnostics: snapshot() });
    } else {
      logInternal(error, scanId);
      emit({ type: "error", code: "internal", message: INTERNAL_MESSAGE, diagnostics: snapshot() });
    }
  } finally {
    clearTimeout(pageDeadlineTimer);
  }
}

interface ScanResults {
  url: string;
  nav: NavigationResult;
  context: PageContext;
  collector: RawCollectorOutput;
  network: CapturedNetwork;
  palette: Palette | null;
  assetsOut: AssetsOutput;
  fontsOut: FontsOutput;
  /** The signing cap left some font files without a proxy. */
  fontsCapped: boolean;
  /** Page work stopped early (deadline, memory watchdog, collector failure). */
  pagePartial: boolean;
  /** Post-processing ran out of time before one of its tasks finished. */
  processedPartly: boolean;
  diagnostics: Diagnostics;
  startedAt: number;
}

/** Spec 7.2 phase 11: the final `page`, `palette`, `assets` batches, `fonts`, warnings, then `done`. */
function emitResults(results: ScanResults, emit: (event: ScanEvent) => void): void {
  const { url, nav, context, collector, network, assetsOut, fontsOut, pagePartial, diagnostics } = results;
  const warnings = new Set<WarningCode>(assetsOut.warnings);
  if (results.fontsCapped) warnings.add("truncated");
  let assets: Asset[] = assetsOut.assets;
  if (assets.length > limits.maxAssets) {
    assets = assets.slice(0, limits.maxAssets);
    warnings.add("truncated");
  }
  const faviconAsset = assets.find((asset) => asset.role === "favicon" && (asset.display ?? asset.original));
  const page: PageInfo = {
    requestedUrl: url,
    finalUrl: context.finalUrl,
    host: context.host,
    title: context.title,
    ...(context.siteName ? { siteName: context.siteName } : {}),
    ...(faviconAsset ? { favicon: faviconAsset.display ?? faviconAsset.original ?? undefined } : {}),
    status: nav.status,
    brandLinks: safeBrandLinks(collector.brandLinks),
  };
  emit({ type: "page", page });
  emit({ type: "palette", palette: results.palette });
  const batches = chunkByBytes(assets, limits.ndjsonLineBytes);
  for (const items of batches.length ? batches : [[]]) emit({ type: "assets", items });
  emit({ type: "fonts", families: fontsOut.families });

  const partial = pagePartial || results.processedPartly;
  if (partial) warnings.add("partial");
  if (collector.stats.truncated && !pagePartial) warnings.add("truncated");
  if (network.bodyTimeouts > 0) warnings.add("body-timeout");
  if (diagnostics.collector === "main") warnings.add("collector-fallback");
  for (const code of warnings) emit({ type: "warning", code });

  emit({
    type: "done",
    partial,
    stats: {
      assets: assets.length,
      svg: assets.filter((asset) => asset.kind === "svg").length,
      images: assets.filter((asset) => asset.kind === "image").length,
      fonts: fontsOut.families.length,
      // Spec 8.2, each drop counted once: assembleAssets owns the collector's drops (`collector.noise`: Lottie frames,
      // unreferenced symbols, oversized inline SVGs) and adds them to its own `hidden`, so they are not added again here.
      hidden: mergeCounts(assetsOut.hidden, fontsOut.hidden),
      durationMs: Date.now() - results.startedAt,
    },
    diagnostics,
  });
}

interface BrowserStage {
  nav: NavigationResult;
  palette: Palette | null;
  collector: RawCollectorOutput | undefined;
  network: CapturedNetwork;
  partial: boolean;
}

/**
 * Spec 7.2 phases 2 to 9, inside one browser behind a per-scan egress proxy. When the deadline, the memory watchdog or
 * the collector cap stops the page work after navigation, the stage still returns what exists with `partial: true`.
 * Every step it started gets its `done` once the browser is closed (`collect done` in the normal case, spec 7.2 phase
 * 9), a step cut short included; when it throws, the step in progress stays open and the `error` event ends it.
 */
async function runBrowserStage(input: ScanContext & {
  pre: PreflightResult;
  diagnostics: Diagnostics;
  deadline: AbortSignal;
  timed: <T>(phase: string, task: () => Promise<T>) => Promise<T>;
}): Promise<BrowserStage> {
  const { url, deps, cancel, emit, pre, diagnostics, timed } = input;
  const watchdog = new AbortController();
  const signal = AbortSignal.any([cancel, input.deadline, watchdog.signal]);
  // Spec 7.2 phase 9: settling the body reads and closing the browser share `limits.settleMs`.
  const closeBy = new AbortController();
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  const openSteps = new Set<StepId>();
  /** Emits the step unless page work was stopped: abandoned browser work can still report steps in the background. */
  const step = (id: StepId, state: "start" | "done") => {
    if (signal.aborted) return;
    emit({ type: "step", step: id, state });
    if (state === "start") openSteps.add(id);
    else openSteps.delete(id);
  };

  let capture: CaptureHandle | undefined;
  let nav: NavigationResult | undefined;
  let palette: Palette | null = null;
  let collector: RawCollectorOutput | undefined;
  let network: CapturedNetwork | undefined;
  let partial = false;
  let queuedAt: number | undefined;
  let egress: EgressProxy | undefined;

  let watchdogTimer: ReturnType<typeof setInterval> | undefined;
  /**
   * Spec 7.3: the memory watchdog guards this scan's browser, so it starts once that browser runs. While the scan waits
   * for its slot, the memory belongs to the scan that holds the slot, whose own watchdog frees it.
   */
  const startWatchdog = () => {
    const read = deps.readMemAvailableMb;
    if (!read || watchdogTimer) return;
    watchdogTimer = setInterval(async () => {
      const available = await read().catch(() => undefined);
      if (available !== undefined && available < limits.watchdogMemMb) watchdog.abort(new LowMemory());
    }, WATCHDOG_INTERVAL_MS);
  };

  try {
    await deps.withBrowser(
      {
        // Spec 7.2 phase 3: the proxy starts once the scan has its browser slot, right before the launch.
        egressPort: async () => {
          egress = await deps.startEgressProxy({ maxBytes: limits.egressMaxBytes, maxSockets: limits.egressMaxSockets });
          return egress.port;
        },
        signal,
        closeSignal: closeBy.signal,
        onQueued: () => {
          queuedAt = performance.now();
          step("queue", "start");
        },
        onDequeued: (queueMs) => {
          queuedAt = undefined;
          diagnostics.queueMs = queueMs;
          step("queue", "done");
        },
      },
      async (session) => {
        startWatchdog();
        Object.assign(diagnostics, { cold: session.cold, queueMs: session.queueMs, ...session.health });
        diagnostics.phases.launch = session.launchMs;
        const { page } = session;

        capture = startCapture(page, { signal });
        const opened = await timed("open", () => openPage(page, url, { signal }));
        // Spec 8.9 at domcontentloaded: only the rules that do not depend on how much of the page exists (detectChallenge).
        const challenge = detectChallenge(opened);
        if (challenge) throw new BlockedPage(challenge);
        signal.throwIfAborted();
        nav = opened;
        const host = new URL(opened.finalUrl).hostname;
        emit({
          type: "page",
          page: { requestedUrl: url, finalUrl: opened.finalUrl, host, title: opened.title, ...(pre.head?.siteName ? { siteName: pre.head.siteName } : {}), status: opened.status, brandLinks: [] },
        });
        step("open", "done");

        const stepStarted: Partial<Record<string, number>> = {};
        await loadAndScroll(page, {
          signal,
          onStep: (id, state) => {
            if (state === "start") stepStarted[id] = performance.now();
            else diagnostics.phases[id] = Math.round(performance.now() - (stepStarted[id] ?? performance.now()));
            step(id, state);
          },
          // Every rule once the page has loaded and gone idle: at domcontentloaded an app shell is nearly empty.
          onLoaded: async () => {
            const facts = await readPageFacts(page, { signal });
            const reason = facts && detectBlock({ status: opened.status, headers: opened.headers, title: facts.title, html: facts.htmlSample, elementCount: facts.elementCount });
            if (reason) throw new BlockedPage(reason);
          },
        });

        step("collect", "start");
        await timed("prepare", () => prepareForCollection(page, { signal }));
        const collectEnds = Date.now() + limits.collectMs;
        // The reason goes into diagnostics, not only the runtime log: spec 16 keeps Hobby logs for one hour, so a
        // null palette seen in a scan result is otherwise indistinguishable from a page that has no palette at all.
        const noPalette = (reason: string, error?: unknown) => {
          diagnostics.paletteNull = reason;
          console.warn(`Scan ${diagnostics.scanId} has no palette (${reason})`, ...(error === undefined ? [] : [error]));
        };
        const salvagedPalette = (reason: string) => {
          diagnostics.paletteSalvaged = reason;
          console.warn(`Scan ${diagnostics.scanId} salvaged the palette (${reason})`);
        };
        const stopped = Symbol("palette stopped");
        const paletteCapMs = paletteCap();
        const extraction = deps
          .extractPalette(page, { fetch: deps.fetch, signal: AbortSignal.any([signal, AbortSignal.timeout(paletteCapMs)]), timeBudgetMs: limits.paletteBudgetMs, onNull: noPalette, onSalvaged: salvagedPalette })
          .catch((error: unknown) => {
            noPalette("error", error);
            return null;
          });
        const extracted = await timed("palette", () => untilAborted(orAfter(extraction, paletteCapMs + limits.paletteStopMs, stopped), signal));
        signal.throwIfAborted();
        if (extracted === stopped) noPalette("timeout");
        palette = extracted === stopped ? null : extracted;

        const timeoutMs = Math.max(1_000, collectEnds - Date.now());
        const options: CollectorOptions = {
          host,
          siteName: pre.head?.siteName ?? "",
          timeBudgetMs: Math.max(500, timeoutMs - 1_000),
          maxElements: limits.collectorMaxElements,
          maxSvgNormalizations: limits.svgMaxNormalizations,
          maxSvgBytes: limits.svgMaxBytes,
          maxSvgTotalBytes: limits.svgTotalBytes,
          spriteFetchMs: limits.spriteFetchMs,
          blobFetchMs: limits.blobFetchMs,
          maxTextNodes: limits.collectorMaxTextNodes,
          maxBrandLinks: limits.maxBrandLinks,
          maxBlobBytes: limits.blobMaxBytes,
          maxBlobTotalBytes: limits.blobTotalBytes,
          maxOutputChars: limits.collectorMaxOutputChars,
          maxTitleChars: MAX_TITLE_CHARS,
          maxSiteNameChars: MAX_SITE_NAME_CHARS,
        };
        // The collector cuts its own lists to this budget; FIT_COLLECTOR_OUTPUT fits again in case it did not.
        const budget = limits.collectorMaxOutputChars;
        const expression = `(${FIT_COLLECTOR_OUTPUT})(await globalThis.__assetsScraper.collect(${JSON.stringify(options)}), ${budget})`;
        let world: "isolated" | "main" | undefined;
        try {
          const result = await timed("collect", () =>
            runInPage<unknown>(page, deps.collectorSource, expression, {
              timeoutMs,
              signal,
              maxResultChars: budget + COLLECTOR_RESULT_SLACK_CHARS,
              // Recorded as soon as the collector starts, so diagnostics tell the world of a collector that fails too.
              onWorld: (started) => (world = diagnostics.collector = started),
            }),
          );
          signal.throwIfAborted();
          if (!isCollectorOutput(result.value)) throw new Error("The collector returned something other than collector output");
          collector = { ...result.value, noise: safeNoise(result.value.noise) };
        } catch (error) {
          if (signal.aborted) throw error;
          // Spec 7.3: the collector ran out of time, broke, or lost its page (a crash, an out-of-memory kill, a page
          // that reloads itself). The network capture still holds the page's images, fonts and stylesheets.
          const where = world ? `in the ${world} world` : "before it started";
          if (error instanceof InPageTimeoutError) console.warn(`Scan ${diagnostics.scanId} collector timed out ${where}`);
          else console.error(`Scan ${diagnostics.scanId} collector failed ${where}`, error);
          partial = true;
        }

        closeTimer = setTimeout(() => closeBy.abort(), limits.settleMs);
        network = await timed("settle", () => (capture as CaptureHandle).settle(limits.settleMs));
      },
    );
  } catch (error) {
    // Still waiting for a slot: the queue timed out, or the scan stopped while queued.
    if (queuedAt !== undefined) diagnostics.queueMs = Math.max(1, Math.round(performance.now() - queuedAt));
    if (cancel.aborted) throw cancel.reason;
    if (error instanceof BlockedPage || error instanceof BusyError) throw error;
    const interrupted = input.deadline.aborted || watchdog.signal.aborted;
    if (!interrupted || !nav) throw interrupted ? new ScanFailure("timeout", "The page took too long to load") : error;
    partial = true;
  } finally {
    clearInterval(watchdogTimer);
    clearTimeout(closeTimer);
    if (egress) {
      const proxy = egress;
      const stats = proxy.stats();
      diagnostics.egress = { bytes: stats.bytes, blocked: stats.blocked, refused: stats.refused };
      // Not awaited past its cap: a close that hangs finishes in the background.
      await orAfter((async () => proxy.close())().catch(() => {}), limits.egressCloseMs, undefined);
    }
  }

  if (!nav) throw new ScanFailure("timeout", "The page took too long to load");
  network ??= await (capture as CaptureHandle | undefined)?.settle(0) ?? { images: [], fonts: [], sheets: [], bodyTimeouts: 0, skippedBodies: 0 };
  diagnostics.bodyTimeouts = network.bodyTimeouts;
  diagnostics.skippedBodies = network.skippedBodies;
  for (const id of openSteps) emit({ type: "step", step: id, state: "done" });
  return { nav, palette, collector, network, partial };
}

/**
 * The scan engine (spec 7.2) with injectable dependencies. `scan` streams events and always ends with `done` or
 * `error`, except when the request signal aborts or the consumer stops reading: then it stops at once, kills the
 * browser and ends without a terminal event.
 *
 * Steps: in a scan that ends with `done`, every `step start` has its `step done`, a step cut short by the deadline or
 * the memory watchdog included (`done.partial` tells). A step that never started (collection, when the deadline hits
 * during the scroll) is not reported. An `error` event, or a cancelled scan, can leave the step in progress without
 * its `done`: the terminal event ends it.
 */
export function createScanEngine(overrides: Partial<ScanEngineDeps> = {}): ScanBackend {
  const deps: ScanEngineDeps = { ...defaultDeps, ...overrides };
  return {
    scan(input, options) {
      return {
        [Symbol.asyncIterator](): AsyncIterator<ScanEvent> {
          const stop = new AbortController();
          const cancel = AbortSignal.any([options.signal, stop.signal]);
          const queue = createEventQueue();
          let running: Promise<void> | undefined;
          const start = () =>
            (running ??= runScan({ url: input.url, deps, cancel, emit: (event) => !cancel.aborted && queue.push(event) })
              .catch((error: unknown) => {
                if (cancel.aborted) return;
                logInternal(error);
                queue.push({ type: "error", code: "internal", message: INTERNAL_MESSAGE });
              })
              .finally(() => queue.close()));
          const cleanup = async () => {
            await orAfter(running ?? Promise.resolve(), limits.cancelCleanupMs, undefined);
            return { value: undefined, done: true } as const;
          };
          return {
            async next() {
              start();
              if (cancel.aborted) return cleanup();
              const result = await queue.next();
              return cancel.aborted ? cleanup() : result;
            },
            async return() {
              stop.abort(new Error("The scan stream was closed"));
              queue.close();
              return cleanup();
            },
          };
        },
      };
    },
  };
}

export const scanEngine: ScanBackend = createScanEngine();
