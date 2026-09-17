import { tokenize, tokenTypes as T } from "css-tree/tokenizer";
import { ident } from "css-tree/utils";
import { ByteStack } from "../byte-stack";
import type { RawFontFaceRule } from "../types";
import { fontDataUri, isDataUri, parseFileUrl } from "./files";

// Only the css-tree tokenizer, never its parser. The parser is one shared object whose token buffers keep the size of
// the largest source it ever parsed and are cleared on every parse: after one large stylesheet, each later parse costs
// time in proportion to that stylesheet, for the life of the process. The tokenizer keeps no state between calls.

type FontSrc = RawFontFaceRule["src"][number];

/** The token that closes each opening token: functions, `(`, `[` and `{`. */
const CLOSERS: Partial<Record<number, number>> = {
  [T.Function]: T.RightParenthesis,
  [T.LeftParenthesis]: T.RightParenthesis,
  [T.LeftSquareBracket]: T.RightSquareBracket,
  [T.LeftCurlyBracket]: T.RightCurlyBracket,
};

const isBlank = (type: number) => type === T.WhiteSpace || type === T.Comment;

/**
 * The most `url()` and `local()` sources read from one `src` value, valid or not. Real rules list 6 at most, and each
 * source read costs objects and a URL parse, synchronously: a rule of a million sources in a 15 MB stylesheet took 2
 * seconds and 338 MB to list one file.
 */
export const MAX_SRC_ENTRIES = 16;

/**
 * The most characters of a `font-family` value, before decoding, from a stylesheet, the CSSOM or `document.fonts`. Real
 * families have a few dozen. A longer value is dropped, with its rule or status, before it is decoded: otherwise one
 * stylesheet could name a family with 15 MB, which the `fonts` line sends three times.
 */
export const MAX_FAMILY_CHARS = 1024;

/**
 * The most characters of a `font-weight`, `font-style` or `font-stretch` value, before normalizing, from a stylesheet,
 * the CSSOM or `document.fonts`. Real values have about 20 at most (`oblique 10deg 20deg`). A longer value is dropped,
 * with its rule or status, before it is normalized: normalizing splits a weight at each space, and one 15 MB
 * `font-weight` in a stylesheet took 2.3 seconds and 1.2 GB, then went out in the `fonts` line.
 */
export const MAX_DESCRIPTOR_CHARS = 256;

/**
 * The most characters of a `unicode-range` value, before normalizing, from a stylesheet or the CSSOM. The subsets of
 * Google Fonts CJK families have 2,000 at most. A longer value is dropped, with its rule, before it is normalized or
 * parsed: parsing makes a pair of code points for each comma, and one 15 MB `unicode-range` took 620 MB.
 */
export const MAX_UNICODE_RANGE_CHARS = 64 * 1024;

/**
 * Whether the weight, style and stretch of a rule or `document.fonts` status fit `MAX_DESCRIPTOR_CHARS`, and its
 * unicode range `MAX_UNICODE_RANGE_CHARS`. Missing descriptors fit.
 */
export function withinDescriptorLimits(face: { weight?: string; style?: string; stretch?: string; unicodeRange?: string }): boolean {
  return (
    [face.weight, face.style, face.stretch].every((value) => (value?.length ?? 0) <= MAX_DESCRIPTOR_CHARS) &&
    (face.unicodeRange?.length ?? 0) <= MAX_UNICODE_RANGE_CHARS
  );
}

/**
 * A CSS escape as css-tree reads one: a backslash, then 1 to 6 hex digits and one optional whitespace (`\r\n` counts as
 * one), or any other code unit, or nothing at the end of the text.
 */
const ESCAPE = /\\(?:[0-9a-f]{1,6}(?:\r\n|[\t\n\f\r ])?|\r\n|[^])?/gi;

/**
 * Text with its CSS escapes decoded (`\31 23 Grotesk` gives "123 Grotesk"), exactly as css-tree's `ident.decode` gives
 * it. css-tree appends each character of the text to its result one at a time, and V8 keeps a string built that way as
 * a rope of about 30 bytes per character until something reads it: decoding a 15 MB name took 455 MB, and a family
 * kept it with its rule. Here text without escapes is returned as it is, and each escape is decoded on its own into one
 * flat string.
 */
