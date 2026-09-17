import parse from "css-tree/parser";
import { describe, expect, it } from "vitest";
import { parseFontFaceCss, parseFontSrc } from "./css";
import { fastestMs, growthFactor, LINEAR_GROWTH_BOUND } from "./testing";

const MIB = 1024 * 1024;
const BASE = "https://s.example/css/a.css";

/** A stylesheet of `rules` minimal `@font-face` rules, about 50 bytes each. */
const sheetOf = (rules: number) => Array.from({ length: rules }, (_, index) => `@font-face{font-family:f${index};src:url(${index}.woff2)}`).join("");

describe("parseFontFaceCss", () => {
  it("extracts faces with resolved URLs, formats, weights and ranges", () => {
    const css = `@font-face{font-family:"__Inter_d65c78";src:url(__inter.woff2) format("woff2");font-weight:100 900;unicode-range:U+0000-00FF}
      @media (min-width:1px){@font-face{font-family:'Brand Serif';src:local("Brand"),url("ss3.woff2") format('woff2');font-style:italic}}
      .broken{color:`;
    expect(parseFontFaceCss(css, "https://site.example/assets/style.css")).toEqual([
      { family: "__Inter_d65c78", src: [{ url: "https://site.example/assets/__inter.woff2", format: "woff2" }], weight: "100 900", style: "normal", unicodeRange: "U+0000-00FF", baseUrl: "https://site.example/assets/style.css", origin: "network" },
      { family: "Brand Serif", src: [{ local: "Brand" }, { url: "https://site.example/assets/ss3.woff2", format: "woff2" }], weight: "400", style: "italic", baseUrl: "https://site.example/assets/style.css", origin: "network" },
    ]);
  });

  it("reads unquoted families, keyword weights, stretch and nested at-rules", () => {
    const css = `@supports (display:grid){@layer base{@font-face{font-family:  Mona   Sans ;src:url(/f/mona.woff2)format(woff2-variations),url(/f/mona.woff);font-weight:bold;font-stretch:75% 125%;font-style:oblique 10deg}}}`;
    expect(parseFontFaceCss(css, "https://site.example/assets/style.css")).toEqual([
      {
        family: "Mona Sans",
        src: [{ url: "https://site.example/f/mona.woff2", format: "woff2-variations" }, { url: "https://site.example/f/mona.woff" }],
        weight: "700",
        style: "oblique 10deg",
        stretch: "75% 125%",
        baseUrl: "https://site.example/assets/style.css",
        origin: "network",
      },
    ]);
  });

  it("reads rules only where browsers do: at the start of a statement without a prelude, at the top level or in group rules", () => {
    const face = (family: string) => `@font-face{font-family:${family};src:url(${family}.woff2)}`;
    const css = [
      `@charset "utf-8";@import url(x.css);<!-- ${face("top")} -->`,
      `@container card (min-width:1px){@layer{.a[title="}"]{content:"{"}${face("container")}}}`,
      `@FONT-FACE{font-family:upper;src:url(upper.woff2)}@font-face;@font\\-face /* a comment */ {font-family:escaped;src:url(e.woff2)}`,
      `@font-face junk{font-family:prelude;src:url(p.woff2)}@font-face (x){font-family:parens;src:url(p.woff2)}@font-face <!--{font-family:cdo;src:url(c.woff2)}`,
      `.style{${face("nested")}}.value{--x:${face("custom")};color:red}@keyframes k{from{opacity:0}}a ${face("selector")}`,
      `@media screen{.a{b:c}${face("media")}}/* ${face("comment")} */`,
    ].join("\n");
    expect(parseFontFaceCss(css, BASE).map((rule) => rule.family)).toEqual(["top", "container", "upper", "escaped", "media"]);
  });

  it("reads a family as one string or identifiers and other names with CSS escapes decoded, and drops other families", () => {
    const families = (values: string[]) => values.flatMap((value) => parseFontFaceCss(`@font-face{font-family:${value};src:url(a.woff2)}`, BASE)).map((rule) => rule.family);
    // Microsoft YaHei written with escapes, as Chinese sites do, quoted and not
    expect(families([`"\\5FAE\\8F6F\\96C5\\9ED1"`, `\\5FAE\\8F6F\\96C5\\9ED1`])).toEqual(["\u5fae\u8f6f\u96c5\u9ed1", "\u5fae\u8f6f\u96c5\u9ed1"]);
    expect(families([`'Brand \\'Serif\\''`, `Brand\\ Sans  Text`, `\\31 23 Grotesk`, `" Spaced  Out "`])).toEqual(["Brand 'Serif'", "Brand Sans Text", "123 Grotesk", " Spaced  Out "]);
    expect(families([`"Brand" Sans`, `Brand "Sans"`, `"a" "b"`, `3M Sans`, `Brand, Sans`, `"broken\nstring"`, `""`])).toEqual([]);
    expect(parseFontFaceCss(`@f\\6f nt-face{font\\-family:Escaped;s\\72 c:url(a.woff2);font-weight:bold !IMPOR\\54 ANT}`, BASE)).toMatchObject([{ family: "Escaped", weight: "700" }]);
  });

  it("reads comments as spaces, drops !important and keeps the last of repeated descriptors", () => {
    const css = `@font-face{font-family:Brand/* x */Sans !important;src:url(a.woff2)/**/format("woff2"),url(b.woff);font-weight:300;font-weight:bold ! IMPORTANT;unicode-range:U+0-FF/* latin */}`;
    expect(parseFontFaceCss(css, BASE)).toEqual([
      { family: "Brand Sans", src: [{ url: "https://s.example/css/a.woff2", format: "woff2" }, { url: "https://s.example/css/b.woff" }], weight: "700", style: "normal", unicodeRange: "U+0-FF", baseUrl: BASE, origin: "network" },
    ]);
  });

  it("stops after maxRules rules", () => {
    expect(parseFontFaceCss(sheetOf(10), BASE, { maxRules: 3 }).map((rule) => rule.family)).toEqual(["f0", "f1", "f2"]);
    expect(parseFontFaceCss(sheetOf(10), BASE, { maxRules: 0 })).toEqual([]);
  });

  it("stays linear on large stylesheets, even after css-tree parsed a larger one", async () => {
    // css-tree's parser keeps buffers sized for the largest source it parsed and clears them on every parse, so
    // parsing each rule with it made every later stylesheet cost time in proportion to that largest source
    const sheet = sheetOf(10_000);
    const before = await fastestMs(() => parseFontFaceCss(sheet, BASE));
    parse(`/*${" ".repeat(8 * MIB)}*/`);
    const after = await fastestMs(() => parseFontFaceCss(sheet, BASE));
    expect(after).toBeLessThan(before * 3 + 10);

    expect(parseFontFaceCss(sheetOf(50_000), BASE)).toHaveLength(50_000);
    expect(await growthFactor((rules) => parseFontFaceCss(sheetOf(rules), BASE), 6_250)).toBeLessThan(LINEAR_GROWTH_BOUND);
  }, 60_000);

  it("skips rules without a family or a usable source and never throws on junk", () => {
    expect(parseFontFaceCss("@font-face{src:url(a.woff2)} @font-face{font-family:X}", "https://s.example/")).toEqual([]);
    expect(parseFontFaceCss("}}}{{{@font-face{", "https://s.example/")).toEqual([]);
    expect(parseFontFaceCss("", "https://s.example/")).toEqual([]);
  });
});

