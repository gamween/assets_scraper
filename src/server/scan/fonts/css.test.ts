import parse from "css-tree/parser";
import { tokenize } from "css-tree/tokenizer";
import { ident } from "css-tree/utils";
import { describe, expect, it, vi } from "vitest";
import { decodeIdent, MAX_DESCRIPTOR_CHARS, MAX_FAMILY_CHARS, MAX_SRC_ENTRIES, MAX_UNICODE_RANGE_CHARS, parseFontFaceCss, parseFontSrc } from "./css";
import { MAX_URL_CHARS } from "./files";
import { fastestMs, growthFactor, LINEAR_GROWTH_BOUND, random } from "./testing";

// Counts the tokens the fonts code reads and the CSS escapes it decodes, to show where it stops reading
const tokenizer = vi.hoisted(() => ({ tokens: 0 }));
const decoder = vi.hoisted(() => ({ calls: 0 }));
vi.mock("css-tree/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("css-tree/utils")>();
  const decode: typeof actual.ident.decode = (text) => {
    decoder.calls += 1;
    return actual.ident.decode(text);
  };
  return { ...actual, ident: { ...actual.ident, decode } };
});
vi.mock("css-tree/tokenizer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("css-tree/tokenizer")>();
  const tokenize: typeof actual.tokenize = (source, onToken) =>
    actual.tokenize(source, (type, start, end) => {
      tokenizer.tokens += 1;
      onToken?.(type, start, end);
    });
  return { ...actual, tokenize };
});

