/**
 * Text rewrites of the SVG markup the in-page collector normalizes, in a module of their own like `lists.ts`: the
 * collector bundles them, and the unit tests read the same copy in Node. The markup is the page's, so each rewrite is
 * one linear pass over it.
 */

/** `var(--name)` or `var(--name, fallback)`, with at most one level of parentheses inside the fallback. */
const VAR = /var\(\s*--[\w-]+\s*(?:,((?:[^()]|\([^()]*\))*))?\)/g;

/**
 * An attribute value with each `var()` replaced by its fallback, which a standalone file needs since the custom
 * properties stay behind in the page, or "" when a `var()` has no usable fallback. The fallback takes its whitespace
 * with it and is trimmed after: a `\s*` in front of it, as the pattern once had, matched the same spaces as the
 * fallback, and a long run of them after `var(--a,` was quadratic from every start.
 */
export function varFallback(value: string): string {
  const fallback = value.replace(VAR, (_match, inner?: string) => (inner ?? "").trim()).trim();
  return fallback.includes("var(") ? "" : fallback;
}

/** `currentColor` as a whole keyword, in any case: CSS keywords are case-insensitive, and Chrome serializes it lower case. */
const CURRENT_COLOR = /(?<![\w#-])currentcolor(?![\w-])/gi;

/**
 * A paint value with each `currentColor` replaced by `color()`, or null when it has none. `fill="currentColor"` draws in
 * whatever `color` the page gave the element, and a standalone file has no page around it. The colour is asked for
 * only when there is one to replace, since the collector reads it from a computed style.
 */
export function withCurrentColor(value: string, color: () => string): string | null {
  const resolved = value.replace(CURRENT_COLOR, color);
  return resolved === value ? null : resolved;
}

/** The open tag of the root `<svg>`, after any prolog, comment or doctype. */
const ROOT_TAG = /<svg\b[^>]*>/i;
/** A `width` or `height` attribute in either quote style. The name has to follow whitespace, so `stroke-width` stays. */
const SIZE_ATTRIBUTE = /\s(?:width|height)\s*=\s*(?:"[^"]*"|'[^']*')/gi;

/**
 * Markup without the `width` and `height` of its root `<svg>` when that root has a viewBox. The collector writes the
 * size an SVG rendered at onto its root, so one logo shown 136 px wide in the header and 137 px wide in a menu serialized
 * to two markups and was reported as two logos (bnbchain.org). With a viewBox the drawing is the same whatever those two
 * say. Without one they set the coordinate system, so they stay.
 */
export function withoutRootSize(markup: string): string {
  const root = ROOT_TAG.exec(markup);
  if (!root || !/\sviewBox\s*=/i.test(root[0])) return markup;
  return markup.slice(0, root.index) + root[0].replace(SIZE_ATTRIBUTE, "") + markup.slice(root.index + root[0].length);
}

/** A declared id. */
const ID = /\sid="([^"]+)"/g;
/** A declared id or a reference to one, followed by a quote, a parenthesis or whitespace: `id="a"`, `url(#a)`, `href="#a"`. */
const ID_OR_REFERENCE = /(id="|#)([^"')\s#]+)(?=["')\s])/g;

/**
 * The form of serialized SVG markup the collector hashes to tell drawings apart: the root's rendered size dropped
 * (`withoutRootSize`), ids renamed in order of appearance, so two copies of one icon with generated ids hash the same,
 * and whitespace between tags collapsed. All ids are renamed in one pass. A pass per id read the whole markup once for
 * each of them, and an SVG of 70,000 ids took minutes.
 */
export function canonicalSvgMarkup(serialized: string): string {
  const markup = withoutRootSize(serialized);
  const ids = new Map<string, string>();
  for (const match of markup.matchAll(ID)) if (!ids.has(match[1])) ids.set(match[1], `i${ids.size}`);
  return markup
    .replace(ID_OR_REFERENCE, (match, prefix: string, id: string) => {
      const renamed = ids.get(id);
      return renamed === undefined ? match : `${prefix}${renamed}`;
    })
    .replace(/>\s+</g, "><")
    .replace(/\s{2,}/g, " ");
}
