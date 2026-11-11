import type { AssetKind, AssetRole } from "@/lib/contract";
import type { NameHints } from "../types";
import { originalCandidates } from "./cdn";

/** Display names and filenames (spec 8.7). */

const MAX_NAME = 80;
const MAX_FILENAME = 80;

export interface NameInput {
  kind: AssetKind;
  role: AssetRole;
  index: number;              // position among assets of this kind, for the last-resort name
  siteName: string;
  /** The collector's label: aria-label (of the element or its link), `<title>`, alt, data-framer-name, title attribute. */
  label?: string;
  jsonLdLogo?: boolean;
  linkText?: string;
  url?: string;               // http(s) URL of the file, for the basename
  /** The collector's last-resort places: the ancestor link, an ancestor label, the caption beside the element. */
  hints?: NameHints;
  /** The markup of an inline SVG, for the id a sprite reference or a gradient carries. */
  markup?: string;
}

/** Trimmed single-line text without control characters, capped at a word boundary, or undefined when unusable. */
const usable = (text: string | undefined): string | undefined => {
  if (!text) return undefined;
  const clean = text.replace(/[\u0000-\u001F\u007F-\u009F]+/g, " ").replace(/\s+/g, " ").trim();
  if (!/[\p{L}\p{N}]/u.test(clean) || /^[a-z][a-z0-9+.-]*:\/\//i.test(clean)) return undefined;
  if (clean.length <= MAX_NAME) return clean;
  const cut = clean.slice(0, MAX_NAME + 1);
  const space = cut.lastIndexOf(" ");
  return (space > MAX_NAME / 2 ? cut.slice(0, space) : clean.slice(0, MAX_NAME)).trim();
};

const HEX_HASH = /[.\-_](?=[0-9a-f]*\d)[0-9a-f]{8,}$/i;
const BUNDLER_HASH = /[.\-_](?=[A-Za-z0-9_]*\d)(?=[A-Za-z0-9_]*[A-Z])(?=[A-Za-z0-9_]*[a-z])[A-Za-z0-9_]{8}$/;
const SIZE_SUFFIX = /(?:_(?:xsmall|small|medium|large|xlarge|xxlarge)(?:_[23]x)?|@[23]x|_[23]x|-scaled)$/i;
/** The upload id Webflow puts before every file name: 6964d40aecc2aafdea1a8419_mcc-logo.svg. */
const ID_PREFIX = /^(?=[0-9a-f]*\d)[0-9a-f]{16,}[-_](?=[^-_])/i;

/**
 * Letters no one would read as words: few vowels, five consonants in a row, or digits in more than one place with two
 * capitals side by side. A name in camelCase (HeroBackground2x, iPhone15ProMax2x, RedStoneLogoSymbol) has none of
 * these. "y" is left out of both sets, so a word like "rhythm" is not five consonants.
 */
const readsAsRandom = (run: string): boolean => {
  const letters = run.toLowerCase().replace(/[^a-z]/g, "");
  const vowels = letters.replace(/[^aeiou]/g, "").length;
  return vowels / letters.length < 0.22 || /[bcdfghjklmnpqrstvwxz]{5}/i.test(run) || (/\d[A-Za-z]+\d/.test(run) && /[A-Z]{2}/.test(run));
};

/**
 * A file name that is nothing but an id: a bare hash, an encoded blob (a run of 40 letters and digits is no word), or
 * random letters and digits mixed in both cases, like the ids Frontify stores brand guideline images under
 * (CDrbG9w8RVujxhmrDWHJ.png, eQ8ysJqywFHMaaTRFCoz.png on brand.ripple.com). "image 3" says as much and makes a cleaner
 * file name.
 */
const isIdOnly = (base: string): boolean =>
  /[A-Za-z0-9]{40}/.test(base) ||
  /^(?=[0-9a-f]*\d)[0-9a-f]{16,}$/i.test(base) ||
  (/^(?=[^a-z]*[a-z])(?=[^A-Z]*[A-Z])(?=\D*\d)[A-Za-z0-9]{16,}$/.test(base) && readsAsRandom(base));

const NOTION_HOST = /(?:^|\.)(?:notion\.site|notion\.so|notionusercontent\.com)$/i;
const NOTION_ATTACHMENT = /^attachment:[0-9a-f-]{36}:(.+)$/i;

/**
 * The name a file was uploaded to Notion with. Notion serves it under names that bury it: `attachment:<uuid>:<name>` in
 * a page's own `/image/` path, the S3 key `prod-files-secure/<space>/<uuid>/<name>` encoded into one segment of
 * img.notionusercontent.com and followed by `/size/w=470`, and an encoded S3 URL in older pages. Read as a plain last
 * segment, ETHGlobal's brand page named its Horizontal-Colour, Vertical-Colour and Logomark-Colour logos
 * `attachment-<uuid>-ethgloba` (cut at 80 characters) and their resized copies `w=470`, so the downloads could not be
 * told apart. The name is the last part of the last segment that has an extension.
 */
function notionFileName(url: URL): string | undefined {
  if (!NOTION_HOST.test(url.hostname)) return undefined;
  for (const raw of url.pathname.split("/").filter(Boolean).reverse()) {
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      continue;
    }
    const name = (NOTION_ATTACHMENT.exec(segment)?.[1] ?? segment).split("/").pop() ?? "";
    if (/\.[a-z0-9]{2,5}$/i.test(name)) return name;
  }
  return undefined;
}

