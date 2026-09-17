import type { Page } from "playwright-core";
import type { Palette } from "@/lib/contract";
import { limits } from "@/server/config/limits";
import { PALETTE_SOURCE } from "../inpage/generated/palette";
import type { SafeFetch } from "../types";
import { buildPalette, toContractPalette } from "./build";
import { fetchPaletteExtras, svgColors, type PaletteExtras } from "./extras";
import { decodePng, type Pixels } from "./png";
import { dropBlends } from "./quantize";
import { readIconColors, readSignals, type PaletteSignalOptions, type RawPaletteSignals } from "./signals";
import { openPaletteScope, type PaletteScope } from "./world";

const MAX_ELEMENTS = 8_000;
const WALK_BUDGET_MS = 600;
const OVERLAY_BUDGET_MS = 300;
/** How long to wait for the overlay restore before returning (it still runs later if the page is busy). */
const RESTORE_WAIT_MS = 500;
/** Kept for `buildPalette`, which is synchronous and bounded (about 100 ms on adversarial signals on a laptop). */
const BUILD_RESERVE_MS = 250;
/** Largest in-page result in JSON characters. The in-page caps keep real results well under 1 MB. */
const MAX_RESULT_CHARS = 2_000_000;

/** Why `extractPalette` returned null. */
export type PaletteNullReason =
  /** `signal` aborted. */
  | "aborted"
  /** `timeBudgetMs` ran out, or was too small to start. */
  | "timeout"
  /** The page, the browser or CDP failed (closed page, crash, navigation). */
  | "page"
  /** The page returned something that is not palette signals. */
  | "invalid-signals"
  /** Post-processing threw (a bug). */
  | "build"
  /** Collection worked but found no color. */
  | "no-colors";

export interface ExtractPaletteOptions {
  fetch: SafeFetch;
  signal: AbortSignal;
  /** For the whole call, restore wait and post-processing included. Capped at `limits.collectMs`. */
  timeBudgetMs: number;
  /** Called once with the reason whenever the result is null, for logs and diagnostics. */
  onNull?: (reason: PaletteNullReason, error?: unknown) => void;
}

class InvalidSignalsError extends Error {
  constructor() {
    super("invalid palette signals");
    this.name = "InvalidSignalsError";
  }
}

/**
 * Brand palette of the page as it is now (spec section 10): hides overlays, collects DOM signals, takes a viewport
 * screenshot and fetches the icon and manifest, restores the overlays, then builds the palette in Node.
 *
 * The in-page code runs in an isolated world (spec 7.5), in the main world only when that world cannot be created, and
 * never relies on anything the page defined: each call evaluates a fresh copy of PALETTE_SOURCE with `globalThis`
 * shadowed, so nothing is installed on the page either.
 *
 * Returns within about `timeBudgetMs`: collection gets the budget minus the restore wait and the post-processing
 * reserve. Returns null (see `onNull`) on any failure, when `signal` aborts, when the budget runs out, or when no color
 * was found. Overlays are always restored.
 */
export async function extractPalette(page: Page, options: ExtractPaletteOptions): Promise<Palette | null> {
  const fail = (reason: PaletteNullReason, error?: unknown): null => {
    try {
      options.onNull?.(reason, error);
    } catch {
      // a logging callback never fails the scan
    }
    return null;
  };
  if (options.signal.aborted) return fail("aborted");
  const budgetMs = Number.isNaN(options.timeBudgetMs) ? 0 : Math.min(Math.max(0, options.timeBudgetMs), limits.collectMs);
  const collectMs = Math.floor(budgetMs) - RESTORE_WAIT_MS - BUILD_RESERVE_MS;
  if (collectMs <= 0) return fail("timeout");

  const budget = AbortSignal.any([options.signal, AbortSignal.timeout(collectMs)]);
  const scope = openPaletteScope(page);
  let collected: { signals: RawPaletteSignals; pixels: Pixels | null };
  try {
    collected = await untilAborted(collectOnPage(page, scope, options.fetch, budget, collectMs), budget);
  } catch (error) {
    if (options.signal.aborted) return fail("aborted", error);
    if (budget.aborted) return fail("timeout", error);
    return fail(error instanceof InvalidSignalsError ? "invalid-signals" : "page", error);
  } finally {
    await restoreOverlays(scope);
  }
  if (options.signal.aborted) return fail("aborted");

  let palette: Palette;
  try {
    palette = toContractPalette(buildPalette(collected.signals, collected.pixels));
  } catch (error) {
    return fail("build", error);
  }
  return palette.brand.length || palette.neutrals.length ? palette : fail("no-colors");
}

