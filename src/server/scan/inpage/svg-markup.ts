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

/** A declared id. */
const ID = /\sid="([^"]+)"/g;
/** A declared id or a reference to one, followed by a quote, a parenthesis or whitespace: `id="a"`, `url(#a)`, `href="#a"`. */
const ID_OR_REFERENCE = /(id="|#)([^"')\s#]+)(?=["')\s])/g;

/**
 * The form of serialized SVG markup the collector hashes to tell drawings apart: ids renamed in order of appearance,
 * so two copies of one icon with generated ids hash the same, and whitespace between tags collapsed. All ids are
 * renamed in one pass. A pass per id read the whole markup once for each of them, and an SVG of 70,000 ids took minutes.
 */
export function canonicalSvgMarkup(markup: string): string {
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