/** File name of an http(s) URL without extension, build hashes and size suffixes, after unwrapping CDN rewrites. */
export function cleanBasename(url: string): string | undefined {
  if (!/^https?:/i.test(url)) return undefined;
  const target = originalCandidates(url)[0] ?? url;
  let segment: string;
  try {
    const parsed = new URL(target);
    segment = notionFileName(parsed) ?? decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() ?? "");
  } catch {
    return undefined;
  }
  let base = segment.replace(/\.[a-z0-9]{1,5}$/i, "").replace(ID_PREFIX, "");
  for (let i = 0; i < 2; i++) base = base.replace(HEX_HASH, "").replace(BUNDLER_HASH, "");
  base = base.replace(SIZE_SUFFIX, "");
  return isIdOnly(base) ? undefined : usable(base);
}

/**
 * SVGR, the SVG loader of Next.js, Vite and Create React App, prefixes every id of a vector with the file it compiled
 * it from: `logo_svg__a` for logo.svg.
 */
const SVGR_ID = /\bid="([^"]+?)_svg__/;

/**
 * The name of the file an asset came from: the basename of its URL, and for an inline SVG the file SVGR compiled. It
 * names the asset the way a class does: redstone.finance labels its symbol marks "RedStone Symbol" and serves them as
 * RedStoneLogoSymbol.svg, and ethglobal.com draws its header logo inline with no label, class or alt, where only the
 * ids (`logo_svg__a`) say it came from logo.svg.
 */
export function fileName(url: string | undefined, markup?: string): string | undefined {
  return (url ? cleanBasename(url) : undefined) ?? (markup ? usable(SVGR_ID.exec(markup)?.[1]) : undefined);
}

/** Path segments that say what the page is about rather than which asset this is. */
const GENERIC_SEGMENT = /^(?:[a-z]{2}(?:[-_][a-z]{2,4})?|index|home|default|page|pages|assets?|images?|img|media|static|www|v?\d+)$/i;

/**
 * The part of an ancestor link that names the asset: the last meaningful path segment, and only when the link points
 * inside a section rather than at the section itself. stripe.com puts a customer logo in `/customers/hertz`, so the
 * link names it, while linear.app sends its whole logo wall to `/customers`, which names none of them.
 */
export function hrefName(href: string | undefined): string | undefined {
  if (!href || !/^https?:/i.test(href)) return undefined;
  let segments: string[];
  try {
    segments = new URL(href).pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  } catch {
    return undefined;
  }
  const meaningful = segments
    .map((segment) => segment.replace(/\.[a-z0-9]{1,5}$/i, ""))
    .filter((segment) => segment && !GENERIC_SEGMENT.test(segment));
  if (meaningful.length < 2) return undefined;
  return usable(meaningful[meaningful.length - 1].replace(/[-_]+/g, " "));
}

/**
 * The number that ends a word of an id (`clip0`, `logo2`). The lookbehind lets only the first digit of the run start a
 * match: `\d+$` alone tried from every digit of a run that does not end the word, and one id of a few hundred thousand
 * digits in a page's SVG held the event loop for minutes.
 */
const TRAILING_DIGITS = /(?<!\d)\d+$/;

/** React and bundler suffixes stuck on an otherwise readable id: `-:R4nrnmr6l6:`, `__abc123`. */
const ID_NOISE = /(?:[-_]{1,2}:[^:]*:|[-_]{1,2}[0-9a-f]{6,})$/i;
/**
 * Words a drawing tool or a bundler writes, which say how the vector is built rather than what it shows: an id made of
 * these alone (`clip0_1_2`, `paint0_linear_23_1`, `__lottie_element_1`) names nothing.
 */
const ID_FILLER = new Set([
  // What a bundler, a renderer or the format itself writes.
  "clip", "clippath", "mask", "filter", "paint", "pattern", "gradient", "linear", "radial", "stop", "defs", "use",
  "path", "fill", "stroke", "shape", "vector", "frame", "group", "layer", "element", "lottie", "uuid", "id", "svg",
  "graphic", "icon", "image", "img", "logo", "logotype", "wordmark", "mark", "brand", "xmlid", "symbol",
  // The word "layer" in the language the artist worked in. Illustrator and Sketch keep the localized default, so a
  // vector drawn in Spanish ships `id="Capa_1"`, one drawn in French `id="Calque_1"`, in German `id="Ebene_1"`.
  "capa", "capas", "calque", "calques", "ebene", "ebenen", "livello", "livelli", "laag", "lager", "camada", "warstwa",
  // The default name of a shape, a board or a control, which says what was drawn and not what it shows:
  // `Rectangle`, `Combined-Shape`, `Artboard`, `Page-1`, `Isolation_Mode`.
  "rect", "rectangle", "oval", "ellipse", "circle", "square", "triangle", "polygon", "polyline", "star", "line",
  "artboard", "board", "page", "canvas", "slice", "combined", "union", "subtract", "intersect", "difference",
  "outline", "compound", "isolation", "mode", "component", "instance", "copy", "untitled", "button", "bouton",
]);