const MIB = 1024 * 1024;
const DIR = "https://s.example/css/";
const BASE = `${DIR}a.css`;

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
      // a semicolon ends an at-rule, but belongs to the prelude of a qualified rule, which runs up to its block
      `.a; ${face("semi")} a{} ; ${face("afterSemi")} @media screen{.a; ${face("mediaSemi")}};${face("leading")}`,
      `@charset "x"; ${face("afterAtRule")} .b;c{} ${face("afterRule")}`,
    ].join("\n");
    expect(parseFontFaceCss(css, BASE).map((rule) => rule.family)).toEqual(["top", "container", "upper", "escaped", "media", "afterAtRule", "afterRule"]);
  });

  it("reads a family as one string or identifiers and other names with CSS escapes decoded, and drops other families", () => {
    const families = (values: string[]) => values.flatMap((value) => parseFontFaceCss(`@font-face{font-family:${value};src:url(a.woff2)}`, BASE)).map((rule) => rule.family);
    // Microsoft YaHei written with escapes, as Chinese sites do, quoted and not
    expect(families([`"\\5FAE\\8F6F\\96C5\\9ED1"`, `\\5FAE\\8F6F\\96C5\\9ED1`])).toEqual(["\u5fae\u8f6f\u96c5\u9ed1", "\u5fae\u8f6f\u96c5\u9ed1"]);
    expect(families([`'Brand \\'Serif\\''`, `Brand\\ Sans  Text`, `\\31 23 Grotesk`, `" Spaced  Out "`])).toEqual(["Brand 'Serif'", "Brand Sans Text", "123 Grotesk", " Spaced  Out "]);
    expect(families([`"Brand" Sans`, `Brand "Sans"`, `"a" "b"`, `3M Sans`, `Brand, Sans`, `"broken\nstring"`, `""`])).toEqual([]);
    expect(parseFontFaceCss(`@f\\6f nt-face{font\\-family:Escaped;s\\72 c:url(a.woff2);font-weight:bold !IMPOR\\54 ANT}`, BASE)).toMatchObject([{ family: "Escaped", weight: "400" }]);
  });

  it("reads comments as spaces and keeps the last of repeated descriptors, skipping those marked !important as browsers do", () => {
    const css = `@font-face{font-family:Brand/* x */Sans;font-family:Other !important;src:url(a.woff2)/**/format("woff2"),url(b.woff);font-weight:300;font-weight:bold;font-weight:900 ! IMPORTANT /* c */;unicode-range:U+0-FF/* latin */}`;
    expect(parseFontFaceCss(css, BASE)).toEqual([
      { family: "Brand Sans", src: [{ url: "https://s.example/css/a.woff2", format: "woff2" }, { url: "https://s.example/css/b.woff" }], weight: "700", style: "normal", unicodeRange: "U+0-FF", baseUrl: BASE, origin: "network" },
    ]);
    expect(parseFontFaceCss(`@font-face{font-family:imp !important;src:url(a.woff2)}@font-face{font-family:source;src:url(a.woff2) !important}`, BASE)).toEqual([]);
  });

  it("drops a family longer than 1,024 characters before decoding it", () => {
    const families = (values: string[]) => values.flatMap((value) => parseFontFaceCss(`@font-face{font-family:${value};src:url(a.woff2)}`, BASE)).map((rule) => rule.family);
    expect(MAX_FAMILY_CHARS).toBe(1_024);
    expect(families(["a".repeat(1_024), `"${"b".repeat(1_022)}"`, `\\63 ${"c".repeat(1_020)}`])).toEqual(["a".repeat(1_024), "b".repeat(1_022), "c".repeat(1_021)]);
    expect(families(["a".repeat(1_025), `"${"b".repeat(1_023)}"`, `\\63 ${"c".repeat(1_021)}`])).toEqual([]);
  });

  it("drops a rule whose weight, style or stretch is over 256 characters, or whose unicode range is over 64 KiB, before collapsing its spaces", () => {
    const read = (descriptor: string, value: string) => parseFontFaceCss(`@font-face{font-family:A;src:url(a.woff2);${descriptor}:${value}}`, BASE);
    // Values of `length` characters that collapse to a few
    const spaced = (first: string, last: string, length: number) => `${first}${" ".repeat(length - first.length - last.length)}${last}`;
    expect(MAX_DESCRIPTOR_CHARS).toBe(256);
    expect(MAX_UNICODE_RANGE_CHARS).toBe(64 * 1_024);
    const cases: [descriptor: string, first: string, last: string, max: number, rule: object][] = [
      ["font-weight", "100", "900", 256, { weight: "100 900" }],
      ["font-style", "oblique", "10deg", 256, { style: "oblique 10deg" }],
      ["font-stretch", "75%", "125%", 256, { stretch: "75% 125%" }],
      ["unicode-range", "U+0-FF,", "U+131", 64 * 1_024, { unicodeRange: "U+0-FF, U+131" }],
    ];
    for (const [descriptor, first, last, max, rule] of cases) {
      expect(read(descriptor, spaced(first, last, max)), descriptor).toMatchObject([rule]);
      expect(read(descriptor, spaced(first, last, max + 1)), descriptor).toEqual([]);
    }
  });

  it("decodes names, families and URLs in about the time it takes to tokenize them, however long they are", async () => {
    // css-tree's decoders built a 2 MB name one character at a time, 8 to 20 times slower than tokenizing it, into a
    // rope of 60 MB: 15 MB names ran out of memory, and a family kept its rope as long as its rule
    const name = `\\62 ${"a".repeat(2 * MIB)}`;
    const sheets = {
      family: `@font-face{font-family:${name};src:url(a.woff2)}`,
      quotedFamily: `@font-face{font-family:"${name}";src:url(a.woff2)}`,
      descriptor: `@font-face{${name}:x;font-family:A;src:url(a.woff2)}`,
      atRule: `@${name}{}@font-face{font-family:A;src:url(a.woff2)}`,
      important: `@font-face{font-family:A;src:url(a.woff2);font-display:swap !${name}}`,
      srcFunction: `@font-face{font-family:A;src:${name}(x),url(a.woff2)}`,
      srcString: `@font-face{font-family:A;src:url("data:font/woff2,${name}")}`,
      srcUrl: `@font-face{font-family:A;src:url(data:font/woff2,${name})}`,
      // over the caps of a local() name and of a URL other than a data: URI
      srcLocal: `@font-face{font-family:A;src:local(${name}),url(a.woff2)}`,
      srcRemote: `@font-face{font-family:A;src:url(${name}),url(a.woff2)}`,
    };
    // Lengths of the first source of each rule found
    const found = Object.fromEntries(Object.entries(sheets).map(([key, css]) => [key, parseFontFaceCss(css, BASE).map((rule) => (rule.src[0].url ?? rule.src[0].local)!.length)]));
    const short = new URL("a.woff2", BASE).href.length;
    const long = `data:font/woff2,b${"a".repeat(2 * MIB)}`.length;
    expect(found).toEqual({ family: [], quotedFamily: [], descriptor: [short], atRule: [short], important: [short], srcFunction: [short], srcString: [long], srcUrl: [long], srcLocal: [short], srcRemote: [short] });
    for (const [key, css] of Object.entries(sheets)) {
      const parsing = await fastestMs(() => parseFontFaceCss(css, BASE));
      const tokenizing = await fastestMs(() => tokenize(css, () => {}));
      expect.soft(parsing, key).toBeLessThan(tokenizing * 5 + 5);
    }
  }, 60_000);

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

