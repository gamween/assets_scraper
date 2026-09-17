import { randomUUID } from "node:crypto";
import type { Page } from "playwright-core";
import type { Asset, Diagnostics, PageInfo, Palette, ScanEvent, StepId, WarningCode } from "@/lib/contract";
import { chunkByBytes } from "@/lib/ndjson";
import { BusyError, readMemAvailableMb, withBrowser } from "@/server/browser/launch";
import { limits } from "@/server/config/limits";
import { ScanFailure } from "@/server/errors";
import { type EgressProxy, startEgressProxy } from "@/server/net/egress-proxy";
import { safeFetch } from "@/server/net/safe-fetch";
import { createSigner } from "@/server/security/sign";
import { detectBlock, detectChallenge } from "./block";
import { startCapture, type CaptureHandle } from "./capture";
import { buildFallback, directAsset } from "./fallback";
import { buildFontFamilies } from "./fonts";
import { COLLECTOR_SOURCE } from "./inpage/generated/collector";
import { InPageTimeoutError, runInPage } from "./inpage/run";
import { loadAndScroll, openPage, prepareForCollection, readPageFacts, type NavigationResult } from "./navigate";
import { extractPalette } from "./palette";
import { assembleAssets } from "./post/assemble";
import { preflight, type PreflightResult } from "./preflight";
import type { AssetsOutput, CapturedNetwork, CollectorOptions, FontsOutput, PageContext, PostInput, RawCollectorOutput, SafeFetch, ScanBackend, Signer } from "./types";

export interface ScanEngineDeps {
  fetch: SafeFetch;
  startEgressProxy: (options?: { maxBytes?: number; maxSockets?: number }) => Promise<EgressProxy>;
  withBrowser: typeof withBrowser;
  createSigner: (options?: { max?: number }) => Signer;
  assembleAssets: (input: PostInput) => Promise<AssetsOutput>;
  buildFontFamilies: (input: PostInput) => Promise<FontsOutput>;
  extractPalette: (page: Page, options: { fetch: SafeFetch; signal: AbortSignal; timeBudgetMs: number }) => Promise<Palette | null>;
  /** Bundled in-page collector that defines `globalThis.__assetsScraper.collect`. */
  collectorSource: string;
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
};

/** Palette signals take about 200 ms (spec 10); this is its share of the 15 s collection cap. */
const PALETTE_BUDGET_MS = 3_000;
/** The engine's own stop for the palette phase, in case extractPalette overruns its budget. */
const PALETTE_CAP_MS = PALETTE_BUDGET_MS + 1_000;
/**
 * CPU time post-processing gets after its network deadline. Page work stops this long before the scan deadline, so
 * that what it gathered still turns into results by the deadline.
 */
const POST_GRACE_MS = 5_000;
/** How long a cancelled scan waits for its cleanup (browser kill, proxy close) before the stream ends anyway. */
const CANCEL_CLEANUP_MS = 10_000;
const WATCHDOG_INTERVAL_MS = 500;
const MB = 1024 * 1024;

/**
 * Largest collector result in characters of JSON: its byte caps (blob bytes as base64, inline SVG markup with every
 * character escaped at worst) plus room for candidates, font rules and links.
 */
const collectorResultChars = () => Math.ceil((limits.blobTotalBytes * 4) / 3) + 2 * limits.svgTotalBytes + 16 * MB;

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

/** Settles like `promise`, or rejects with the abort reason as soon as the signal aborts. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  promise.catch(() => {});
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
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

function mergeCounts(...sources: Partial<Record<string, number>>[]): Record<string, number> {
  const total: Record<string, number> = {};
  for (const source of sources)
    for (const [key, value] of Object.entries(source)) if (typeof value === "number" && value > 0) total[key] = (total[key] ?? 0) + value;
  return total;
}

/** Resolves like `promise`, or with `fallback` once `ms` have passed. */
function orAfter<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((resolve) => (timer = setTimeout(() => resolve(fallback), ms)));
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/**
 * How long page work (preflight and browser, spec 7.2 phases 1 to 9) may run: the scan deadline minus POST_GRACE_MS,
 * so that at the deadline the scan has already emitted what is ready (spec 7.2).
 */
export function pageWorkMs(deadlineMs: number): number {
  return Math.max(0, deadlineMs - POST_GRACE_MS);
}

