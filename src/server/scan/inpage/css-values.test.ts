import { describe, expect, it, vi } from "vitest";
import { GROWTH, LINEAR_OP_GROWTH_BOUND, opGrowth } from "../fonts/testing";
import { readCssToken } from "./css-tokens";
import { extractCssUrls, readCssUrls, readFontFaceSrc } from "./css-values";

/**
 * The characters `readCssToken` steps over, counted, so `opGrowth` can tell a reader that starts each token where the
 * previous one ended (every character read once) from one that goes back over what it read (quadratic).
 */
const ops = vi.hoisted(() => ({ count: 0 }));
vi.mock("./css-tokens", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./css-tokens")>();
  return {
    ...actual,
    readCssToken: (text: string, start: number) => {
      const token = actual.readCssToken(text, start);
      ops.count += token.end - start;
      return token;
    },
  };
});

const BASE = "https://s.example/css/a.css";

describe("readCssToken", () => {
  it("reads strings, url() and escapes the way a browser does", () => {
    expect(readCssToken(`"a\\"b" x`, 0)).toEqual({ type: "string", end: 6, value: 'a"b' });
    expect(readCssToken(`'a\nb'`, 0)).toEqual({ type: "bad-string", end: 2, value: "" });
    expect(readCssToken(`url( a\\29 b.png ) x`, 0)).toEqual({ type: "url", end: 17, value: "a)b.png" });
    expect(readCssToken(`url(a b) x`, 0)).toEqual({ type: "bad-url", end: 8, value: "" });
    expect(readCssToken(`url(a\\)b(c) x`, 0)).toEqual({ type: "bad-url", end: 11, value: "" });
    expect(readCssToken(`URL( "a.png")`, 0)).toEqual({ type: "function", end: 4, value: "url" });
    expect(readCssToken(`-Webkit-Image-Set(`, 0)).toEqual({ type: "function", end: 18, value: "-webkit-image-set" });
    expect(readCssToken(`\\31 23px,`, 0)).toEqual({ type: "word", end: 8, value: "123px" });
    expect(readCssToken(`/* x */y`, 0)).toEqual({ type: "comment", end: 7, value: "" });
    expect(readCssToken(`/* open`, 0)).toEqual({ type: "comment", end: 7, value: "" });
  });

  it("ends a name at a colon, a semicolon, a bracket or a brace, which are tokens of their own", () => {
    expect(readCssToken(`fill:url(#a)`, 0)).toEqual({ type: "word", end: 4, value: "fill" });
    for (const delimiter of ":;[]{}") expect(readCssToken(`${delimiter}url(a)`, 0)).toEqual({ type: "delimiter", end: 1, value: "" });
    // Inside an unquoted url() they are part of the URL, as React's `:r1:` ids are
    expect(readCssToken(`url(#:r1:)`, 0)).toEqual({ type: "url", end: 10, value: "#:r1:" });
  });
});

