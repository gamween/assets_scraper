import type { CssNode } from "css-tree";
// The parser, walker and generator entry points, not the package root: the root also builds the lexer, which loads
// mdn-data JSON through createRequire, something bundlers and serverless file tracing do not follow reliably.
import generate from "css-tree/generator";
import parse from "css-tree/parser";
import walk from "css-tree/walker";
import type { RawFontFaceRule } from "../types";

type FontSrc = RawFontFaceRule["src"][number];

const unescapeCss = (value: string) => value.replace(/\\(.)/g, "$1");

const textOf = (node: CssNode) => (node.type === "String" ? node.value : node.type === "Identifier" ? node.name : "");

/**
 * Parses an `@font-face` `src` value into `local()` names and absolute `url()`s with their optional format hint
 * (the first one of a legacy list). Uses the css-tree tokenizer: the value comes from scraped CSS, so no backtracking
 * regex. A value css-tree cannot parse gives no sources, as browsers drop it.
 */
export function parseFontSrc(src: string, baseUrl: string): FontSrc[] {
  let ast: CssNode;
  try {
    ast = parse(src, { context: "value", onParseError: () => {} });
  } catch {
    return [];
  }
  if (ast.type !== "Value") return [];
  const out: FontSrc[] = [];
  let current: FontSrc | null = null;
  for (const node of ast.children.toArray()) {
    if (node.type === "Operator" && node.value === ",") {
      current = null;
      continue;
    }
    if (current) {
      if (current.url && !current.format && node.type === "Function" && node.name.toLowerCase() === "format") {
        const [first] = node.children.toArray();
        const hint = first ? textOf(first).trim().toLowerCase() : "";
        if (hint) current.format = hint;
      }
      continue;
    }
    if (node.type === "Url" && node.value.trim()) {
      try {
        current = { url: new URL(node.value.trim(), baseUrl).href };
        out.push(current);
      } catch {
        // not a URL: skip this source
      }
    } else if (node.type === "Function" && node.name.toLowerCase() === "local") {
      const name = node.children.toArray().map(textOf).filter(Boolean).join(" ").trim();
      if (name) {
        current = { local: name };
        out.push(current);
      }
    }
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
  let ast: CssNode;
  try {
    ast = parse(cssText, {
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
  walk(ast, {
    visit: "Atrule",
    enter(node) {
      if (node.name.toLowerCase() !== "font-face" || !node.block) return;
      const descriptors: Record<string, string> = {};
      node.block.children.forEach((child) => {
        if (child.type !== "Declaration") return;
        descriptors[child.property.toLowerCase()] = child.value.type === "Raw" ? child.value.value : generate(child.value);
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