/**
 * The name an inline SVG carries in its own markup: the id of the sprite symbol it draws, else the first id inside it,
 * which on a hand built logo is usually the brand (`bsport-linear-gradient-a`, `daybreak-yoga-logo-gradient`).
 */
export function markupName(markup: string | undefined): string | undefined {
  if (!markup) return undefined;
  const reference = /(?:xlink:)?href="#([^"]+)"/i.exec(markup)?.[1];
  const ids = reference ? [reference] : [...markup.matchAll(/\bid="([^"]+)"/gi)].map((match) => match[1]);
  for (const id of ids) {
    const words = id
      .replace(ID_NOISE, "")
      .replace(/([a-z\d])(?=[A-Z])/g, "$1-")
      .split(/[-_\s]+/)
      .map((word) => word.replace(TRAILING_DIGITS, "").toLowerCase())
      .filter((word) => word.length > 1 && !ID_FILLER.has(word));
    const name = usable(words.join(" "));
    if (name) return name;
  }
  return undefined;
}

/** The label with the logo words taken out, in lowercase: "Trezor logo" reads "trezor". */
const withoutLogoWords = (text: string) => text.toLowerCase().replace(/\b(?:logo(?:type)?|wordmark)\b/g, " ").replace(/\s+/g, " ").trim();

/**
 * The text of the link, when the label only names the site and the link names one of its sub-brands. A page template
 * that stamps "<site> logo" on every brand card names the site, not the card: trezor.visualbook.pro labels the Trezor
 * Academy mark "Trezor logo", inside a link that reads "Trezor Academy". The site logo keeps the label, and so does a
 * card whose link names something that is not the site's.
 */
function subBrandName(label: string | undefined, linkText: string | undefined, site: string | undefined, role: AssetRole): string | undefined {
  if (!label || !linkText || !site || role === "site-logo") return undefined;
  const name = withoutLogoWords(site);
  const text = linkText.toLowerCase();
  return withoutLogoWords(label) === name && text !== name && text.includes(name) ? linkText : undefined;
}

const ROLE_DEFAULT: Partial<Record<AssetRole, string>> = {
  "site-logo": "logo",
  favicon: "favicon",
  social: "social image",
};

export function displayName(input: NameInput): string {
  const site = usable(input.siteName);
  const roleDefault = site && ROLE_DEFAULT[input.role] ? `${site} ${ROLE_DEFAULT[input.role]}` : undefined;
  return (
    subBrandName(usable(input.label), usable(input.linkText), site, input.role) ??
    usable(input.label) ??
    // Only while it is the site logo: an ICO declared there is the favicon (bybit.com), and named one.
    (input.jsonLdLogo && site && input.role === "site-logo" ? `${site} logo` : undefined) ??
    roleDefault ??
    usable(input.linkText) ??
    (input.url ? cleanBasename(input.url) : undefined) ??
    // Nothing on the element itself: look around it, closest and most deliberate first. This is what an inline SVG
    // falls back on, and it is the difference between "Show the Substack testimonial" and "svg 123".
    usable(input.hints?.ancestorLabel) ??
    hrefName(input.hints?.linkHref) ??
    markupName(input.markup) ??
    usable(input.hints?.nearbyText) ??
    `${input.kind === "svg" ? "svg" : "image"} ${input.index}`
  );
}

/** Lowercase words joined by dashes. Latin accents are dropped; other scripts are kept. No dots, slashes or controls. */
function slugify(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/(\p{Script=Latin})\p{M}+/gu, "$1")
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Returns a function that turns display names into unique filenames for one scan: the name's slug, prefixed with the
 * site slug unless it already starts with it, at most 80 characters with the extension, `-2`, `-3` on clashes.
 */
export function createFilenamer(siteName: string): (name: string, extension: string) => string {
  const site = slugify(siteName) || "site";
  const used = new Set<string>();
  return (name, extension) => {
    const slug = slugify(name);
    const base = !slug || slug === site ? site : slug.startsWith(`${site}-`) ? slug : `${site}-${slug}`;
    const ext = slugify(extension) || "bin";
    for (let n = 1; ; n++) {
      const suffix = n === 1 ? "" : `-${n}`;
      const room = MAX_FILENAME - suffix.length - ext.length - 1;
      const stem = [...base].slice(0, room).join("").replace(/-+$/, "");
      const filename = `${stem}${suffix}.${ext}`;
      if (!used.has(filename)) {
        used.add(filename);
        return filename;
      }
    }
  };
}