describe("extractCssUrls", () => {
  it("reads url() and image-set strings without garbage", () => {
    expect(extractCssUrls('url("a.png"), url(b.png)')).toEqual(["a.png", "b.png"]);
    expect(extractCssUrls('image-set("imgset-1x.png" 1x, "imgset-2x.png" 2x)')).toEqual(["imgset-1x.png", "imgset-2x.png"]);
    expect(extractCssUrls('image-set(url("a.png") 1dppx, url("b.png") 2dppx)')).toEqual(["a.png", "b.png"]);
    expect(extractCssUrls("none")).toEqual([]);
    expect(extractCssUrls("url(#grad1)")).toEqual([]);
  });

  it("unescapes quoted URLs, dedupes and reads -webkit-image-set", () => {
    expect(extractCssUrls("url('a\\'b.png') url('a\\'b.png')")).toEqual(["a'b.png"]);
    expect(extractCssUrls('-webkit-image-set("x.png" 1x)')).toEqual(["x.png"]);
    expect(extractCssUrls("linear-gradient(red, blue)")).toEqual([]);
  });

  it("reads only what a browser would load", () => {
    // Function names are case-insensitive, and hex escapes are decoded
    expect(extractCssUrls("URL(a.png), Url( 'b\\2e png' )")).toEqual(["a.png", "b.png"]);
    // The type() of an image-set candidate is not an image, and a url() in a comment or a string is no url()
    expect(extractCssUrls('image-set("a.avif" type("image/avif"), "a.jpg" type("image/jpeg"))')).toEqual(["a.avif", "a.jpg"]);
    expect(extractCssUrls('/* url(old.png) */ url(new.png), "url(text.png)"')).toEqual(["new.png"]);
    // A url() a browser rejects names nothing: whitespace inside, a quote or a parenthesis, text after the string
    expect(extractCssUrls('url(a b.png) url(url(c.png)) url("d.png" e) url(f.png)')).toEqual(["f.png"]);
    // An unquoted data URI keeps its semicolons, commas and percent escapes
    expect(extractCssUrls("url(data:image/svg+xml;utf8,%3Csvg%3E)")).toEqual(["data:image/svg+xml;utf8,%3Csvg%3E"]);
  });

  /**
   * The regular expressions this replaced backtracked from every start position to the end of the value: `url(url(`
   * repeated, `url(` then a run of spaces with no `)`, an image-set of escaped quotes. A 1 MB value blocked the page or
   * the event loop for minutes. Counted, eight times the input has to cost about eight times the characters read, and
   * no reader may read a character twice.
   */
  it("reads each character of a hostile value once", async () => {
    const hostile: Record<string, (size: number) => string> = {
      urls: (size) => "url(".repeat(size / 4),
      spaces: (size) => `url(${" ".repeat(size)}`,
      quotes: (size) => `image-set("${'\\"'.repeat(size / 2)}`,
      string: (size) => `url("${"a".repeat(size)}`,
      parentheses: (size) => "(".repeat(size),
      escapes: (size) => "\\31 ".repeat(size / 4),
      comment: (size) => `/*${"*".repeat(size)}`,
      badUrl: (size) => `url(a${"\\)".repeat(size / 2)}`,
    };
    const readers = { readCssUrls: (value: string) => readCssUrls(value), readFontFaceSrc: (value: string) => readFontFaceSrc(value, BASE) };
    for (const [name, read] of Object.entries(readers)) {
      for (const [kind, value] of Object.entries(hostile)) {
        const { small, large, factor } = await opGrowth((size) => read(value(size)), 8_000, ops);
        expect.soft(small, `${name} ${kind}`).toBeGreaterThan(0);
        expect.soft(factor, `${name} ${kind}`).toBeLessThan(LINEAR_OP_GROWTH_BOUND);
        expect.soft(large, `${name} ${kind}`).toBeLessThanOrEqual(value(8_000 * GROWTH).length);
      }
    }
    expect(extractCssUrls("url(".repeat(250_000))).toEqual([]);
    expect(extractCssUrls(`url(${" ".repeat(1_000_000)}`)).toEqual([]);
  });
});

describe("readCssUrls", () => {
  it("keeps fragment references, for the SVG code that follows them", () => {
    expect(readCssUrls(`url(#a) url("#b") url( '#c' ) url(#d e)`)).toEqual(["#a", "#b", "#c"]);
    expect(readCssUrls(`.x { fill: url(#g1) } /* url(#no) */ .y { clip-path: url("#c2") }`)).toEqual(["#g1", "#c2"]);
  });

  it("reads the url() of a style attribute or a minified rule, right after a colon, a semicolon or a brace", () => {
    // The shape of an SVG export's `style` attributes and `<style>` rules: reading `fill:url` as one function name lost
    // the gradients and clip paths a sprite keeps outside its symbols.
    expect(readCssUrls("fill:url(#a);clip-path:url('#b')")).toEqual(["#a", "#b"]);
    expect(readCssUrls(".cls-1{fill:url(#linear-gradient);}.cls-2{mask:url(#m)}")).toEqual(["#linear-gradient", "#m"]);
    expect(extractCssUrls("background-image:image-set(url(a.png) 1x,'b.png' 2x)!important")).toEqual(["a.png", "b.png"]);
  });
});

describe("readFontFaceSrc", () => {
  it("reads url() with its format() hint, and local() names", () => {
    const data = "data:font/woff2;base64,d09GMgABAAAA";
    expect(readFontFaceSrc(`local("Inter Regular"), url("${data}") format("woff2"), url("x.ttf?v=1#iefix") format("truetype") tech(variations), url('x.eot')`, BASE)).toEqual([
      { local: "Inter Regular" },
      { url: data, format: "woff2" },
      { url: "https://s.example/css/x.ttf?v=1#iefix", format: "truetype" },
      { url: "https://s.example/css/x.eot" },
    ]);
    expect(readFontFaceSrc("url(a.woff2) format(woff2), local(Brand   Sans)", BASE)).toEqual([
      { url: "https://s.example/css/a.woff2", format: "woff2" },
      { local: "Brand Sans" },
    ]);
  });

  it("gives nothing for what does not parse", () => {
    expect(readFontFaceSrc("url(url(url(", BASE)).toEqual([]);
    expect(readFontFaceSrc(`url("a" b), local(), format(woff2), url("http://[bad")`, BASE)).toEqual([]);
    // A format() only belongs to the url() right before it
    expect(readFontFaceSrc(`url(a.woff2), format("woff2")`, BASE)).toEqual([{ url: "https://s.example/css/a.woff2" }]);
  });
});
