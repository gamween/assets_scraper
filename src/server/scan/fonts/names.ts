import type { FontBinaryMeta } from "../types";

// Ported from the discovery lab (discovery-lab/lib/fonts.mjs, discovery-lab.md 3.2), where it was validated on real
// sites. Keep the behavior: the name table below is the reference.

export const GENERIC_FAMILIES = new Set([
  "serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-serif", "ui-sans-serif", "ui-monospace",
  "ui-rounded", "math", "emoji", "fangsong", "-apple-system", "blinkmacsystemfont", "inherit", "initial",
]);

/** Splits a computed `font-family` stack into unquoted names, keeping commas inside quotes. */
export function splitFamilies(stack: string | undefined): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const char of stack ?? "") {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ",") {
      if (current.trim()) out.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/** next/font mangling (`__Inter_d65c78`, `__Inter_Fallback_d65c78`) and build hash suffixes (`Waldenburg-75357948a2b6a39b`). */
export function cleanCssFamily(family: string): string {
  let match = family.match(/^__(.+?)_(?:Fallback_)?[0-9a-f]{6}$/i);
  if (match) return match[1].replace(/_/g, " ");
  match = family.match(/^(.+?)[-_][0-9a-f]{10,}$/i);
  if (match && /\p{L}{2,}/u.test(match[1])) return match[1];
  return family;
}

/** The lab strips `/\s+(?:<style word>)$/i` and `/\s+placeholder$/i`, see `stripTrailingWord`. */
const STYLE_WORD =
  /^(?:thin|hairline|extra ?light|ultra ?light|light|book|regular|normal|roman|medium|semi ?bold|demi ?bold|bold|extra ?bold|ultra ?bold|black|heavy|italic|oblique|\d{3})$/i;
const STYLE_WORD_MAX_LENGTH = "extra light".length;
const PLACEHOLDER = /^placeholder$/i;
const BAD_NAME = /^(?:false|true|null|undefined|none|untitled|\.+|[-_ .]*)$|copyright|all rights reserved|licen[cs]e|trial|webfont|\(c\)|©|^[A-Z0-9]{16,}$/i;

/** C0 and C1 control characters and U+FFFD, found in real name records (".\x7f" on Squarespace and Stripe). */
export const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\ufffd]/g;

const WHITESPACE = /\s/;

/**
 * `value.replace(/\s+(?:<word>)$/i, "")`, where `word` matches the whole candidate and never matches more than
 * `maxLength` characters. The regex form backtracks quadratically on long whitespace runs in scraped names; this is
 * linear and gives the same result: the leftmost whitespace run that ends right before a trailing word starts the cut.
 */
function stripTrailingWord(value: string, word: RegExp, maxLength: number): string {
  let cut = value.length;
  for (let length = 1; length <= Math.min(maxLength, value.length - 1); length += 1) {
    const start = value.length - length;
    if (!WHITESPACE.test(value[start - 1]) || !word.test(value.slice(start))) continue;
    let run = start - 1;
    while (run > 0 && WHITESPACE.test(value[run - 1])) run -= 1;
    cut = Math.min(cut, run);
  }
  return value.slice(0, cut);
}

const stripStyleWord = (value: string) => stripTrailingWord(value, STYLE_WORD, STYLE_WORD_MAX_LENGTH);

const deaccent = (value: string) => value.normalize("NFD").replace(/\p{M}/gu, "");
const norm = (value: string) => deaccent(value).toLowerCase().replace(/[^a-z0-9]/g, "");
const tokens = (value: string) =>
  deaccent(value)
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 4);

/** Machine-generated CSS families: next/font, build hashes, Wix `wf_`/`wfont_`, Framer placeholders. */
export const isMangledCssFamily = (family: string | null | undefined): boolean =>
  /^__.+_[0-9a-f]{6}$|(^|[_-])[0-9a-f]{10,}|^wf_|^wfont_|placeholder$/i.test(family ?? "");

