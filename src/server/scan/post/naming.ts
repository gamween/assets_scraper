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

/** File name of an http(s) URL without extension, build hashes and size suffixes, after unwrapping CDN rewrites. */
export function cleanBasename(url: string): string | undefined {
  if (!/^https?:/i.test(url)) return undefined;
  const target = originalCandidates(url)[0] ?? url;
  let segment: string;
  try {
    segment = new URL(target).pathname.split("/").filter(Boolean).pop() ?? "";
    segment = decodeURIComponent(segment);
  } catch {
    return undefined;
  }
  let base = segment.replace(/\.[a-z0-9]{1,5}$/i, "");
  for (let i = 0; i < 2; i++) base = base.replace(HEX_HASH, "").replace(BUNDLER_HASH, "");
  base = base.replace(SIZE_SUFFIX, "");
  return usable(base);
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
      .map((word) => word.replace(/\d+$/, "").toLowerCase())
      .filter((word) => word.length > 1 && !ID_FILLER.has(word));
    const name = usable(words.join(" "));
    if (name) return name;
  }
  return undefined;
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
    usable(input.label) ??
    (input.jsonLdLogo && site ? `${site} logo` : undefined) ??
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
export function slugify(text: string): string {
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
