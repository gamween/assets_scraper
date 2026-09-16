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

const GLOBAL = "globalThis.__assetsScraperPalette";
const MAX_ELEMENTS = 8_000;
const WALK_BUDGET_MS = 600;
/** How long to wait for the overlay restore before returning (it still runs later if the page is busy). */
const RESTORE_WAIT_MS = 500;

export interface ExtractPaletteOptions {
  fetch: SafeFetch;
  signal: AbortSignal;
  timeBudgetMs: number;
}

/**
 * Brand palette of the page as it is now (spec section 10): hides overlays, collects DOM signals, takes a viewport
 * screenshot and fetches the icon and manifest, restores the overlays, then builds the palette in Node.
 *
 * Runs in the main world through `page.evaluate` and installs PALETTE_SOURCE when the page does not have it yet.
 * Returns null on any failure, when `signal` aborts, when `timeBudgetMs` runs out, or when no color was found.
 * Overlays are always restored.
 */
export async function extractPalette(page: Page, options: ExtractPaletteOptions): Promise<Palette | null> {
  const deadline = Date.now() + options.timeBudgetMs;
  const budget = AbortSignal.any([options.signal, AbortSignal.timeout(Math.max(1, options.timeBudgetMs))]);
  if (budget.aborted) return null;
  try {
    const { signals, pixels } = await untilAborted(collectOnPage(page, options, budget, deadline), budget);
    const palette = toContractPalette(buildPalette(signals, pixels));
    return palette.brand.length || palette.neutrals.length ? palette : null;
  } catch {
    return null;
  } finally {
    await restoreOverlays(page);
  }
}

async function collectOnPage(
  page: Page,
  { fetch, timeBudgetMs }: ExtractPaletteOptions,
  budget: AbortSignal,
  deadline: number,
): Promise<{ signals: RawPaletteSignals; pixels: Pixels | null }> {
  // Every page call checks the budget first, so nothing hides overlays again after the restore
  const evaluate = (expression: string): Promise<unknown> => {
    budget.throwIfAborted();
    return page.evaluate(expression);
  };
  const remainingMs = () => Math.max(1, deadline - Date.now());

  if (!(await evaluate(`typeof ${GLOBAL}?.collect === "function"`))) await evaluate(PALETTE_SOURCE);
  const collectOptions: PaletteSignalOptions = {
    maxElements: MAX_ELEMENTS,
    walkBudgetMs: Math.min(WALK_BUDGET_MS, Math.floor(timeBudgetMs / 3)),
    hideOverlays: true,
  };
  const signals = readSignals(await evaluate(`${GLOBAL}.collect(${JSON.stringify(collectOptions)})`));
  if (!signals) throw new Error("invalid palette signals");

  const [pixels, extras] = await Promise.all([
    screenshot(page, budget, remainingMs()),
    fetchPaletteExtras(signals, { fetch, signal: budget, budgetMs: Math.min(limits.paletteFetchMs, remainingMs()) }),
  ]);
  for (const [hex, weight] of await iconColors(extras.icon, evaluate)) signals.samples.push(["icon", hex, weight, 1]);
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

async function iconColors(icon: PaletteExtras["icon"], evaluate: (expression: string) => Promise<unknown>): Promise<[string, number][]> {
  if (!icon) return [];
  try {
    if ("svg" in icon) return svgColors(icon.svg);
    return dropBlends(readIconColors(await evaluate(`${GLOBAL}.decodeIconColors(${JSON.stringify(icon)})`)));
  } catch {
    return []; // undecodable icon
  }
}

async function restoreOverlays(page: Page): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, RESTORE_WAIT_MS);
  });
  const restored = page.evaluate(`${GLOBAL}?.restore()`).catch(() => {});
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
