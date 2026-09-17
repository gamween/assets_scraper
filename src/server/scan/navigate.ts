import type { Page } from "playwright-core";
import { limits } from "@/server/config/limits";
import { ScanFailure } from "@/server/errors";

export interface NavigationResult {
  status: number;
  finalUrl: string;
  title: string;
  headers: Record<string, string>;
  elementCount: number;
  htmlSample: string;
}

/** Enough markup for block detection (spec 8.9). */
const HTML_SAMPLE_CHARS = 200_000;
/** Cap for the small reads after navigation (title, element count, markup sample). */
const READ_MS = 3_000;
const MAX_SCROLL_STEPS = 40;
const BACK_TO_TOP_WAIT_MS = 300;
/** Scrolling back is instant on a healthy page; a page stuck in a script should not cost more than this. */
const BACK_TO_TOP_MS = 1_000;

// In-page snippets are strings, not functions: bundlers can rewrite a function body with helpers that do not exist
// in the page (critic R13).
const PAGE_FACTS = `({ count: document.getElementsByTagName("*").length, html: document.documentElement ? document.documentElement.outerHTML.slice(0, ${HTML_SAMPLE_CHARS}) : "" })`;
const EAGER_IMAGES = `(() => { for (const img of document.querySelectorAll('img[loading="lazy"]')) img.loading = "eager"; })()`;
const SCROLL_STEP = `(() => {
  const el = document.scrollingElement || document.documentElement;
  const before = el.scrollTop;
  el.scrollTo({ top: before + Math.round(innerHeight * 0.85), behavior: "instant" });
  return el.scrollTop <= before || el.scrollTop + innerHeight >= el.scrollHeight - 4;
})()`;
const BACK_TO_TOP = `(() => { (document.scrollingElement || document.documentElement).scrollTo({ top: 0, behavior: "instant" }); })()`;
const FINISH_ANIMATIONS_AND_FONTS = `(async () => {
  try {
    for (const animation of document.getAnimations()) {
      try {
        const timing = animation.effect && animation.effect.getComputedTiming();
        if (timing && timing.iterations !== Infinity && timing.endTime !== Infinity) animation.finish();
      } catch {}
    }
  } catch {}
  try { await document.fonts.ready; } catch {}
  return true;
})()`;

/** Resolves with the result, or with `fallback` on error or after `ms`. Rejects only when the signal aborts. */
function capped<T>(promise: Promise<T>, ms: number, fallback: T, signal?: AbortSignal): Promise<T> {
  promise.catch(() => {});
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      done();
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      done();
      resolve(fallback);
    }, Math.max(0, ms));
    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        done();
        resolve(value);
      },
      () => {
        done();
        resolve(fallback);
      },
    );
  });
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

const sleep = (ms: number, signal: AbortSignal) => capped(new Promise<void>(() => {}), ms, undefined, signal);

function navigationFailure(error: unknown, signal: AbortSignal): unknown {
  if (signal.aborted) return signal.reason;
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof Error && error.name === "TimeoutError") return new ScanFailure("timeout", "The page took too long to load");
  if (/ERR_NAME_NOT_RESOLVED/.test(message)) return new ScanFailure("dns", "The host could not be resolved");
  return new ScanFailure("connect", `The page could not be reached (${/net::ERR_[A-Z_]+/.exec(message)?.[0] ?? "navigation failed"})`);
}

/** Spec 7.2 phase 4: navigate until `domcontentloaded`, then read what block detection and the early `page` event need. */
export async function openPage(page: Page, url: string, options: { signal: AbortSignal }): Promise<NavigationResult> {
  const { signal } = options;
  signal.throwIfAborted();
  let response: Awaited<ReturnType<Page["goto"]>>;
  try {
    response = await untilAborted(page.goto(url, { waitUntil: "domcontentloaded", timeout: limits.gotoMs }), signal);
  } catch (error) {
    throw navigationFailure(error, signal);
  }
  const [title, facts] = await Promise.all([
    capped(page.title(), READ_MS, "", signal),
    capped(page.evaluate(PAGE_FACTS) as Promise<{ count: number; html: string }>, READ_MS, { count: 0, html: "" }, signal),
  ]);
  return {
    status: response?.status() ?? 0,
    finalUrl: page.url(),
    title: title.trim(),
    headers: response?.headers() ?? {},
    elementCount: facts.count,
    htmlSample: facts.html,
  };
}

/**
 * Spec 7.2 phases 5 and 6: wait for `load` and network idle, make lazy images eager, scroll the page by 0.85 of the
 * viewport every `scrollStepMs` until the bottom, wait for idle, go back to the top. Every wait has its cap, so a page
 * stuck in a script only costs time; the signal rejects at once.
 */
export async function loadAndScroll(page: Page, options: { signal: AbortSignal; onStep: (step: "load" | "scroll", state: "start" | "done") => void }): Promise<void> {
  const { signal, onStep } = options;
  signal.throwIfAborted();

  onStep("load", "start");
  await capped(page.waitForLoadState("load", { timeout: limits.loadMs }), limits.loadMs, undefined, signal);
  await capped(page.waitForLoadState("networkidle", { timeout: limits.networkIdleMs }), limits.networkIdleMs, undefined, signal);
  onStep("load", "done");

  onStep("scroll", "start");
  const deadline = Date.now() + limits.scrollMs;
  const left = () => deadline - Date.now();
  await capped(page.evaluate(EAGER_IMAGES), left(), undefined, signal);
  for (let step = 0; step < MAX_SCROLL_STEPS && left() > 0; step += 1) {
    const atBottom = await capped(page.evaluate(SCROLL_STEP) as Promise<boolean>, left(), true, signal);
    await sleep(Math.min(limits.scrollStepMs, Math.max(0, left())), signal);
    if (atBottom) break;
  }
  await capped(page.waitForLoadState("networkidle", { timeout: limits.scrollIdleMs }), limits.scrollIdleMs, undefined, signal);
  await capped(page.evaluate(BACK_TO_TOP), BACK_TO_TOP_MS, undefined, signal);
  await sleep(BACK_TO_TOP_WAIT_MS, signal);
  onStep("scroll", "done");
}

/** Spec 7.2 phase 7: finish finite animations (entrance animations would be captured mid-way) and wait for web fonts. */
export async function prepareForCollection(page: Page, options: { signal?: AbortSignal } = {}): Promise<void> {
  await capped(page.evaluate(FINISH_ANIMATIONS_AND_FONTS), limits.animationsMs, undefined, options.signal);
}