export function decodeIdent(text: string): string {
  return text.includes("\\") ? text.replace(ESCAPE, (escape) => ident.decode(escape)) : text;
}

/** Whether the last character of `text` is escaped: preceded by an odd number of backslashes. */
function endsEscaped(text: string): boolean {
  let backslashes = 0;
  while (backslashes < text.length - 1 && text[text.length - 2 - backslashes] === "\\") backslashes += 1;
  return backslashes % 2 === 1;
}

/**
 * The value of a string token (`"a\"b"` gives `a"b`) with `decodeIdent`. A string left open at the end of the text keeps
 * its last character when that is an escaped quote (`"a\"` gives `a"`), as browsers read it.
 */
function decodeString(token: string): string {
  const closed = token.length > 1 && token[token.length - 1] === token[0] && !endsEscaped(token);
  return decodeIdent(token.slice(1, closed ? -1 : undefined));
}

/** The URL of a `url(...)` token, without its whitespace, with `decodeIdent`. */
function decodeUrlToken(token: string): string {
  const closed = token.endsWith(")") && !endsEscaped(token);
  return decodeIdent(token.slice("url(".length, closed ? -1 : undefined)).trim();
}

/** Thrown from a tokenizer callback to stop tokenizing once enough has been read. */
class Enough extends Error {}

/** The source of a `url()`: a `data:` URI within the bounds of `fontDataUri`, or a URL within those of `parseFileUrl`. */
function absoluteUrl(value: string, baseUrl: string): FontSrc | null {
  // Not `new URL`: a stylesheet can hold a million invalid URLs, and a throw costs 10 times a parse
  const url = !value ? null : isDataUri(value) ? fontDataUri(value) : parseFileUrl(value, baseUrl)?.href;
  return url ? { url } : null;
}

/** A `url(`, `local(` or `format(` function of a `src` entry, read at its own nesting level. */
interface SrcFunction {
  kind: "url" | "local" | "format";
  /** Its strings and identifiers, decoded, while they can still make its source or hint. */
  texts: string[];
  /** For `local()`: characters of its strings and identifiers before decoding, with one space between each two. */
  chars: number;
  /** Whether it gives nothing: a `url()` with anything but one string or identifier, or a `local()` over its cap. */
  invalid: boolean;
}

/**
 * Parses an `@font-face` `src` value into `local()` names and absolute `url()`s with their optional format hint
 * (the first one of a legacy list), from css-tree tokens: the value comes from scraped CSS, so no backtracking regex.
 * Lenient like the discovery lab: in each comma-separated entry, the first valid `url()` or non-empty `local()` is the
 * source, whatever comes before it, and the first `format()` after a `url()` is its hint. At most `MAX_SRC_ENTRIES`
 * `url()` and `local()` sources are read, valid or not: tokenizing stops at the next one. A `local()` name over
 * `MAX_FAMILY_CHARS` characters before decoding, a `data:` URI out of the bounds of `fontDataUri`, and another `url()`
 * over `MAX_URL_CHARS` (`files.ts`), give no source. The arguments of a function are decoded only while they can still
 * make its source or hint: 15 MB of `local(ab ab ...)` or `url("ab" "ab" ...)` cost no more than tokenizing them past
 * the first few.
 * Unbalanced closing tokens are skipped and functions left open at the end of the value are closed.
 */