describe("decodeIdent", () => {
  it("decodes CSS escapes exactly as css-tree does", () => {
    expect(decodeIdent("\\31 23\\ Grotesk\\5FAE\\8f6f\\\r\nx\\0\\110000 \\")).toBe("123 Grotesk\u5fae\u8f6fx\ufffd\ufffd");
    const next = random(7);
    const chars = ["\\", "\\", "a", "F", "0", "g", " ", "\t", "\n", "\r", "\f", '"', ")", "\ud83d", "\ude00", "\u00e9"];
    for (let run = 0; run < 20_000; run += 1) {
      const text = Array.from({ length: Math.floor(next() * 12) }, () => chars[Math.floor(next() * chars.length)]).join("");
      expect(decodeIdent(text), JSON.stringify(text)).toBe(ident.decode(text));
    }
  });

  it("reads a string or url() left open at the end of a value with its last character escaped as browsers do", () => {
    // css-tree gave `"` and `)` for these, the escaped character alone
    expect(parseFontFaceCss(`@font-face{src:url(a.woff2);font-family:"a\\"`, BASE)).toMatchObject([{ family: 'a"' }]);
    expect(parseFontFaceCss(`@font-face{src:url(a.woff2);font-family:"a\\\\"`, BASE)).toMatchObject([{ family: "a\\" }]);
    expect(parseFontSrc("url(a.woff2\\)", BASE)).toEqual([{ url: "https://s.example/css/a.woff2)" }]);
    expect(parseFontSrc("local('a\\'", BASE)).toEqual([{ local: "a'" }]);
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

  it("reads at most 16 url() and local() sources, valid or not, and stops reading the value there", () => {
    const sources = (count: number) => Array.from({ length: count }, (_, index) => `url(${index}.woff2) format(woff2)`).join(",");
    const first16 = Array.from({ length: 16 }, (_, index) => ({ url: `https://s.example/css/${index}.woff2`, format: "woff2" }));
    expect(MAX_SRC_ENTRIES).toBe(16);
    expect(parseFontSrc(sources(16), BASE)).toEqual(first16);
    expect(parseFontSrc(sources(17), BASE)).toEqual(first16);
    expect(parseFontFaceCss(`@font-face{font-family:X;src:${sources(1_000)}}`, BASE)).toMatchObject([{ family: "X", src: first16 }]);
    // sources that give nothing count too, in one entry or in many
    expect(parseFontSrc(`${'url("http://[bad") '.repeat(16)}url(a.woff2)`, BASE)).toEqual([]);
    expect(parseFontSrc(`${"local(), ".repeat(15)}local(A), local(B), url(b.woff2)`, BASE)).toEqual([{ local: "A" }]);
    // A 15 MB stylesheet with one rule of a million sources took 2 seconds and 338 MB to list one file. Past the cap,
    // the rest of the value is neither tokenized again nor parsed as URLs, so a longer list costs nothing more.
    const parses = vi.spyOn(URL, "parse");
    const read = (count: number) => {
      tokenizer.tokens = 0;
      parses.mockClear();
      parseFontSrc(sources(count), BASE);
      return { tokens: tokenizer.tokens, urls: parses.mock.calls.length };
    };
    try {
      expect(read(160_000)).toEqual(read(17));
      expect(read(17).urls).toBe(16);
    } finally {
      parses.mockRestore();
    }
  });

  it("gives no source for a url() over 8 KiB as written or resolved, other than a data: URI, and resolves only absolute URLs against a longer base URL", () => {
    expect(MAX_URL_CHARS).toBe(8 * 1_024);
    // relative URLs that resolve to `length` characters
    const name = (length: number) => "a".repeat(length - DIR.length);
    // `./` segments resolve away: 8,192 and 8,193 characters as written, about 30 resolved
    const dotted = (tail: string) => `${"./".repeat(4_092)}${tail}`;
    for (const wrap of [(url: string) => `url(${url})`, (url: string) => `url("${url}")`]) {
      const read = (urls: string[]) => parseFontSrc([...urls.map(wrap), wrap("z.woff2")].join(", "), BASE).map((source) => source.url);
      expect(read([name(MAX_URL_CHARS), dotted("ab.woff2")])).toEqual([DIR + name(MAX_URL_CHARS), `${DIR}ab.woff2`, `${DIR}z.woff2`]);
      expect(read([name(MAX_URL_CHARS + 1), dotted("abc.woff2")])).toEqual([`${DIR}z.woff2`]);
      const data = `data:font/woff2;base64,${"A".repeat(MIB)}`;
      expect(read([data])).toEqual([data, `${DIR}z.woff2`]);
    }
    const src = `url(a.woff2), url(https://cdn.example/b.woff2), url(data:font/woff2;base64,AAAA)`;
    const base = (length: number) => `${BASE}?${"q".repeat(length - BASE.length - 1)}`;
    expect(parseFontSrc(src, base(MAX_URL_CHARS))).toEqual([{ url: `${DIR}a.woff2` }, { url: "https://cdn.example/b.woff2" }, { url: "data:font/woff2;base64,AAAA" }]);
    expect(parseFontSrc(src, base(MAX_URL_CHARS + 1))).toEqual([{ url: "https://cdn.example/b.woff2" }, { url: "data:font/woff2;base64,AAAA" }]);

    // Resolving a URL reads its base URL again: the 80,000 sources of a stylesheet served at a 1 MB URL took 88 seconds,
    // and a 15 MB url() went out twice in the fonts line. No URL over the cap is parsed, nor any base URL over it.
    const parses = vi.spyOn(URL, "parse");
    try {
      const sheet = Array.from({ length: 500 }, (_, index) => `@font-face{font-family:F${index};src:${Array.from({ length: 16 }, (_, entry) => `url(${entry})`).join(",")}}`).join("");
      expect(parseFontFaceCss(sheet, base(MIB))).toEqual([]);
      expect(parseFontFaceCss(`@font-face{font-family:A;src:url(${"a".repeat(MIB)}),url("${"b".repeat(MIB)}")}`, BASE)).toEqual([]);
      expect(parses).toHaveBeenCalled();
      for (const [url, baseUrl] of parses.mock.calls) expect(Math.max(String(url).length, String(baseUrl ?? "").length)).toBeLessThanOrEqual(MAX_URL_CHARS);
    } finally {
      parses.mockRestore();
    }
  });

  it("gives no source for a local() name over 1,024 characters before decoding, and decodes arguments only while they can make a source or a hint", () => {
    const locals = (value: string) => parseFontSrc(`${value}, url(z.woff2)`, BASE).map((source) => source.local ?? source.url);
    // strings count their quotes, identifiers their escapes, and each gap one space
    expect(locals(`local(${"a".repeat(1_024)}), local("${"b".repeat(1_022)}"), local(\\63 ${"c".repeat(1_020)}), local(${"ab ".repeat(341)}c)`)).toEqual([
      "a".repeat(1_024),
      "b".repeat(1_022),
      "c".repeat(1_021),
      `${"ab ".repeat(341)}c`,
      `${DIR}z.woff2`,
    ]);
    expect(locals(`local(${"a".repeat(1_025)}), local("${"b".repeat(1_023)}"), local(\\63 ${"c".repeat(1_021)}), local(${"ab ".repeat(341)}cd)`)).toEqual([`${DIR}z.woff2`]);

    // A 15 MB local(ab ab ...) decoded and kept 5 million names to join them, and url("ab" "ab" ...) and
    // format("ab" "ab" ...) decoded every string. Past the first few, longer lists cost no more decoding.
    const hostile = [
      (count: number) => `local(${"\\61 b ".repeat(count)}), url(a.woff2)`,
      (count: number) => `url(${'"\\61" '.repeat(count)}), url(a.woff2)`,
      (count: number) => `url(a.woff2) format(${'"\\61" '.repeat(count)})`,
    ];
    const decoding = (value: string) => {
      decoder.calls = 0;
      const sources = parseFontSrc(value, BASE);
      return { sources, calls: decoder.calls };
    };
    for (const value of hostile) {
      const many = decoding(value(100_000));
      expect(many).toEqual(decoding(value(1_000)));
      expect(many.calls).toBeLessThanOrEqual(200);
    }
    expect(hostile.map((value) => decoding(value(100_000)).sources)).toEqual([[{ url: `${DIR}a.woff2` }], [{ url: `${DIR}a.woff2` }], [{ url: `${DIR}a.woff2`, format: "a" }]]);
  });

  it("keeps the first format of a legacy list and drops unresolvable URLs", () => {
    expect(parseFontSrc(`url(a.woff) format("woff", "truetype"), url("http://[bad")`, "https://s.example/")).toEqual([
      { url: "https://s.example/a.woff", format: "woff" },
    ]);
  });
});
