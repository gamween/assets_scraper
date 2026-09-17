import * as csstree from "css-tree";

/**
 * Parsers shared by post-processing. The in-page collector (`inpage/collector.src.ts`) cannot import app code, so it
 * carries its own copies of `parseSrcset` and `extractCssUrls`: keep both in sync.
 */

export interface SrcsetCandidate {
  url: string;
  w?: number;
  x?: number;
}

/** HTML-style srcset parser: a URL runs until whitespace, so commas inside URLs (Cloudinary `w_500,c_fill`) are kept. */
export function parseSrcset(value: string | null | undefined): SrcsetCandidate[] {
  const out: SrcsetCandidate[] = [];
  if (!value) return out;
  const s = value;
  const n = s.length;
  const space = /\s/;
  let i = 0;
  while (i < n) {
    while (i < n && (s[i] === "," || space.test(s[i]))) i++;
    if (i >= n) break;
    const start = i;
    while (i < n && !space.test(s[i])) i++;
    let url = s.slice(start, i);
    let descriptor = "";
    if (/,+$/.test(url)) {
      url = url.replace(/,+$/, "");
    } else {
      let depth = 0;
      const descriptorStart = i;
      while (i < n) {
        const c = s[i];
        if (c === "(") depth++;
        else if (c === ")") depth--;
        else if (c === "," && depth <= 0) break;
        i++;
      }
      descriptor = s.slice(descriptorStart, i).trim();
      i++;
    }
    if (!url) continue;
    const w = descriptor.match(/(\d+)w\b/);
    const x = descriptor.match(/(\d*\.?\d+)x\b/);
    if (w) out.push({ url, w: Number(w[1]) });
    else out.push({ url, x: x ? Number(x[1]) : 1 });
  }
  return out;
}

const URL_TOKEN = /url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)\s]*))\s*\)/g;
const QUOTED = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g;
const unescapeCss = (text: string) => text.replace(/\\(.)/g, "$1");

/** URLs in a CSS value: every `url()`, plus the bare strings of `image-set()`. Fragment-only references are skipped. */
export function extractCssUrls(value: string | null | undefined): string[] {
  const out: string[] = [];
  if (!value || value === "none") return out;
  for (const match of value.matchAll(URL_TOKEN)) out.push(unescapeCss(match[1] ?? match[2] ?? match[3] ?? ""));
  if (/image-set\(/i.test(value)) {
    const rest = value.replace(URL_TOKEN, " ");
    for (const match of rest.matchAll(QUOTED)) out.push(unescapeCss(match[1] ?? match[2] ?? ""));
  }
  return [...new Set(out)].filter((url) => url && !url.startsWith("#"));
}

export interface StylesheetUrl {
  url: string;
  property: string;
  declaration: number;     // which declaration, counted over the declarations with image URLs in sheet order
  imageSet: boolean;       // the URLs of one image-set() declaration are variants of one image
}

/** Properties whose `url()` never points at an image asset. */
const NON_IMAGE_PROPERTY = /^(?:cursor|behavior|clip-path|filter|marker(?:-start|-mid|-end)?|src)$/;

/**
 * Image URLs declared in a stylesheet's text, for sheets the page could not read through CSSOM (spec 8.1).
 * `@font-face` rules are left to the fonts module.
 */
export function extractStylesheetUrls(cssText: string, baseUrl: string): StylesheetUrl[] {
  const out: StylesheetUrl[] = [];
  let declaration = 0;
  let ast: csstree.CssNode;
  try {
    ast = csstree.parse(cssText, {
      parseValue: false,
      parseRulePrelude: false,
      parseAtrulePrelude: false,
      parseCustomProperty: false,
      onParseError: () => {},
    });
  } catch {
    return out;
  }
  csstree.walk(ast, {
    visit: "Declaration",
    enter(node) {
      if (this.atrule?.name.toLowerCase() === "font-face") return;
      const property = node.property.startsWith("--") ? node.property : node.property.toLowerCase();
      if (NON_IMAGE_PROPERTY.test(property)) return;
      const value = node.value.type === "Raw" ? node.value.value : csstree.generate(node.value);
      if (!/url\(|image-set\(/i.test(value)) return;
      const imageSet = /image-set\(/i.test(value);
      for (const raw of extractCssUrls(value)) {
        try {
          out.push({ url: new URL(raw, baseUrl).href, property, declaration, imageSet });
        } catch {
          // not a URL
        }
      }
      declaration++;
    },
  });
  return out;
}

/** Decodes a `data:` URI into its media type and bytes, or null when it is not a valid data URI. */
export function decodeDataUri(uri: string): { mime: string; buffer: Buffer } | null {
  const match = /^data:([^;,]*)((?:;[^;,]*)*),([\s\S]*)$/i.exec(uri);
  if (!match) return null;
  const mime = (match[1] || "text/plain").trim().toLowerCase();
  try {
    const buffer = /;base64/i.test(match[2])
      ? Buffer.from(decodeURIComponent(match[3]).replace(/\s+/g, ""), "base64")
      : Buffer.from(decodeURIComponent(match[3]), "utf8");
    return { mime, buffer };
  } catch {
    return null;
  }
}