export function parseFontSrc(src: string, baseUrl: string): FontSrc[] {
  const out: FontSrc[] = [];
  const closers = new ByteStack();
  // The source of the current comma-separated entry, once found
  let current: FontSrc | null = null;
  let fn: SrcFunction | null = null;
  let read = 0;

  const startSource = () => {
    if (read === MAX_SRC_ENTRIES) throw new Enough();
    read += 1;
  };

  const addSource = (source: FontSrc | null) => {
    if (source) out.push((current = source));
  };

  const endFunction = () => {
    const { kind, texts, invalid } = fn!;
    fn = null;
    if (kind === "format") {
      const hint = texts[0]?.trim().toLowerCase();
      if (hint && current) current.format = hint;
    } else if (kind === "local") {
      const name = invalid ? "" : texts.join(" ").trim();
      addSource(name ? { local: name } : null);
    } else {
      addSource(texts.length === 1 && !invalid ? absoluteUrl(texts[0].trim(), baseUrl) : null);
    }
  };

  const decodeText = (type: number, start: number, end: number) =>
    type === T.String ? decodeString(src.slice(start, end)) : decodeIdent(src.slice(start, end));

  /** Reads a token other than whitespace and comments at the top level of a function. */
  const readArgument = (fn: SrcFunction, type: number, start: number, end: number) => {
    if (fn.invalid) return;
    const isText = type === T.String || type === T.Ident;
    if (fn.kind === "format") {
      // format() keeps its first argument, when it is a string or an identifier
      if (!fn.texts.length) fn.texts.push(isText ? decodeText(type, start, end) : "");
    } else if (fn.kind === "url") {
      if (isText && !fn.texts.length) fn.texts.push(decodeText(type, start, end));
      else fn.invalid = true;
    } else if (isText) {
      // local() skips other tokens
      fn.chars += end - start + (fn.texts.length ? 1 : 0);
      if (fn.chars <= MAX_FAMILY_CHARS) {
        fn.texts.push(decodeText(type, start, end));
      } else {
        fn.invalid = true;
        fn.texts = [];
      }
    }
  };

  const onToken = (type: number, start: number, end: number) => {
    if (type === closers.top()) {
      closers.pop();
      if (!closers.length && fn) endFunction();
      return;
    }
    if (closers.length === 1 && fn && !isBlank(type)) {
      readArgument(fn, type, start, end);
    } else if (!closers.length) {
      if (type === T.Comma) {
        current = null;
      } else if (!current && type === T.Url) {
        startSource();
        addSource(absoluteUrl(decodeUrlToken(src.slice(start, end)), baseUrl));
      } else if (type === T.Function) {
        const name = decodeIdent(src.slice(start, end - 1)).toLowerCase();
        if (!current && (name === "url" || name === "local")) {
          startSource();
          fn = { kind: name, texts: [], chars: 0, invalid: false };
        } else if (current?.url && !current.format && name === "format") {
          fn = { kind: "format", texts: [], chars: 0, invalid: false };
        }
      }
    }
    const closer = CLOSERS[type];
    if (closer !== undefined) closers.push(closer);
  };

  try {
    tokenize(src, onToken);
    if (fn) endFunction();
  } catch (error) {
    if (!(error instanceof Enough)) throw error;
  }
  return out;
}

const collapse = (value: string) => value.trim().replace(/\s+/g, " ");

/**
 * The `font-family` descriptor as browsers read it: one string, or identifiers joined by one space (`Mona   Sans` gives
 * "Mona Sans"), with CSS escapes decoded (`"\5FAE\8F6F\96C5\9ED1"` gives its four CJK characters). Empty for any other
 * value, which browsers drop.
 */
function readFamilyName(value: string): string {
  const names: string[] = [];
  let quoted = false;
  let invalid = false;
  tokenize(value, (type, start, end) => {
    if (invalid || isBlank(type)) return;
    if (type === T.String && !names.length) {
      names.push(decodeString(value.slice(start, end)));
      quoted = true;
    } else if (type === T.Ident && !quoted) {
      names.push(decodeIdent(value.slice(start, end)));
    } else {
      invalid = true;
    }
  });
  return invalid ? "" : names.join(" ");
}

const WEIGHT_KEYWORDS: Record<string, string> = { normal: "400", bold: "700" };

/** `font-weight` descriptor: "400", "100 900". Missing and `normal` give "400", `bold` gives "700". */
export function normalizeWeight(value: string | undefined): string {
  const weight = collapse(value ?? "").toLowerCase();
  if (!weight) return "400";
  return weight
    .split(" ")
    .map((part) => WEIGHT_KEYWORDS[part] ?? part)
    .join(" ");
}

/** `font-style` descriptor: "normal", "italic", "oblique 10deg". Missing gives "normal". */
export function normalizeStyle(value: string | undefined): string {
  return collapse(value ?? "").toLowerCase() || "normal";
}

