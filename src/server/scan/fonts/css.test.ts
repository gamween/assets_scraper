import { describe, expect, it } from "vitest";
import { parseFontFaceCss, parseFontSrc } from "./css";

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

  it("keeps the first format of a legacy list and drops unresolvable URLs", () => {
    expect(parseFontSrc(`url(a.woff) format("woff", "truetype"), url("http://[bad")`, "https://s.example/")).toEqual([
      { url: "https://s.example/a.woff", format: "woff" },
    ]);
  });
});
