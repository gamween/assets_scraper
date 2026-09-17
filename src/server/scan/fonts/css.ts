import { tokenize, tokenTypes as T } from "css-tree/tokenizer";
import { ident, string, url as cssUrl } from "css-tree/utils";
import type { RawFontFaceRule } from "../types";

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

/** A stack of numbers below 256, one byte each: CSS can nest as deep as it is long. */
class ByteStack {
  private bytes = new Uint8Array(64);
  length = 0;

  push(value: number) {
    if (this.length === this.bytes.length) {
      const grown = new Uint8Array(this.length * 2);
      grown.set(this.bytes);
      this.bytes = grown;
    }
    this.bytes[this.length++] = value;
  }

  pop() {
    this.length -= 1;
  }

  /** The value on top, or -1 when the stack is empty. */
  top(): number {
    return this.length ? this.bytes[this.length - 1] : -1;
  }
}

function absoluteUrl(value: string, baseUrl: string): FontSrc | null {
  if (!value) return null;
  try {
    return { url: new URL(value, baseUrl).href };
  } catch {
    return null;
  }
}

/** A `url(`, `local(` or `format(` function of a `src` entry, read at its own nesting level. */
interface SrcFunction {
  kind: "url" | "local" | "format";
  texts: string[];
  /** Tokens other than strings and identifiers, which make a quoted `url()` invalid. */
  other: boolean;
}

/**
 * Parses an `@font-face` `src` value into `local()` names and absolute `url()`s with their optional format hint
 * (the first one of a legacy list), from css-tree tokens: the value comes from scraped CSS, so no backtracking regex.
 * Lenient like the discovery lab: in each comma-separated entry, the first valid `url()` or non-empty `local()` is the
 * source, whatever comes before it, and the first `format()` after a `url()` is its hint. Unbalanced closing tokens
 * are skipped and functions left open at the end of the value are closed.
 */