/**
 * Expression running `call` on a fresh copy of the in-page palette code, with `globalThis` shadowed by a null-prototype
 * object. It returns the result as JSON, or null when the JSON is too large, so the value that crosses to Node stays
 * small even if a main-world page tampers with built-ins.
 */
const inPage = (call: string) =>
  `(async () => { "use strict"; const globalThis = { __proto__: null };\n${PALETTE_SOURCE}\n` +
  `const json = JSON.stringify(await globalThis.__assetsScraperPalette.${call});\n` +
  `return typeof json === "string" && json.length <= ${MAX_RESULT_CHARS} ? json : null; })()`;

async function collectOnPage(
  page: Page,
  scopePromise: Promise<PaletteScope>,
  fetch: SafeFetch,
  budget: AbortSignal,
  collectMs: number,
): Promise<{ signals: RawPaletteSignals; pixels: Pixels | null }> {
  const deadline = Date.now() + collectMs;
  const remainingMs = () => Math.max(1, deadline - Date.now());
  const scope = await scopePromise;
  // Every page call checks the budget first, so nothing hides overlays again after the restore
  const run = async (call: string): Promise<unknown> => {
    budget.throwIfAborted();
    const json = await scope.evaluate(inPage(call));
    try {
      return typeof json === "string" ? JSON.parse(json) : null;
    } catch {
      return null;
    }
  };

  const collectOptions: PaletteSignalOptions = {
    maxElements: MAX_ELEMENTS,
    walkBudgetMs: Math.min(WALK_BUDGET_MS, Math.floor(collectMs / 3)),
    overlayBudgetMs: Math.min(OVERLAY_BUDGET_MS, Math.floor(collectMs / 6)),
    hideOverlays: true,
  };
  const signals = readSignals(await run(`collect(${JSON.stringify(collectOptions)})`));
  if (!signals) throw new InvalidSignalsError();
  budget.throwIfAborted();

  const [pixels, extras] = await Promise.all([
    screenshot(page, budget, remainingMs()),
    fetchPaletteExtras(signals, { fetch, signal: budget, budgetMs: Math.min(limits.paletteFetchMs, remainingMs()) }),
  ]);
  for (const [hex, weight] of await iconColors(extras.icon, run)) signals.samples.push(["icon", hex, weight, 1]);
  if (extras.manifest) {
    signals.meta.manifestTheme = extras.manifest.themeColor;
    signals.meta.manifestBackground = extras.manifest.backgroundColor;
  }
  return { signals, pixels };
}

/** Viewport PNG while overlays are hidden, or null (the palette then uses DOM signals only). */
async function screenshot(page: Page, budget: AbortSignal, timeoutMs: number): Promise<Pixels | null> {
  budget.throwIfAborted();
  try {
    return decodePng(await page.screenshot({ type: "png", timeout: timeoutMs }));
  } catch {
    return null;
  }
}

async function iconColors(icon: PaletteExtras["icon"], run: (call: string) => Promise<unknown>): Promise<[string, number][]> {
  if (!icon) return [];
  try {
    if ("svg" in icon) return svgColors(icon.svg);
    return dropBlends(readIconColors(await run(`decodeIconColors(${JSON.stringify(icon)})`)));
  } catch {
    return []; // undecodable icon
  }
}

/** Restores overlays in the same world, waits up to RESTORE_WAIT_MS, and closes the scope once the restore settles. */
async function restoreOverlays(scopePromise: Promise<PaletteScope>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, RESTORE_WAIT_MS);
  });
  const restored = scopePromise.then((scope) =>
    scope
      .evaluate(inPage("restore()"))
      .catch(() => {})
      .finally(() => scope.close()),
  );
  await Promise.race([restored, waited]);
  clearTimeout(timer);
}

/** Settles like `promise`, or rejects as soon as `signal` aborts. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
