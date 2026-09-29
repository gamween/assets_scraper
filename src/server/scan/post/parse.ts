import { tokenize, tokenTypes as T } from "css-tree/tokenizer";
import { ByteStack } from "../byte-stack";
import { extractCssUrls } from "../inpage/css-values";
import { percentDecode } from "../percent";
import { searchFrom } from "./search";

/**
 * Parsers of post-processing. The URLs of one CSS value are read by `extractCssUrls`, which the in-page collector
 * bundles too (`inpage/css-values.ts`), so the page and Node read `url()` and `image-set()` the same way.
 */

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

/** The index of the first `:` of `text` outside CSS comments, or -1. */
function colonOutsideComments(text: string): number {
  let from = 0;
  for (;;) {
    const colon = text.indexOf(":", from);
    const comment = text.indexOf("/*", from);
    if (colon < 0 || comment < 0 || colon < comment) return colon;
    const close = text.indexOf("*/", comment + 2);
    if (close < 0) return -1;
    from = close + 2;
  }
}

/** Whether `visit` asked to stop. */
class Stop extends Error {}

/**
 * The URL of a file as the network sees it: an http(s) URL without its fragment, which no request carries, so that
 * `icons.svg#home` meets the capture of `icons.svg`. A fragment is part of the payload of a `data:` URI and stays.
 */
export function withoutFragment(url: URL): string {
  if (url.protocol === "http:" || url.protocol === "https:") url.hash = "";
  return url.href;
}

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
    const colon = colonOutsideComments(text);
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
        url = withoutFragment(new URL(raw, baseUrl));
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

/** The most characters of a `sizes` value read: a real one lists a few sizes, a page or a manifest can send megabytes. */
export const MAX_ICON_SIZES_CHARS = 256;
/** One `WxH` size, a whole number of at most five digits on each side. */
const ICON_SIZE = /(?<!\d)(\d{1,5})[xX](\d{1,5})(?!\d)/g;

/**
 * The largest size an icon declares in its `sizes` (`"16x16 32x32 any"`), from a `<link>` or a web manifest. Only the
 * first `MAX_ICON_SIZES_CHARS` are read. The unbounded `(\d+)x(\d+)` this replaces backtracked over a long digit run from
 * every digit of it: half a million digits in a manifest held the event loop for over a minute.
 */
export function largestIconSize(sizes: string | undefined): { width: number; height: number } | undefined {
  if (!sizes) return undefined;
  const text = sizes.slice(0, MAX_ICON_SIZES_CHARS);
  let largest: { width: number; height: number } | undefined;
  for (let match = searchFrom(text, ICON_SIZE, 0); match; match = searchFrom(text, ICON_SIZE, match.index + match[0].length)) {
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!largest || width * height > largest.width * largest.height) largest = { width, height };
  }
  return largest;
}

/** The start of an `<svg>` tag, and the end of any tag. */
const SVG_TAG = /<svg\b/gi;
const TAG_END = />/g;
/** The longest root tag read: a real one is never near this, and a scraped one can be megabytes of junk. */
const MAX_ROOT_TAG_CHARS = 4096;

/** Width and height of an SVG from its root attributes, else from its viewBox. */
export function svgSize(markup: string): { width?: number; height?: number } {
  // Two forward searches find the root tag, and the cut bounds every regex below, the way preflight caps a tag. One
  // pattern for the whole tag (`<svg\b[^>]*>`) read from every `<svg` to the end of the markup when no `>` followed.
  const open = searchFrom(markup, SVG_TAG, 0);
  const close = open && searchFrom(markup, TAG_END, open.index + open[0].length);
  const root = open && close ? markup.slice(open.index, Math.min(close.index + 1, open.index + MAX_ROOT_TAG_CHARS)) : "";
  // The digit runs are bounded so the alternatives at each start position stay constant: an unbounded `\d*\.?\d+`
  // backtracks quadratically over a long digit run that never reaches the closing quote.
  const attribute = (name: string) => Number(new RegExp(`\\s${name}\\s*=\\s*["']\\s*(\\d{1,10}(?:\\.\\d{1,10})?|\\.\\d{1,10})(?:px)?\\s*["']`, "i").exec(root)?.[1]) || undefined;
  const width = attribute("width");
  const height = attribute("height");
  if (width && height) return { width, height };
  const box = /\sviewBox\s*=\s*["']([^"']+)["']/i.exec(root)?.[1]?.trim().split(/[\s,]+/).map(Number);
  return box?.length === 4 && box[2] > 0 && box[3] > 0 ? { width: box[2], height: box[3] } : {};
}

/**
 * Decodes a `data:` URI into its media type and bytes, or null when it is not a valid data URI. The payload is decoded
 * byte by byte the way a browser does, so a lone `%` is a literal byte rather than a reason to drop the whole URI: an
 * unescaped SVG data URI carries raw percent signs in gradients and percentage geometry.
 */
export function decodeDataUri(uri: string): { mime: string; buffer: Buffer } | null {
  const match = /^data:([^;,]*)((?:;[^;,]*)*),([\s\S]*)$/i.exec(uri);
  if (!match) return null;
  const mime = (match[1] || "text/plain").trim().toLowerCase();
  const raw = percentDecode(match[3]);
  const buffer = /;base64/i.test(match[2]) ? Buffer.from(raw.toString("latin1").replace(/\s+/g, ""), "base64") : raw;
  return { mime, buffer };
}
