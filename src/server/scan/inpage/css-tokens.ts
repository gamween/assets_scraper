/**
 * A forward-only CSS tokenizer for what the scan reads out of CSS values: `url()`, strings and function arguments.
 * Strings, `url()` and escapes follow CSS Syntax Level 3 (section 4.3), the way a browser reads them; everything else is
 * a run of other characters, which is all a caller needs to skip it.
 *
 * One copy for both sides, like `lists.ts`: the in-page collector bundles it and post-processing imports it. It exists
 * because the regular expressions it replaced were quadratic on page CSS: an unterminated `url(url(url(` or a long run
 * of spaces after `url(` made each start position scan to the end of the value, and a 1 MB stylesheet blocked the
 * event loop for minutes. `readCssToken` reads one token from where the caller stands and never looks back, so a scan
 * that starts each token where the previous one ended reads every character once. It is exported on its own, apart
 * from the readers built on it, so the op-count tests can count the characters each token steps over.
 */

export interface CssToken {
  type: "space" | "comment" | "string" | "bad-string" | "url" | "bad-url" | "function" | "(" | ")" | "," | "word";
  /** Where the token ends, which is where the next one starts. */
  end: number;
  /** The decoded string, the decoded URL of an unquoted `url()`, a function's name in lowercase, a word. Else empty. */
  value: string;
}

const BACKSLASH = 0x5c;

const isNewline = (code: number) => code === 0x0a || code === 0x0c || code === 0x0d;
const isSpace = (code: number) => code === 0x20 || code === 0x09 || isNewline(code);
const isHex = (code: number) => (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x46) || (code >= 0x61 && code <= 0x66);
/** Characters an unquoted `url()` may not hold (section 4.3.6): they make it a bad URL. */
const breaksUrl = (code: number) =>
  code === 0x22 || code === 0x27 || code === 0x28 || code <= 0x08 || code === 0x0b || (code >= 0x0e && code <= 0x1f) || code === 0x7f;
/** Characters that end a word: whitespace, quotes, parentheses and commas. A comment start is checked apart. */
const endsWord = (code: number) => isSpace(code) || code === 0x22 || code === 0x27 || code === 0x28 || code === 0x29 || code === 0x2c;

/** Whether `text[at]` starts a valid escape: a backslash followed by anything but a newline or the end. */
const isEscape = (text: string, at: number) => text.charCodeAt(at) === BACKSLASH && at + 1 < text.length && !isNewline(text.charCodeAt(at + 1));

/** The escape starting at `at`, a valid one, decoded: 1 to 6 hex digits and one optional whitespace, or one code point. */
function readEscape(text: string, at: number): { char: string; end: number } {
  let end = at + 1;
  if (isHex(text.charCodeAt(end))) {
    const digits = end;
    while (end < text.length && end - digits < 6 && isHex(text.charCodeAt(end))) end += 1;
    const code = parseInt(text.slice(digits, end), 16);
    if (end < text.length && isSpace(text.charCodeAt(end))) end += text.charCodeAt(end) === 0x0d && text.charCodeAt(end + 1) === 0x0a ? 2 : 1;
    const valid = code !== 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
    return { char: valid ? String.fromCodePoint(code) : "�", end };
  }
  const code = text.codePointAt(end)!;
  return { char: String.fromCodePoint(code), end: end + (code > 0xffff ? 2 : 1) };
}

/** A quoted string from its opening quote at `start`. A newline ends it as a bad string; the end of the text closes it. */
function readString(text: string, start: number): CssToken {
  const quote = text.charCodeAt(start);
  const parts: string[] = [];
  let from = start + 1;
  let at = from;
  while (at < text.length) {
    const code = text.charCodeAt(at);
    if (code === quote) {
      parts.push(text.slice(from, at));
      return { type: "string", end: at + 1, value: parts.join("") };
    }
    if (isNewline(code)) return { type: "bad-string", end: at, value: "" };
    if (code === BACKSLASH) {
      parts.push(text.slice(from, at));
      if (at + 1 >= text.length) {
        at += 1;
      } else if (isNewline(text.charCodeAt(at + 1))) {
        // An escaped newline continues the string on the next line and adds nothing to it
        at += text.charCodeAt(at + 1) === 0x0d && text.charCodeAt(at + 2) === 0x0a ? 3 : 2;
      } else {
        const escape = readEscape(text, at);
        parts.push(escape.char);
        at = escape.end;
      }
      from = at;
      continue;
    }
    at += 1;
  }
  parts.push(text.slice(from, at));
  return { type: "string", end: text.length, value: parts.join("") };
}