export type NameMeta = Pick<FontBinaryMeta, "typoFamily" | "wwsFamily" | "nameId1" | "postscriptName">;

export interface ResolvedFamilyName {
  name: string;
  basis: string;
  /** The binary family name when it is valid but unrelated to the CSS family (a renamed font). */
  embeddedName?: string;
}

/**
 * The family name a font binary gives itself: the typographic family (name 16), the WWS family (21), the legacy family
 * (1) without style words, or the PostScript name (6) before its hyphen with camel case split, the first one that is
 * not garbage (".", "false", copyright notices, hashes). Null when there is none. This is the binary half of
 * `resolveFamilyName`.
 */
export function binaryFamilyName(meta: NameMeta | null | undefined): string | null {
  if (!meta) return null;
  const clean = (name: string | undefined) => (typeof name === "string" ? name.replace(CONTROL_CHARS, "").trim() : name);
  const valid = (name: string | undefined): name is string => {
    const cleaned = clean(name);
    return !!cleaned && cleaned.length >= 2 && cleaned.length <= 48 && /\p{L}{2,}/u.test(cleaned) && !BAD_NAME.test(cleaned);
  };
  const cleaned: NameMeta = {
    typoFamily: clean(meta.typoFamily),
    wwsFamily: clean(meta.wwsFamily),
    nameId1: clean(meta.nameId1),
    postscriptName: clean(meta.postscriptName),
  };
  const psFamily = valid(cleaned.postscriptName) ? cleaned.postscriptName.split("-")[0].replace(/([a-z])([A-Z])/g, "$1 $2") : undefined;
  const nameId1 = cleaned.nameId1 ? stripStyleWord(stripStyleWord(cleaned.nameId1)) : undefined;
  let bin: string | null = null;
  for (const candidate of [cleaned.typoFamily, cleaned.wwsFamily, nameId1, psFamily]) {
    if (valid(candidate)) {
      bin = candidate.trim();
      break;
    }
  }
  if (bin && !cleaned.typoFamily) bin = stripStyleWord(bin).trim();
  return bin;
}

/**
 * Decides the family name shown to the user. The CSS family is authoritative unless it is machine-generated;
 * the binary name wins when it is clearly the real name behind a renamed family (`NotionInter` to `Inter`).
 * Garbage binary names (".", "false", copyright notices, hashes) are rejected.
 */
export function resolveFamilyName(meta: NameMeta | null | undefined, cssFamily: string | null | undefined): ResolvedFamilyName {
  return resolveFamilyNameOf(binaryFamilyName(meta), cssFamily);
}

/**
 * `resolveFamilyName` for a binary family name already read with `binaryFamilyName`, so matching one file against many
 * CSS families reads its name records once. Passing the name as `{ typoFamily: name }` is not the same: the style word
 * strip of a legacy family name can leave a name too short to be valid on its own.
 */
export function resolveFamilyNameOf(bin: string | null, cssFamily: string | null | undefined): ResolvedFamilyName {
  const css = cssFamily ? stripTrailingWord(cleanCssFamily(cssFamily), PLACEHOLDER, "placeholder".length) : null;
  if (!css || GENERIC_FAMILIES.has(css.toLowerCase())) return { name: bin || css || "(unknown)", basis: "binary" };
  if (!bin) return { name: css, basis: "css" };
  if (isMangledCssFamily(cssFamily)) return { name: bin, basis: "binary (css mangled)" };
  const nb = norm(bin);
  const nc = norm(css);
  if (nb === nc) return { name: bin, basis: "both" };
  if (nb.startsWith(nc)) return { name: css, basis: "css (binary adds style words)" };
  if (nc.includes(nb)) return { name: bin, basis: "binary (css is a renamed alias)" };
  const binTokens = new Set(tokens(bin));
  if (tokens(css).some((token) => binTokens.has(token) || nb.includes(token))) return { name: bin, basis: "binary (shared token)" };
  return { name: css, basis: "css (binary name unrelated)", embeddedName: bin };
}
