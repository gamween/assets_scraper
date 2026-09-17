import { limits } from "@/server/config/limits";
import type { SafeFetch } from "../types";

const CACHE_MS = 5 * 60_000;
/** Google Fonts family names are ASCII words: this also keeps `:`, `@`, `;` and `,` (css2 query syntax) out. */
const CHECKABLE_NAME = /^[A-Za-z0-9][A-Za-z0-9 .'-]{1,63}$/;

const cache = new Map<string, { match: boolean; expires: number }>();

export const googleFontsCssUrl = (family: string): string =>
  `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, "+")}`;

/** Test hook: forget every cached answer. */
export function clearGoogleFontsCache(): void {
  cache.clear();
}

async function isGoogleFamily(name: string, fetch: SafeFetch, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  const cached = cache.get(name);
  if (cached && cached.expires > Date.now()) return cached.match;
  if (signal?.aborted) return false;
  try {
    const response = await fetch(googleFontsCssUrl(name), { method: "GET", timeoutMs, signal });
    await response.cancel().catch(() => {});
    // 200 is a known family and 400 an unknown one. Anything else is a failure and is asked again next time.
    if (response.status !== 200 && response.status !== 400) return false;
    const match = response.status === 200;
    cache.set(name, { match, expires: Date.now() + CACHE_MS });
    return match;
  } catch {
    return false;
  }
}

/**
 * Asks the Google Fonts CSS API (spec section 9) whether each name is a Google Fonts family, through `safeFetch`,
 * in parallel, with `limits.googleFontsMs` each. Checks at most `maxNames` unique names, by default
 * `limits.googleFontsMaxFamilies` (one name per family). Answers are cached per name for 5 minutes. Returns the names
 * that matched, mapped to the exact family name. Never throws.
 */
export async function matchGoogleFamilies(
  names: readonly string[],
  options: { fetch: SafeFetch; signal?: AbortSignal; timeoutMs?: number; maxNames?: number },
): Promise<Map<string, string>> {
  const maxNames = options.maxNames ?? limits.googleFontsMaxFamilies;
  const unique = [...new Set(names.map((name) => name.trim()))].filter((name) => CHECKABLE_NAME.test(name)).slice(0, maxNames);
  const timeoutMs = Math.min(options.timeoutMs ?? limits.googleFontsMs, limits.googleFontsMs);
  if (timeoutMs <= 0) return new Map();
  const matched = await Promise.all(unique.map((name) => isGoogleFamily(name, options.fetch, timeoutMs, options.signal)));
  return new Map(unique.filter((_, index) => matched[index]).map((name) => [name, name]));
}