export function parseFontSrc(src: string, baseUrl: string): FontSrc[] {
  const out: FontSrc[] = [];
  const closers = new ByteStack();
  // The source of the current comma-separated entry, once found
  let current: FontSrc | null = null;
  let fn: SrcFunction | null = null;

  const addSource = (source: FontSrc | null) => {
    if (source) out.push((current = source));
  };

  const endFunction = () => {
    const { kind, texts, other } = fn!;
    fn = null;
    if (kind === "format") {
      const hint = texts[0]?.trim().toLowerCase();
      if (hint && current) current.format = hint;
    } else if (kind === "local") {
      const name = texts.join(" ").trim();
      addSource(name ? { local: name } : null);
    } else {
      addSource(texts.length === 1 && !other ? absoluteUrl(texts[0].trim(), baseUrl) : null);
    }
  };

  tokenize(src, (type, start, end) => {
    if (type === closers.top()) {
      closers.pop();
      if (!closers.length && fn) endFunction();
      return;
    }
    if (closers.length === 1 && fn && !isBlank(type)) {
      const text = type === T.String ? string.decode(src.slice(start, end)) : type === T.Ident ? ident.decode(src.slice(start, end)) : null;
      // format() keeps its first argument, when it is a string or an identifier
      if (fn.kind === "format") {
        if (!fn.texts.length) fn.texts.push(text ?? "");
      } else if (text === null) {
        fn.other = true;
      } else {
        fn.texts.push(text);
      }
    } else if (!closers.length) {
      if (type === T.Comma) {
        current = null;
      } else if (!current && type === T.Url) {
        addSource(absoluteUrl(cssUrl.decode(src.slice(start, end)).trim(), baseUrl));
      } else if (type === T.Function) {
        const name = ident.decode(src.slice(start, end - 1)).toLowerCase();
        if (!current && (name === "url" || name === "local")) fn = { kind: name, texts: [], other: false };
        else if (current?.url && !current.format && name === "format") fn = { kind: "format", texts: [], other: false };
      }
    }
    const closer = CLOSERS[type];
    if (closer !== undefined) closers.push(closer);
  });
  if (fn) endFunction();
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
      names.push(string.decode(value.slice(start, end)));
      quoted = true;
    } else if (type === T.Ident && !quoted) {
      names.push(ident.decode(value.slice(start, end)));
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

/** The descriptors of an open `@font-face` block, and the declaration being read in it. */
interface FontFaceBlock {
  /** Stack depth of the block's own declarations. */
  depth: number;
  descriptors: Record<string, string>;
  /** Lowercase name of the declaration, once read. */
  name: string | null;
  /** Where the rest of the value starts after its colon, or -1 before the colon. */
  valueStart: number;
  /** The value text before each comment, each comment read as a space. */
  parts: string[];
  /** Where a trailing `!important` starts, or -1. */
  important: number;
  bang: number;
  invalid: boolean;
}

class EnoughRules extends Error {}

/**
 * Collects `@font-face` rules from stylesheet text, at the top level and in `@media`, `@supports`, `@layer` and the
 * other conditional group rules, in one pass over css-tree tokens. As in browsers, a rule starts a statement and has
 * no prelude: an `@font-face` inside a declaration value or a style rule, or followed by anything but whitespace and
 * comments before its block, is not a rule. Names are read with their CSS escapes decoded. Relative URLs resolve
 * against `baseUrl` (the stylesheet URL). Stops after `maxRules` rules. Broken CSS never throws: invalid declarations
 * are skipped and blocks left open at the end are closed. In a descriptor value a comment reads as a space and
 * `!important` is dropped.
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
    if (block.name && block.valueStart >= 0 && !block.invalid) {
      const valueEnd = block.important >= block.valueStart ? block.important : end;
      block.descriptors[block.name] = block.parts.join("") + cssText.slice(block.valueStart, valueEnd);
    }
    Object.assign(block, { name: null, valueStart: -1, parts: [], important: -1, bang: -1, invalid: false });
  };

  const endFontFace = (end: number) => {
    const block = fontFace!;
    fontFace = null;
    endDeclaration(block, end);
    const rule = toRule(block.descriptors, baseUrl);
    if (!rule) return;
    rules.push(rule);
    if (rules.length >= maxRules) throw new EnoughRules();
  };

  const readDeclaration = (block: FontFaceBlock, type: number, start: number, end: number) => {
    if (type === T.Semicolon) {
      endDeclaration(block, start);
    } else if (block.valueStart < 0) {
      if (type === T.Ident && block.name === null) block.name = ident.decode(cssText.slice(start, end)).toLowerCase();
      else if (type === T.Colon && block.name !== null) block.valueStart = end;
      else if (type !== T.WhiteSpace) block.invalid = true;
    } else if (type === T.Delim && cssText[start] === "!") {
      block.bang = start;
      block.important = -1;
    } else if (type === T.Ident && block.bang >= 0 && ident.decode(cssText.slice(start, end)).toLowerCase() === "important") {
      block.important = block.bang;
      block.bang = -1;
    } else if (type !== T.WhiteSpace) {
      block.bang = -1;
      block.important = -1;
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
      if (type === T.Comment) {
        if (fontFace.valueStart >= 0) {
          const { parts, valueStart } = fontFace;
          if (start > valueStart) parts.push(cssText.slice(valueStart, start), " ");
          else if (parts[parts.length - 1] !== " ") parts.push(" ");
          fontFace.valueStart = end;
        }
      } else if (stack.length === fontFace.depth) {
        readDeclaration(fontFace, type, start, end);
      }
    } else if (atRules) {
      if (type === T.Semicolon) {
        statementStart = true;
        atRule = null;
      } else if (type === T.AtKeyword && statementStart) {
        atRule = ident.decode(cssText.slice(start + 1, end)).toLowerCase();
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
      fontFace = { depth: stack.length, descriptors: {}, name: null, valueStart: -1, parts: [], important: -1, bang: -1, invalid: false };
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
    if (!(error instanceof EnoughRules)) throw error;
  }
  return rules;
}

function toRule(descriptors: Record<string, string>, baseUrl: string): RawFontFaceRule | null {
  const family = readFamilyName(descriptors["font-family"] ?? "");
  const src = parseFontSrc(descriptors.src ?? "", baseUrl);
  if (!family || !src.length) return null;
  const rule: RawFontFaceRule = {
    family,
    src,
    weight: normalizeWeight(descriptors["font-weight"]),
    style: normalizeStyle(descriptors["font-style"]),
    baseUrl,
    origin: "network",
  };
  const stretch = collapse(descriptors["font-stretch"] ?? "");
  if (stretch) rule.stretch = stretch;
  const unicodeRange = collapse(descriptors["unicode-range"] ?? "");
  if (unicodeRange) rule.unicodeRange = unicodeRange;
  return rule;
}
