import { limits } from "@/server/config/limits";
import type { SafeFetch } from "../types";

const CACHE_MS = 5 * 60_000;
/** The asset proxy also asks about names read from any font binary, so a warm instance would otherwise keep them all. */
const CACHE_MAX_ENTRIES = 1_000;
/** Google Fonts family names are ASCII words: this also keeps `:`, `@`, `;` and `,` (css2 query syntax) out. */
const CHECKABLE_NAME = /^[A-Za-z0-9][A-Za-z0-9 .'-]{1,63}$/;

const cache = new Map<string, { match: boolean; expires: number }>();

/**
 * Spellings to ask about for one declared family name, most likely first. A page can declare a catalogue family
 * without its spaces (`SourceCodePro` on stripe.com) or with separators (`source-code-pro`), and the CSS API only
 * knows the catalogue spelling, so such a family lost its licence, its `Google Fonts` link and its `Download TTF`.
 * Camel case and runs of capitals are split, separators collapse to single spaces and each word is capitalised.
 */
export function familySpellings(name: string): string[] {
  const declared = name.trim();
  const spaced = declared
    .replace(/[_+-]+/g, " ")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
  const capitalised = spaced.replace(/(^|\s)([a-z])/g, (_, space: string, letter: string) => space + letter.toUpperCase());
  return [...new Set([declared, spaced, capitalised])].filter((spelling) => CHECKABLE_NAME.test(spelling));
}

export const googleFontsCssUrl = (family: string): string =>
  `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, "+")}`;

/** Test hook: forget every cached answer. */
export function clearGoogleFontsCache(): void {
  cache.clear();
}

/** Test hook: how many answers are cached. */
export function googleFontsCacheSize(): number {
  return cache.size;
}

/**
 * Entries are kept in insertion order with the same lifetime, so expired ones come first: they are dropped on every
 * write, then the oldest ones while the cache is full.
 */
function remember(name: string, match: boolean) {
  const now = Date.now();
  cache.delete(name);
  for (const [key, entry] of cache) {
    if (entry.expires > now && cache.size < CACHE_MAX_ENTRIES) break;
    cache.delete(key);
  }
  cache.set(name, { match, expires: now + CACHE_MS });
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
    remember(name, match);
    return match;
  } catch {
    return false;
  }
}

/**
 * Asks the Google Fonts CSS API (spec section 9) whether each name is a Google Fonts family, through `safeFetch`,
 * in parallel, with `limits.googleFontsMs` each. Checks at most `maxNames` unique names, by default
 * `limits.googleFontsMaxFamilies` (one name per family). Answers are cached per name for 5 minutes, 1,000 names at
 * most. Returns the names
 * that matched, mapped to the exact family name. Never throws.
 */
export async function matchGoogleFamilies(
  names: readonly string[],
  options: { fetch: SafeFetch; signal?: AbortSignal; timeoutMs?: number; maxNames?: number },
): Promise<Map<string, string>> {
  const maxNames = options.maxNames ?? limits.googleFontsMaxFamilies;
  const unique = [...new Set(names.map((name) => name.trim()))].filter((name) => familySpellings(name).length > 0).slice(0, maxNames);
  const timeoutMs = Math.min(options.timeoutMs ?? limits.googleFontsMs, limits.googleFontsMs);
  if (timeoutMs <= 0) return new Map();
  const matched = await Promise.all(
    unique.map(async (name): Promise<readonly [string, string] | null> => {
      for (const spelling of familySpellings(name)) {
        if (await isGoogleFamily(spelling, options.fetch, timeoutMs, options.signal)) return [name, spelling] as const;
      }
      return null;
    }),
  );
  return new Map(matched.filter((entry): entry is readonly [string, string] => entry !== null));
}