/** What is left of a bad `url()`, up to and with its `)`: escapes are skipped, so an escaped `)` does not end it. */
function readBadUrl(text: string, at: number): CssToken {
  while (at < text.length) {
    if (text.charCodeAt(at) === 0x29) return { type: "bad-url", end: at + 1, value: "" };
    at = isEscape(text, at) ? readEscape(text, at).end : at + 1;
  }
  return { type: "bad-url", end: text.length, value: "" };
}

/** An unquoted `url()` from the first character after `url(` and its whitespace (section 4.3.6). */
function readUrl(text: string, start: number): CssToken {
  const parts: string[] = [];
  let from = start;
  let at = start;
  while (at < text.length) {
    const code = text.charCodeAt(at);
    if (code === 0x29) {
      parts.push(text.slice(from, at));
      return { type: "url", end: at + 1, value: parts.join("") };
    }
    if (isSpace(code)) {
      parts.push(text.slice(from, at));
      while (at < text.length && isSpace(text.charCodeAt(at))) at += 1;
      if (at >= text.length) return { type: "url", end: at, value: parts.join("") };
      if (text.charCodeAt(at) === 0x29) return { type: "url", end: at + 1, value: parts.join("") };
      return readBadUrl(text, at);
    }
    if (breaksUrl(code)) return readBadUrl(text, at);
    if (code === BACKSLASH) {
      if (!isEscape(text, at)) return readBadUrl(text, at);
      parts.push(text.slice(from, at));
      const escape = readEscape(text, at);
      parts.push(escape.char);
      at = from = escape.end;
      continue;
    }
    at += 1;
  }
  // Left open at the end of the text: still a URL, as browsers read it
  parts.push(text.slice(from, at));
  return { type: "url", end: at, value: parts.join("") };
}

/**
 * The token of `text` that starts at `start`, which must be inside the text. Whitespace, comments, strings, `url()`,
 * function names with their `(`, single `(`, `)` and `,`, and words: runs of any other characters, escapes decoded.
 * A word directly followed by `(` is a function. A `url(` whose argument is not quoted is read whole as a URL token;
 * with a quoted argument it is a function like any other, and its string is the next token but one.
 */
export function readCssToken(text: string, start: number): CssToken {
  const code = text.charCodeAt(start);
  if (isSpace(code)) {
    let end = start + 1;
    while (end < text.length && isSpace(text.charCodeAt(end))) end += 1;
    return { type: "space", end, value: "" };
  }
  if (code === 0x2f && text.charCodeAt(start + 1) === 0x2a) {
    const close = text.indexOf("*/", start + 2);
    return { type: "comment", end: close < 0 ? text.length : close + 2, value: "" };
  }
  if (code === 0x22 || code === 0x27) return readString(text, start);
  if (code === 0x28) return { type: "(", end: start + 1, value: "" };
  if (code === 0x29) return { type: ")", end: start + 1, value: "" };
  if (code === 0x2c) return { type: ",", end: start + 1, value: "" };

  const parts: string[] = [];
  let from = start;
  let at = start;
  while (at < text.length) {
    const next = text.charCodeAt(at);
    if (endsWord(next) || (next === 0x2f && text.charCodeAt(at + 1) === 0x2a)) break;
    if (isEscape(text, at)) {
      parts.push(text.slice(from, at));
      const escape = readEscape(text, at);
      parts.push(escape.char);
      at = from = escape.end;
      continue;
    }
    at += 1;
  }
  parts.push(text.slice(from, at));
  const value = parts.join("");
  if (text.charCodeAt(at) !== 0x28) return { type: "word", end: at, value };
  const name = value.toLowerCase();
  if (name === "url") {
    let argument = at + 1;
    while (argument < text.length && isSpace(text.charCodeAt(argument))) argument += 1;
    const first = text.charCodeAt(argument);
    if (first !== 0x22 && first !== 0x27) return readUrl(text, argument);
  }
  return { type: "function", end: at + 1, value: name };
}