/** `font-stretch` descriptor, or undefined when it is missing or the default (`normal`, `100%`). */
export function normalizeStretch(value: string | undefined): string | undefined {
  const stretch = collapse(value ?? "").toLowerCase();
  return !stretch || stretch === "normal" || stretch === "100%" ? undefined : stretch;
}

/** Conditional group rules, whose blocks can hold `@font-face` rules. */
const GROUP_RULES = new Set(["media", "supports", "layer", "container", "document", "-moz-document", "scope", "starting-style"]);

/**
 * Flag on a stack entry (the closing token type of an open `{`, `(`, `[` or function) for a block that holds rules: a
 * group rule block at the top level or in another such block.
 */
const HOLDS_RULES = 0x80;

/** The descriptors `toRule` reads. */
const READ_DESCRIPTORS = new Set(["font-family", "src", "font-weight", "font-style", "font-stretch", "unicode-range"]);

/** The descriptors of an open `@font-face` block, and the declaration being read in it. */
interface FontFaceBlock {
  /** Stack depth of the block's own declarations. */
  depth: number;
  /** Values of `READ_DESCRIPTORS`, as written, comments included. */
  descriptors: Record<string, string>;
  /** Lowercase name of the declaration, once read. */
  name: string | null;
  /** Where the value starts after its colon, or -1 before the colon. */
  valueStart: number;
  /** Whether the last token other than whitespace and comments was `!`. */
  bang: boolean;
  invalid: boolean;
}

/**
 * A descriptor value with each comment read as a space, as browsers read it, or "" when it is missing. Only for values
 * within their caps: it makes two strings for each comment.
 */
function uncomment(value = ""): string {
  if (!value.includes("/*")) return value;
  const parts: string[] = [];
  let from = 0;
  tokenize(value, (type, start, end) => {
    if (type !== T.Comment) return;
    parts.push(value.slice(from, start), " ");
    from = end;
  });
  return parts.join("") + value.slice(from);
}

/**
 * Collects `@font-face` rules from stylesheet text, at the top level and in `@media`, `@supports`, `@layer` and the
 * other conditional group rules, in one pass over css-tree tokens. As in browsers, a rule starts a statement and has
 * no prelude: an `@font-face` inside a declaration value or a style rule, after a qualified rule's prelude (which runs
 * over semicolons up to its block), or followed by anything but whitespace and comments before its block, is not a
 * rule. Names are read with their CSS escapes decoded. Relative URLs resolve against `baseUrl` (the stylesheet URL).
 * A rule with a family over `MAX_FAMILY_CHARS`, or a weight, style, stretch or unicode range over the caps of
 * `withinDescriptorLimits`, its comments counted, is skipped. Stops after `maxRules` rules. Broken CSS never throws:
 * invalid declarations are skipped and blocks left open at the end are closed. In a descriptor value a comment reads as
 * a space, and a descriptor marked `!important` is dropped, as browsers drop it. A value is kept as one slice of the
 * stylesheet, for the descriptors a rule reads only: with two strings kept for each comment, a 15 MB stylesheet of one
 * value full of comments peaked at 283 MB.
 */
