import type { RawFontFaceRule } from "../types";
import { readCssToken } from "./css-tokens";

/**
 * The URLs in CSS values, read the same way in the page and in Node: the collector bundles this module for computed
 * styles, lazy attributes, CSSOM rules and inline `<style>` text, and post-processing imports it for the stylesheets
 * the page could not read. Both used to carry their own copy of two regular expressions, which drifted apart and were
 * quadratic on page CSS. Each reader here walks the value once with `readCssToken`, starting each token where the
 * previous one ended.
 */

/** Functions whose bare strings are images (`image-set("a.png" 1x)`). */
const IMAGE_SET = new Set(["image-set", "-webkit-image-set"]);

interface OpenFunction {
  /** Lowercase name, or "" for a bare parenthesis. */
  name: string;
  /** The string a quoted `url()` holds, once read. */
  string?: string;
  /** Whether it holds anything but that one string and whitespace, which makes a quoted `url()` invalid. */
  other: boolean;
}

/**
 * Every URL a CSS value names, in order and unescaped: the argument of each `url()`, and each string `image-set()` or
 * `-webkit-image-set()` takes as an image. Fragment references (`url(#clip)`) are kept, for the SVG code that follows
 * them. A `url()` a browser would reject (`url(a b)`, `url(url(a))`, `url("a" b)`) names nothing, and neither do
 * `url(` inside a string or a comment or the strings of other functions (`type("image/avif")`).
 */
export function readCssUrls(value: string): string[] {
  const out: string[] = [];
  const open: OpenFunction[] = [];
  for (let at = 0; at < value.length; ) {
    const token = readCssToken(value, at);
    at = token.end;
    const inner = open[open.length - 1];
    switch (token.type) {
      case "space":
      case "comment":
        break;
      case "url":
        out.push(token.value);
        break;
      case "function":
        if (inner) inner.other = true;
        open.push({ name: token.value, other: false });
        break;
      case "(":
        if (inner) inner.other = true;
        open.push({ name: "", other: false });
        break;
      case ")": {
        const closed = open.pop();
        if (closed?.name === "url" && closed.string !== undefined && !closed.other) out.push(closed.string);
        break;
      }
      case "string":
        if (inner?.name === "url") {
          if (inner.string === undefined) inner.string = token.value;
          else inner.other = true;
        } else if (inner && IMAGE_SET.has(inner.name)) {
          out.push(token.value);
        }
        break;
      default:
        if (inner) inner.other = true;
    }
  }
  return out;
}

/** Image URLs in a CSS value (see `readCssUrls`), each once, without fragment-only references. */
export function extractCssUrls(value: string | null | undefined): string[] {
  if (!value || value === "none") return [];
  return [...new Set(readCssUrls(value))].filter((url) => url && !url.startsWith("#"));
}

/** A `url()`, `local()`, `format()` or `tech()` of a `src` descriptor, while it is open. */
interface SrcFunction {
  name: string;
  /** Its strings and words, decoded, in order. */
  parts: string[];
  /** Whether it holds anything else: a nested function or parenthesis, a comma, a bad string. */
  other: boolean;
}

/**
 * The sources of an `@font-face` `src` descriptor as the CSSOM serializes it: each `url()` with the `format()` hint
 * that follows it, and each `local()` name. URLs are resolved against `base`; one that does not resolve is skipped.
 * Node reads captured stylesheets with its own parser (`fonts/css.ts`), which also applies the per-entry rules of the
 * spec. This one reads values Chrome has already parsed and serialized.
 */
export function readFontFaceSrc(src: string, base: string): RawFontFaceRule["src"] {
  const out: RawFontFaceRule["src"] = [];
  /** Adds the source of a `url()`, and returns it for the `format()` that may follow. */
  const addUrl = (value: string) => {
    let source: RawFontFaceRule["src"][number];
    try {
      source = { url: new URL(value.trim(), base).href };
    } catch {
      return null; // not a URL
    }
    out.push(source);
    return source;
  };
  // The last `url()` source, while a `format()` can still follow it
  let last: RawFontFaceRule["src"][number] | null = null;
  let depth = 0;
  let current: SrcFunction | null = null;
  for (let at = 0; at < src.length; ) {
    const token = readCssToken(src, at);
    at = token.end;
    if (depth === 0) {
      if (token.type === "space" || token.type === "comment") continue;
      if (token.type === "url") {
        last = addUrl(token.value);
      } else if (token.type === "function" || token.type === "(") {
        depth = 1;
        current = token.type === "function" ? { name: token.value, parts: [], other: false } : null;
        if (current?.name !== "format") last = null;
      } else {
        last = null;
      }
      continue;
    }
    if (token.type === "function" || token.type === "(") {
      depth += 1;
      if (current) current.other = true;
    } else if (token.type === ")") {
      depth -= 1;
      if (depth > 0 || !current) continue;
      const { name, parts, other } = current;
      current = null;
      if (name === "url" && parts.length === 1 && !other) {
        last = addUrl(parts[0]);
      } else if (name === "local") {
        const local = parts.join(" ").trim();
        if (local && !other) out.push({ local });
        last = null;
      } else if (name === "format") {
        const format = parts.length === 1 && !other ? parts[0].trim().toLowerCase() : "";
        if (last && format) last.format = format;
        last = null;
      } else {
        last = null;
      }
    } else if (current && depth === 1) {
      if (token.type === "string" || token.type === "word") current.parts.push(token.value);
      else if (token.type !== "space" && token.type !== "comment") current.other = true;
    }
  }
  return out;
}
