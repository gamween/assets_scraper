import * as csstree from "css-tree";
import type { RawFontFaceRule } from "../types";

type FontSrc = RawFontFaceRule["src"][number];

const SRC_ITEM =
  /\b(url|local)\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)]*?))\s*\)(?:\s*format\(\s*["']?([^"',)\s]+)["']?[^)]*\))?(?:\s*tech\([^)]*\))?/gi;

const unescapeCss = (value: string) => value.replace(/\\(.)/g, "$1");

/** Parses an `@font-face` `src` value into `local()` names and absolute `url()`s with their optional format hint. */
export function parseFontSrc(src: string, baseUrl: string): FontSrc[] {
  const out: FontSrc[] = [];
  for (const match of src.matchAll(SRC_ITEM)) {
    const value = unescapeCss((match[2] ?? match[3] ?? match[4] ?? "").trim());
    if (!value) continue;
    if (match[1].toLowerCase() === "local") {
      out.push({ local: value });
      continue;
    }
    let url: string;
    try {
      url = new URL(value, baseUrl).href;
    } catch {
      continue;
    }
    out.push(match[5] ? { url, format: match[5].toLowerCase() } : { url });
  }
  return out;
}

const collapse = (value: string) => value.trim().replace(/\s+/g, " ");

/** `"__Inter_d65c78"`, `'Brand Serif'` or `Mona   Sans` to the family name. */
export function unquoteFamily(value: string): string {
  const trimmed = value.trim();
  const quote = trimmed[0];
  if ((quote === '"' || quote === "'") && trimmed.length >= 2 && trimmed.endsWith(quote)) return unescapeCss(trimmed.slice(1, -1)).trim();
  return collapse(unescapeCss(trimmed));
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

/**
 * Collects `@font-face` rules from stylesheet text, including rules nested in `@media`, `@supports` and `@layer`.
 * Relative URLs resolve against `baseUrl` (the stylesheet URL). Broken CSS never throws: unparseable parts are skipped.
 */
export function parseFontFaceCss(cssText: string, baseUrl: string): RawFontFaceRule[] {
  if (!/@font-face/i.test(cssText)) return [];
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
    return [];
  }
  const rules: RawFontFaceRule[] = [];
  csstree.walk(ast, {
    visit: "Atrule",
    enter(node) {
      if (node.name.toLowerCase() !== "font-face" || !node.block) return;
      const descriptors: Record<string, string> = {};
      node.block.children.forEach((child) => {
        if (child.type !== "Declaration") return;
        descriptors[child.property.toLowerCase()] = child.value.type === "Raw" ? child.value.value : csstree.generate(child.value);
      });
      const family = unquoteFamily(descriptors["font-family"] ?? "");
      const src = parseFontSrc(descriptors.src ?? "", baseUrl);
      if (!family || !src.length) return;
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
      rules.push(rule);
    },
  });
  return rules;
}
