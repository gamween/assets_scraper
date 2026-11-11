import type { BrandFileType } from "@/lib/contract";

/**
 * The brand rules of spec 8.1, in one file the in-page collector bundles and post-processing reads in Node: which words
 * make a link a brand link, which files a brand kit is made of, and which labels say nothing about the file behind them. Pure string work, no DOM, so the unit tests read it directly.
 */

/** Second-level labels under a two-letter country code that are public suffixes: shop.co.uk, shop.com.au. */
export const SECOND_LEVEL_LABELS = /^(?:ac|co|com|edu|go|gov|ne|net|or|org)$/;

/** Registrable domain approximation: the last two labels, or three under a `co.uk`-like suffix. */
export function siteOf(host: string): string {
  const bare = host.replace(/^www\./, "").toLowerCase();
  if (/^[\d.]+$|^\[|^localhost$/.test(bare)) return bare;
  const labels = bare.split(".");
  const take = labels.length > 2 && labels[labels.length - 1].length === 2 && SECOND_LEVEL_LABELS.test(labels[labels.length - 2]) ? 3 : 2;
  return labels.slice(-take).join(".");
}

/** `OurBrand` to `Our Brand`, so a camelCase word starts a word of its own. */
const camelSplit = (text: string) => text.replace(/([a-z])(?=[A-Z])/g, "$1 ");

/**
 * Spec 8.1 brand link words. A word must start the path segment, the text or a camelCase word (/OurBrand), so
 * /wordpress, /express and /impressum do not match, but it may run on (/brandassets, /logopack, /presse). /logout,
 * /logon and /pressure are left out.
 */
const BRAND_WORD = /(?:^|[^a-z])(?:brand|press(?!ure)|media[- _]?kit|newsroom|identity|logo(?!ut|n(?![a-z]))|guidelines)/i;
export const isBrandWord = (text: string): boolean => BRAND_WORD.test(text) || BRAND_WORD.test(camelSplit(text));

/**
 * A brand word, or a word only a logo file is named with. monad.xyz names its kit files `Wordmark.svg` and `Full.svg`
 * in a `/brand-page-assets/` folder, and token2049.com files its lockups under `/Brandkit/`.
 */
export const isBrandFileWord = (text: string): boolean => isBrandWord(text) || /wordmark|lockup/i.test(text);

/** What a brand kit is made of: archives, documents, and the vector or raster logos it links one by one. */
const BRAND_FILE_EXTENSION = /\.(zip|pdf|ai|eps|svg|png)$/i;

/** The brand file type of a path or a file name, by its extension, or undefined for anything else. */
export function brandFileType(name: string): BrandFileType | undefined {
  const match = BRAND_FILE_EXTENSION.exec(name.trim());
  return match ? (match[1].toLowerCase() as BrandFileType) : undefined;
}

/** Archives and documents. A page offers these as downloads; a vector or a raster it may simply be showing. */
export const isArchiveOrDocument = (type: BrandFileType): boolean => type !== "svg" && type !== "png";

/** Words a download button says about any file: "Download", "View", "DOWNLOAD PNG + SVG", "Get the ZIP (2 MB)". */
const GENERIC_WORDS = new Set([
  "download", "downloads", "view", "open", "get", "see", "here", "click", "now", "save", "preview", "link", "go", "file",
  "files", "all", "the", "this", "and", "or", "to", "it", "a", "an", "as", "in", "format", "formats", "version", "zip",
  "pdf", "ai", "eps", "svg", "png", "jpg", "jpeg", "kb", "mb", "gb",
]);

/**
 * True when a label names no file: empty, or only download words, formats and sizes. arbitrum.io labels each of its
 * logo archives "DOWNLOAD PNG + SVG" and stellar.org its guidelines "Download", so the file name or the heading above
 * the button has to say what the file is.
 */
export function isGenericLabel(text: string): boolean {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "" && !/^\d+(?:[.,]\d+)?$/.test(word))
    .every((word) => GENERIC_WORDS.has(word));
}
