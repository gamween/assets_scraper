/** Node-side palette extras: colors of the site icon and of the web manifest. */
import type { SafeFetch, SafeResponse } from "../types";
import { rgbToHex } from "./color";
import type { RawPaletteSignals } from "./signals";

const ICON_MAX_BYTES = 512 * 1024;
const MANIFEST_MAX_BYTES = 256 * 1024;

export interface PaletteExtras {
  /** SVG markup, or raster bytes for in-page decoding. */
  icon: { svg: string } | { b64: string; mime: string } | null;
  manifest: { themeColor: string | null; backgroundColor: string | null } | null;
}

/**
 * Fetches the best icon (candidates in order, first image wins) and the web manifest in parallel, through `fetch`
 * (safeFetch in production). Returns whatever arrived within `budgetMs`, then aborts what is still pending.
 */
export async function fetchPaletteExtras(
  signals: Pick<RawPaletteSignals, "iconUrls" | "manifestUrl">,
  options: { fetch: SafeFetch; signal: AbortSignal; budgetMs: number },
): Promise<PaletteExtras> {
  const found: PaletteExtras = { icon: null, manifest: null };
  const budget = new AbortController();
  // Listens before anything can abort, so it settles even when the scan is already aborted
  const done = new Promise<void>((resolve) => budget.signal.addEventListener("abort", () => resolve(), { once: true }));
  const stop = () => budget.abort();
  const timer = setTimeout(stop, options.budgetMs);
  options.signal.addEventListener("abort", stop, { once: true });
  if (options.signal.aborted) stop();

  const get = async (url: string, maxBytes: number): Promise<SafeResponse | null> => {
    const res = await options.fetch(url, { maxBytes, timeoutMs: options.budgetMs, signal: budget.signal });
    if (res.status >= 200 && res.status < 300) return res;
    await res.cancel().catch(() => {});
    return null;
  };
  const icon = async () => {
    for (const url of signals.iconUrls) {
      if (budget.signal.aborted) return;
      try {
        const res = await get(url, ICON_MAX_BYTES);
        if (!res) continue;
        const type = (res.headers.get("content-type") ?? "").toLowerCase();
        const body = await res.buffer();
        if (body.length < 16 || type.includes("html")) continue;
        const head = body.subarray(0, 256).toString("latin1");
        found.icon = type.includes("svg") || /<svg[\s>]/i.test(head) ? { svg: body.toString("utf8") } : { b64: body.toString("base64"), mime: type };
        return;
      } catch {
        // next candidate
      }
    }
  };
  const manifest = async () => {
    if (!signals.manifestUrl || budget.signal.aborted) return;
    try {
      const res = await get(signals.manifestUrl, MANIFEST_MAX_BYTES);
      const json = res ? await res.json<Record<string, unknown> | null>() : null;
      if (json && typeof json === "object") found.manifest = { themeColor: normHex(json.theme_color), backgroundColor: normHex(json.background_color) };
    } catch {
      // no manifest colors
    }
  };

  await Promise.race([Promise.all([icon(), manifest()]), done]);
  clearTimeout(timer);
  options.signal.removeEventListener("abort", stop);
  stop();
  return { icon: found.icon, manifest: found.manifest };
}

/** 3, 4, 6 or 8 digit hex, with or without `#`, to lowercase `#rrggbb` (alpha dropped); anything else to null. */
export const normHex = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const match = /^#?(?:([0-9a-f]{3})[0-9a-f]?|([0-9a-f]{6})(?:[0-9a-f]{2})?)$/i.exec(value.trim());
  if (!match) return null;
  const hex = match[1] ? match[1].split("").map((c) => c + c).join("") : match[2];
  return "#" + hex.toLowerCase();
};

/**
 * Colors declared in an SVG icon (fill, stroke and stop-color, as attributes or CSS), as [hex, weight] with weights
 * summing to 1000. Shapes without any color default to black. Every repetition in the pattern is bounded: with open
 * ones, a 512 KB icon of unterminated `rgb(` or of blank space after `fill:` blocked Node for seconds to minutes.
 */
export function svgColors(svg: string): [string, number][] {
  const counts = new Map<string, number>();
  for (const match of svg.matchAll(/(?:fill|stroke|stop-color)\s{0,16}[:=]\s{0,16}["']?\s{0,16}(#[0-9a-f]{3,8}\b|rgba?\([^)]{0,64}\)|white|black)/gi)) {
    const value = match[1].toLowerCase();
    let hex: string | null = null;
    if (value === "white") hex = "#ffffff";
    else if (value === "black") hex = "#000000";
    else if (value.startsWith("#")) hex = normHex(value);
    else {
      const channels = value.match(/[\d.]+/g);
      if (channels && channels.length >= 3) hex = rgbToHex([+channels[0], +channels[1], +channels[2]].map((v) => Math.min(255, v)) as [number, number, number]);
    }
    if (hex) counts.set(hex, (counts.get(hex) ?? 0) + 1);
  }
  if (!counts.size && /<(path|circle|rect|polygon)\b/i.test(svg)) counts.set("#000000", 1);
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  return [...counts.entries()].map(([hex, n]): [string, number] => [hex, (n / total) * 1000]);
}
