import { tokenize, tokenTypes as T } from "css-tree/tokenizer";
import { ByteStack } from "../byte-stack";

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

/** The token that closes each opening token: functions, `(`, `[` and `{`. */
const CLOSERS: Partial<Record<number, number>> = {
  [T.Function]: T.RightParenthesis,
  [T.LeftParenthesis]: T.RightParenthesis,
  [T.LeftSquareBracket]: T.RightSquareBracket,
  [T.LeftCurlyBracket]: T.RightCurlyBracket,
};
/** Marks a `{` block that is an `@font-face` rule or inside one. */
const FONT_FACE = 0x80;
const PROPERTY = /^(?:--[\w-]*|-?[A-Za-z_][\w-]*)$/;
const COMMENT = /\/\*[\s\S]*?(?:\*\/|$)/g;

/** Whether `visit` asked to stop. */
class Stop extends Error {}

/**
 * Image URLs declared in a stylesheet's text, for sheets the page could not read through CSSOM (spec 8.1), passed to
 * `visit` in sheet order; `visit` returns `"stop"` to end the scan. `@font-face` rules are left to the fonts module.
 *
 * One pass over css-tree tokens, never its parser: a parse tree of a 15 MB sheet of 370,000 rules took 323 MB, and the
 * parser keeps buffers the size of the largest sheet it ever read. A declaration is the text between `{`, `;` or `}`
 * and the next `;` or `}` of a block, outside parentheses; text that ends at `{` is a rule's prelude. Broken CSS never
 * throws: stray closers are skipped and a declaration left open at the end is read.
 *
 * Where this differs from a parse tree, on malformed or rare CSS: a `{}` block inside a custom property's value is read
 * as a nested rule, so `--y: { cursor: url(c.png) }` gives property `cursor` (filtered) rather than `--y`; and a
 * declaration with no `;` before a nested rule becomes that rule's prelude, so `background: url(a.png) .b { ... }`
 * yields no URL.
 */
export function forEachStylesheetUrl(cssText: string, baseUrl: string, visit: (item: StylesheetUrl) => void | "stop"): void {
  if (!/url\(|image-set\(/i.test(cssText)) return;
  const stack = new ByteStack();
  let segmentStart = 0;
  let declaration = 0;

  const readDeclaration = (end: number) => {
    const top = stack.top();
    if (top < 0 || (top & ~FONT_FACE) !== T.RightCurlyBracket || top & FONT_FACE) return;
    const text = cssText.slice(segmentStart, end);
    if (!/url\(|image-set\(/i.test(text)) return;
    const colon = text.indexOf(":");
    if (colon < 0) return;
    let property = text.slice(0, colon).replace(COMMENT, "").trim();
    if (!PROPERTY.test(property)) return;
    if (!property.startsWith("--")) property = property.toLowerCase();
    if (NON_IMAGE_PROPERTY.test(property)) return;
    const value = text.slice(colon + 1);
    const imageSet = /image-set\(/i.test(value);
    for (const raw of extractCssUrls(value)) {
      let url: string;
      try {
        url = new URL(raw, baseUrl).href;
      } catch {
        continue; // not a URL
      }
      if (visit({ url, property, declaration, imageSet }) === "stop") throw new Stop();
    }
    declaration++;
  };

  const onToken = (type: number, start: number, end: number) => {
    const top = stack.top();
    const inBlock = top < 0 || (top & ~FONT_FACE) === T.RightCurlyBracket;
    if (top >= 0 && type === (top & ~FONT_FACE)) {
      if (type === T.RightCurlyBracket) readDeclaration(start);
      stack.pop();
      if (type === T.RightCurlyBracket) segmentStart = end;
      return;
    }
    if (!inBlock) {
      const closer = CLOSERS[type];
      if (closer !== undefined) stack.push(closer);
      return;
    }
    if (type === T.Semicolon) {
      readDeclaration(start);
      segmentStart = end;
    } else if (type === T.LeftCurlyBracket) {
      const prelude = cssText.slice(segmentStart, start).replace(COMMENT, "").trim();
      const fontFace = /^@font-face$/i.test(prelude) || (top >= 0 && (top & FONT_FACE) !== 0);
      stack.push(fontFace ? T.RightCurlyBracket | FONT_FACE : T.RightCurlyBracket);
      segmentStart = end;
    } else if (type === T.RightCurlyBracket) {
      // A stray closer at the top level
      segmentStart = end;
    } else {
      const closer = CLOSERS[type];
      if (closer !== undefined) stack.push(closer);
    }
  };

  try {
    tokenize(cssText, onToken);
    while (stack.length && (stack.top() & ~FONT_FACE) !== T.RightCurlyBracket) stack.pop();
    readDeclaration(cssText.length);
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
  }
}

/** Every image URL `forEachStylesheetUrl` reads from a stylesheet's text. */
export function extractStylesheetUrls(cssText: string, baseUrl: string): StylesheetUrl[] {
  const out: StylesheetUrl[] = [];
  forEachStylesheetUrl(cssText, baseUrl, (item) => {
    out.push(item);
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