describe("parseFontSrc", () => {
  it("parses url, local, format, tech and data URIs", () => {
    const data = "data:font/woff2;base64,d09GMgABAAAA";
    expect(parseFontSrc(`local('Inter Regular'), url("${data}") format("woff2"), url(x.ttf?v=1#iefix) format("truetype") tech(variations), url('x.eot')`, "https://s.example/css/a.css")).toEqual([
      { local: "Inter Regular" },
      { url: data, format: "woff2" },
      { url: "https://s.example/css/x.ttf?v=1#iefix", format: "truetype" },
      { url: "https://s.example/css/x.eot" },
    ]);
  });

  it("reads escaped and unquoted URLs and gives nothing for a value it cannot parse", () => {
    expect(parseFontSrc(`url(a\\).woff2) format(woff2), local(Inter   Regular)`, "https://s.example/")).toEqual([
      { url: "https://s.example/a).woff2", format: "woff2" },
      { local: "Inter Regular" },
    ]);
    expect(parseFontSrc("url(url(url(", "https://s.example/")).toEqual([]);
    expect(parseFontSrc("url(   ", "https://s.example/")).toEqual([]);
    expect(parseFontSrc(`url("a" b), local(), format(woff2), tech(x) url(), "c.woff2"`, "https://s.example/")).toEqual([]);
  });

  it("takes the first valid source of each entry and skips stray tokens", () => {
    expect(parseFontSrc(`format(woff2) url("http://[bad") url(a.woff2) url(b.woff2) format(woff2) format(woff), local() local(Inter) format(woff2)`, "https://s.example/")).toEqual([
      { url: "https://s.example/a.woff2", format: "woff2" },
      { local: "Inter" },
    ]);
    expect(parseFontSrc(`] url(a.woff2)) format("woff2"`, "https://s.example/")).toEqual([{ url: "https://s.example/a.woff2", format: "woff2" }]);
  });

  it("stays linear on hostile values", async () => {
    const hostile = (size: number) => ["url(" + " ".repeat(size), "url(".repeat(size / 4), `url("${"a".repeat(size)}`, "local(".repeat(size / 6), "(".repeat(size), `url(a.woff2)${" format(".repeat(size / 8)}`, "\\31 a".repeat(size / 4), `"${"\\".repeat(size)}`];
    const factor = await growthFactor((size) => {
      for (const value of hostile(size)) {
        parseFontSrc(value, BASE);
        parseFontFaceCss(`@font-face{font-family:X;src:${value}}`, BASE);
        parseFontFaceCss(`@font-face{font-family:${value};src:url(a.woff2)}`, BASE);
        parseFontFaceCss(`@media x{${value}{@font-face{font-family:X;src:url(a.woff2)`, BASE);
      }
    }, 20_000);
    expect(factor).toBeLessThan(LINEAR_GROWTH_BOUND);
  });

  it("keeps the first format of a legacy list and drops unresolvable URLs", () => {
    expect(parseFontSrc(`url(a.woff) format("woff", "truetype"), url("http://[bad")`, "https://s.example/")).toEqual([
      { url: "https://s.example/a.woff", format: "woff" },
    ]);
  });
});