/**
 * When post-processing (spec 7.2 phase 10) must end. Network work gets up to `limits.verifyMs`, then CPU work gets
 * POST_GRACE_MS. Network time is cut so that both end by the scan deadline; a scan whose page work was stopped by its
 * deadline gets no network time. Nothing runs past the scan deadline.
 */
export function postProcessingWindow(input: { startedAt: number; now: number; deadlineMs: number; verifyMs: number }): { networkDeadline: number; endsAt: number } {
  const { startedAt, now, deadlineMs, verifyMs } = input;
  const scanEnds = startedAt + deadlineMs;
  const networkDeadline = Math.max(now, Math.min(now + verifyMs, scanEnds - POST_GRACE_MS));
  return { networkDeadline, endsAt: Math.min(networkDeadline + POST_GRACE_MS, scanEnds) };
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
    egress: { bytes: 0, blocked: 0 },
    bodyTimeouts: 0,
    collector: "isolated",
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
    let { collector } = browserStage;
    const partial = browserStage.partial;
    collector ??= emptyCollectorOutput(nav, network);
    // Steps stay in pairs: page work stopped before collection (during scroll, say) never started the collect step.
    if (browserStage.collectStarted) step("collect", "done");

    // Phase 10: post-processing.
    step("process", "start");
    const finalUrl = nav.finalUrl;
    const host = new URL(finalUrl).hostname;
    const context: PageContext = { requestedUrl: url, finalUrl, host, siteName: collector.page.siteName ?? pre.head?.siteName ?? "", title: collector.page.title || nav.title };
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
    const assetsOut: AssetsOutput = assetsResult?.value ?? { assets: [], hidden: collector.noise, warnings: [] };
    const fontsOut: FontsOutput = fontsResult?.value ?? { families: [], hidden: {} };
    step("process", "done");

    // Phase 11: results.
    const warnings = new Set<WarningCode>(assetsOut.warnings);
    let assets: Asset[] = assetsOut.assets;
    if (assets.length > limits.maxAssets) {
      assets = assets.slice(0, limits.maxAssets);
      warnings.add("truncated");
    }
    const faviconAsset = assets.find((asset) => asset.role === "favicon" && (asset.display ?? asset.original));
    const page: PageInfo = {
      requestedUrl: url,
      finalUrl,
      host,
      title: context.title,
      ...(context.siteName ? { siteName: context.siteName } : {}),
      ...(faviconAsset ? { favicon: faviconAsset.display ?? faviconAsset.original ?? undefined } : {}),
      status: nav.status,
      brandLinks: collector.brandLinks,
    };
    emit({ type: "page", page });
    emit({ type: "palette", palette: browserStage.palette });
    const batches = chunkByBytes(assets, limits.ndjsonLineBytes);
    for (const items of batches.length ? batches : [[]]) emit({ type: "assets", items });
    emit({ type: "fonts", families: fontsOut.families });

    const isPartial = partial || processedPartly;
    if (isPartial) warnings.add("partial");
    if (collector.stats.truncated && !partial) warnings.add("truncated");
    if (network.bodyTimeouts > 0) warnings.add("body-timeout");
    if (diagnostics.collector === "main") warnings.add("collector-fallback");
    for (const code of warnings) emit({ type: "warning", code });

    emit({
      type: "done",
      partial: isPartial,
      stats: {
        assets: assets.length,
        svg: assets.filter((asset) => asset.kind === "svg").length,
        images: assets.filter((asset) => asset.kind === "image").length,
        fonts: fontsOut.families.length,
        // Spec 8.2, each drop counted once: assembleAssets owns the collector's drops (`collector.noise`: Lottie frames,
        // unreferenced symbols, oversized inline SVGs) and adds them to its own `hidden`, so they are not added again here.
        hidden: mergeCounts(assetsOut.hidden, fontsOut.hidden),
        durationMs: Date.now() - startedAt,
      },
      diagnostics: snapshot(),
    });
  } catch (error) {
    if (cancel.aborted) return;
    if (error instanceof BlockedPage) {
      diagnostics.blockReason = error.reason;
      const lookups = AbortSignal.any([cancel, AbortSignal.timeout(Math.max(0, scanEnds - Date.now()))]);
      const fallback = await buildFallback({ host: new URL(url).hostname, pageUrl: url, head: pre?.head ?? null, fetch: deps.fetch, signer: getSigner(), signal: lookups }).catch(() => []);
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

interface BrowserStage {
  nav: NavigationResult;
  palette: Palette | null;
  collector: RawCollectorOutput | undefined;
  network: CapturedNetwork;
  partial: boolean;
  /** Whether `step collect start` went out. */
  collectStarted: boolean;
}

/**
 * Spec 7.2 phases 2 to 9, inside one browser behind a per-scan egress proxy. When the deadline, the memory watchdog or
 * the collector cap stops the page work after navigation, the stage still returns what exists with `partial: true`.
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
  /** Emits the step unless page work was stopped, and tells whether it did. */
  const step = (id: StepId, state: "start" | "done"): boolean => {
    if (signal.aborted) return false;
    emit({ type: "step", step: id, state });
    return true;
  };

  let capture: CaptureHandle | undefined;
  let nav: NavigationResult | undefined;
  let palette: Palette | null = null;
  let collector: RawCollectorOutput | undefined;
  let network: CapturedNetwork | undefined;
  let partial = false;
  let collectStarted = false;
  let queuedAt: number | undefined;
  let egress: EgressProxy | undefined;

  const watchdogTimer = process.platform === "linux" ? setInterval(() => void checkMemory(), WATCHDOG_INTERVAL_MS) : undefined;
  async function checkMemory() {
    const available = await readMemAvailableMb();
    if (available !== undefined && available < limits.watchdogMemMb) watchdog.abort(new LowMemory());
  }

  try {
    await deps.withBrowser(
      {
        // Spec 7.2 phase 3: the proxy starts once the scan has its browser slot, right before the launch.
        egressPort: async () => {
          egress = await deps.startEgressProxy({ maxBytes: limits.egressMaxBytes, maxSockets: limits.egressMaxSockets });
          return egress.port;
        },
        signal,
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
        Object.assign(diagnostics, { cold: session.cold, queueMs: session.queueMs, ...session.health });
        diagnostics.phases.launch = session.launchMs;
        const { page } = session;

        capture = startCapture(page, { signal });
        const opened = await timed("open", () => openPage(page, url, { signal }));
        // Spec 8.9 at domcontentloaded: only the header and title rules, which do not depend on how much of the page exists.
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

        collectStarted = step("collect", "start");
        await timed("prepare", () => prepareForCollection(page, { signal }));
        const collectEnds = Date.now() + limits.collectMs;
        const extracted = await timed("palette", () =>
          untilAborted(orAfter(deps.extractPalette(page, { fetch: deps.fetch, signal, timeBudgetMs: PALETTE_BUDGET_MS }), PALETTE_CAP_MS, null), signal).catch((error: unknown) => {
            if (signal.aborted) throw error;
            return null;
          }),
        );
        signal.throwIfAborted();
        palette = extracted;

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
          maxBrandLinks: limits.maxBrandLinks,
          maxBlobBytes: limits.blobMaxBytes,
          maxBlobTotalBytes: limits.blobTotalBytes,
        };
        try {
          const result = await timed("collect", () =>
            runInPage<RawCollectorOutput>(page, deps.collectorSource, `globalThis.__assetsScraper.collect(${JSON.stringify(options)})`, { timeoutMs, signal, maxResultChars: collectorResultChars() }),
          );
          signal.throwIfAborted();
          collector = result.value;
          diagnostics.collector = result.world;
        } catch (error) {
          if (!(error instanceof InPageTimeoutError) || signal.aborted) throw error;
          partial = true;
        }

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
    if (egress) {
      const stats = egress.stats();
      diagnostics.egress = { bytes: stats.bytes, blocked: stats.blocked };
      await egress.close().catch(() => {});
    }
  }

  if (!nav) throw new ScanFailure("timeout", "The page took too long to load");
  network ??= await (capture as CaptureHandle | undefined)?.settle(0) ?? { images: [], fonts: [], sheets: [], bodyTimeouts: 0, skippedBodies: 0 };
  diagnostics.bodyTimeouts = network.bodyTimeouts;
  return { nav, palette, collector, network, partial, collectStarted };
}

/**
 * The scan engine (spec 7.2) with injectable dependencies. `scan` streams events and always ends with `done` or
 * `error`, except when the request signal aborts or the consumer stops reading: then it stops at once, kills the
 * browser and ends without a terminal event.
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
            let timer: ReturnType<typeof setTimeout> | undefined;
            await Promise.race([running, new Promise<void>((resolve) => (timer = setTimeout(resolve, CANCEL_CLEANUP_MS)))]);
            clearTimeout(timer);
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