export function parseFontFaceCss(cssText: string, baseUrl: string, options: { maxRules?: number } = {}): RawFontFaceRule[] {
  const maxRules = options.maxRules ?? Infinity;
  const rules: RawFontFaceRule[] = [];
  // Sheets without an `@font-face` keyword, plain or escaped, are not tokenized
  if (!(maxRules > 0) || !/@font-face|@[\w-]*\\/i.test(cssText)) return rules;
  const stack = new ByteStack();
  let fontFace: FontFaceBlock | null = null;
  // At the top level or in a group rule block: whether the next token starts a statement, the at-rule it started, and
  // whether that at-rule has a prelude
  let statementStart = true;
  let atRule: string | null = null;
  let prelude = false;

  const endDeclaration = (block: FontFaceBlock, end: number) => {
    if (block.name && READ_DESCRIPTORS.has(block.name) && block.valueStart >= 0 && !block.invalid) {
      block.descriptors[block.name] = cssText.slice(block.valueStart, end);
    }
    Object.assign(block, { name: null, valueStart: -1, bang: false, invalid: false });
  };

  const endFontFace = (end: number) => {
    const block = fontFace!;
    fontFace = null;
    endDeclaration(block, end);
    const rule = toRule(block.descriptors, baseUrl);
    if (!rule) return;
    rules.push(rule);
    if (rules.length >= maxRules) throw new Enough();
  };

  const readDeclaration = (block: FontFaceBlock, type: number, start: number, end: number) => {
    if (type === T.Semicolon) {
      endDeclaration(block, start);
    } else if (block.valueStart < 0) {
      if (type === T.Ident && block.name === null) block.name = decodeIdent(cssText.slice(start, end)).toLowerCase();
      else if (type === T.Colon && block.name !== null) block.valueStart = end;
      else if (!isBlank(type)) block.invalid = true;
    } else if (type === T.Delim && cssText[start] === "!") {
      block.bang = true;
    } else if (type === T.Ident && block.bang && decodeIdent(cssText.slice(start, end)).toLowerCase() === "important") {
      block.invalid = true;
    } else if (!isBlank(type)) {
      block.bang = false;
    }
  };

  const inRules = () => stack.top() < 0 || (stack.top() & HOLDS_RULES) !== 0;

  const onToken = (type: number, start: number, end: number) => {
    if (stack.length && type === (stack.top() & ~HOLDS_RULES)) {
      stack.pop();
      if (fontFace && stack.length < fontFace.depth) endFontFace(start);
      if (inRules()) {
        // Back in a list of rules: a closed block ends its rule
        statementStart = type === T.RightCurlyBracket;
        if (statementStart) atRule = null;
      }
      return;
    }
    const atRules = inRules();
    if (fontFace) {
      if (stack.length === fontFace.depth) readDeclaration(fontFace, type, start, end);
    } else if (atRules) {
      // A semicolon ends an at-rule without a block. In a qualified rule's prelude it is one more prelude token.
      if (type === T.Semicolon && atRule !== null) {
        statementStart = true;
        atRule = null;
      } else if (type === T.AtKeyword && statementStart) {
        atRule = decodeIdent(cssText.slice(start + 1, end)).toLowerCase();
        statementStart = false;
        prelude = false;
      } else if (!isBlank(type)) {
        // `<!--` and `-->` are skipped between statements, not in a prelude
        if (type !== T.CDO && type !== T.CDC) statementStart = false;
        if (type !== T.LeftCurlyBracket) prelude = true;
      }
    }
    const closer = CLOSERS[type];
    if (closer === undefined) return;
    const ruleBlock = type === T.LeftCurlyBracket && atRules && !fontFace;
    stack.push(ruleBlock && GROUP_RULES.has(atRule ?? "") ? closer | HOLDS_RULES : closer);
    if (ruleBlock && atRule === "font-face" && !prelude) {
      fontFace = { depth: stack.length, descriptors: {}, name: null, valueStart: -1, bang: false, invalid: false };
    }
    if (ruleBlock) {
      statementStart = true;
      atRule = null;
    }
  };

  try {
    tokenize(cssText, onToken);
    if (fontFace) endFontFace(cssText.length);
  } catch (error) {
    if (!(error instanceof Enough)) throw error;
  }
  return rules;
}

function toRule(descriptors: Record<string, string>, baseUrl: string): RawFontFaceRule | null {
  const value = descriptors["font-family"] ?? "";
  const face = {
    weight: descriptors["font-weight"],
    style: descriptors["font-style"],
    stretch: descriptors["font-stretch"],
    unicodeRange: descriptors["unicode-range"],
  };
  if (value.length > MAX_FAMILY_CHARS || !withinDescriptorLimits(face)) return null;
  // Tokenizing the family and the sources reads their comments as spaces
  const family = readFamilyName(value);
  const src = parseFontSrc(descriptors.src ?? "", baseUrl);
  if (!family || !src.length) return null;
  const rule: RawFontFaceRule = { family, src, weight: normalizeWeight(uncomment(face.weight)), style: normalizeStyle(uncomment(face.style)), baseUrl, origin: "network" };
  const stretch = collapse(uncomment(face.stretch));
  if (stretch) rule.stretch = stretch;
  const unicodeRange = collapse(uncomment(face.unicodeRange));
  if (unicodeRange) rule.unicodeRange = unicodeRange;
  return rule;
}
