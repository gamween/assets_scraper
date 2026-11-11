import type { BrandFileType } from "@/lib/contract";

/**
 * The brand rules of spec 8.1, in one file the in-page collector bundles and post-processing reads in Node: which words
 * make a link a brand link, which off-site links lead to a brand portal, which files a brand kit is made of, and which
 * labels say nothing about the file behind them. Pure string work, no DOM, so the unit tests read it directly.
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

/**
 * What a link to another site has to say to be a brand link: a whole phrase, never one word. "Brand" or "Press" alone
 * on a link out is a partner's brand or a newspaper, and the fixture's "Other brand" stays out, while sui.io's
 * "Brand Kit", raisesummit.com's "Download the Media Kit" and signalweekhq.com's "Official logo files on Drive" are the
 * kits those sites keep on another host.
 */
const STRONG_BRAND =
  /(?:^|[^a-z])(?:(?:brand|media|press|logo)[- _]?(?:kits?|packs?|assets?|resources?|guidelines?|guides?|books?|manuals?|portals?|hubs?|cent(?:er|re)s?|files?|toolkits?)|(?:brand|visual)[- _]identity|identity[- _]guidelines?)(?![a-z])/i;
export const isStrongBrandPhrase = (text: string): boolean => STRONG_BRAND.test(text) || STRONG_BRAND.test(camelSplit(text));

/**
 * Hosts that only serve brand books, so a link to one is a brand link whatever it says: trezor.io's press page links
 * `satoshilabs.visualbook.pro/trezor` as "Go to Visualbook", and sui.io its kit on `live.standards.site`.
 */
const BRAND_PORTAL_HOSTS = [
  "frontify.com", "standards.site", "visualbook.pro", "brandfolder.com", "brandfolder.io", "brandpad.io", "corebook.io",
  "lingoapp.com", "bynder.com",
];

/**
 * True for a page on a brand portal host. A portal lives on a subdomain (`acme.frontify.com`) or under a path of the
 * vendor's host (`brandfolder.com/acme`); the vendor's own home page, which a "Powered by Frontify" footer links, is not
 * one.
 */
export function isBrandPortal(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  const vendor = BRAND_PORTAL_HOSTS.find((name) => host === name || host.endsWith(`.${name}`));
  if (!vendor) return false;
  if (host !== vendor && host !== `www.${vendor}`) return true;
  return url.pathname.replace(/\/+$/, "") !== "";
}

/**
 * What two links to one page or file have in common: the URL without its fragment, its credentials or a trailing slash
 * on its path. francefintech.org links its press releases as both `/cp` and `https://francefintech.org/cp/`, and they
 * took two brand link slots. Only the slash: another case, a query or an `index.html` can be another page.
 */
export function linkKey(url: URL): string {
  const path = url.pathname.length > 1 && url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
  return `${url.origin}${path}${url.search}`;
}

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
