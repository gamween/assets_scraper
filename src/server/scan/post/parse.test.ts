import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeDataUri, extractCssUrls, extractStylesheetUrls, forEachStylesheetUrl, parseSrcset } from "./parse";

describe("parseSrcset", () => {
  it("keeps commas inside URLs and reads descriptors", () => {
    expect(parseSrcset("https://res.cloudinary.com/x/image/upload/w_500,c_fill/a.jpg 500w, /b.jpg 1000w")).toEqual([
      { url: "https://res.cloudinary.com/x/image/upload/w_500,c_fill/a.jpg", w: 500 },
      { url: "/b.jpg", w: 1000 },
    ]);
    expect(parseSrcset("a.png, b.png 2x")).toEqual([{ url: "a.png", x: 1 }, { url: "b.png", x: 2 }]);
    expect(parseSrcset("")).toEqual([]);
  });

  it("reads fractional densities, trailing commas and extra whitespace", () => {
    expect(parseSrcset("  a.png 1.5x ,b.png,  ")).toEqual([{ url: "a.png", x: 1.5 }, { url: "b.png", x: 1 }]);
    expect(parseSrcset("a.png 100w 50h, b.png")).toEqual([{ url: "a.png", w: 100 }, { url: "b.png", x: 1 }]);
  });

  it("keeps the in-page copy of the descriptor patterns in sync", () => {
    // collector.src.ts cannot import this module, so its parseSrcset is a copy. The bounded digit runs are what keep
    // both copies linear, so a drift here is the cubic blowup coming back in the renderer.
    const descriptors = (source: string) => source.match(/descriptor\.match\(\/.+?\/\);/g);
    const inPage = readFileSync(new URL("../inpage/collector.src.ts", import.meta.url), "utf8");
    expect(descriptors(inPage)).toEqual(descriptors(readFileSync(new URL("./parse.ts", import.meta.url), "utf8")));
    expect(descriptors(inPage)).toHaveLength(2);
  });

  it("stays fast on a long digit run in a descriptor", () => {
    // An unbounded `\d*\.?\d+` in the x descriptor is cubic in the descriptor length: 4000 digits took 8 seconds.
    const started = performance.now();
    expect(parseSrcset(`a.png ${"9".repeat(4_000)}y`)).toEqual([{ url: "a.png", x: 1 }]);
    expect(performance.now() - started).toBeLessThan(200);
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
});

describe("extractStylesheetUrls", () => {
  it("reads url() declarations with their property, resolved against the sheet URL", () => {
    const css = `
      @font-face { font-family: X; src: url(x.woff2); }
      .a { background-image: url(img/a.png); cursor: url(c.cur), auto; }
      @media (max-width: 600px) { .b { --icon: url("/icons/b.svg"); mask-image: image-set("m.png" 1x, "m@2x.png" 2x); } }
      .c { filter: url(#blur); }
    `;
    expect(extractStylesheetUrls(css, "https://cdn.example/css/site.css")).toEqual([
      { url: "https://cdn.example/css/img/a.png", property: "background-image", declaration: 0, imageSet: false },
      { url: "https://cdn.example/icons/b.svg", property: "--icon", declaration: 1, imageSet: false },
      { url: "https://cdn.example/css/m.png", property: "mask-image", declaration: 2, imageSet: true },
      { url: "https://cdn.example/css/m@2x.png", property: "mask-image", declaration: 2, imageSet: true },
    ]);
  });

  it("tells image-set declarations of the same property apart", () => {
    const css = '.hero{background-image:image-set("a.png" 1x,"a2.png" 2x)} .card{background-image:image-set("c.png" 1x,"c2.png" 2x)}';
    const urls = extractStylesheetUrls(css, "https://s.example/");
    expect(urls.map((u) => [u.url, u.declaration])).toEqual([
      ["https://s.example/a.png", 0], ["https://s.example/a2.png", 0], ["https://s.example/c.png", 1], ["https://s.example/c2.png", 1],
    ]);
  });

  it("reads nested rules, unquoted data URIs with semicolons and comments, and skips invalid property names", () => {
    const css = `@supports (display:grid) { .a { .b:hover { /* c */ Background-Image: url(data:image/svg+xml;utf8,%3Csvg%3E) } --x: url(v.png); *zoom: url(z.png) } }`;
    expect(extractStylesheetUrls(css, "https://s.example/").map((u) => [u.property, u.url])).toEqual([
      ["background-image", "data:image/svg+xml;utf8,%3Csvg%3E"],
      ["--x", "https://s.example/v.png"],
    ]);
  });

  it("reads a declaration after a comment that contains a colon", () => {
    const css = ".hero{color:#fff;\n /* retina: 2x */\n background-image:url(hero@2x.png)} .b{/* Hero: banner */ background-image:url(hero.jpg)} .c{/* a: */ /* b: */ --i/* x: */:url(i.svg)}";
    expect(extractStylesheetUrls(css, "https://s.example/").map((u) => [u.property, u.url])).toEqual([
      ["background-image", "https://s.example/hero@2x.png"],
      ["background-image", "https://s.example/hero.jpg"],
      ["--i", "https://s.example/i.svg"],
    ]);
  });

  it("stops when the visitor asks", () => {
    const seen: string[] = [];
    forEachStylesheetUrl(".a{background:url(1.png)} .b{background:url(2.png)} .c{background:url(3.png)}", "https://s.example/", (item) => {
      seen.push(item.url);
      return seen.length === 2 ? "stop" : undefined;
    });
    expect(seen).toEqual(["https://s.example/1.png", "https://s.example/2.png"]);
  });

  it("survives broken CSS", () => {
    expect(extractStylesheetUrls(".a { background: url(ok.png) } }}} .b { color: ", "https://s.example/")).toEqual([
      { url: "https://s.example/ok.png", property: "background", declaration: 0, imageSet: false },
    ]);
  });
});

describe("decodeDataUri", () => {
  it("decodes base64 and percent-encoded data URIs", () => {
    const png = decodeDataUri("data:image/png;base64,iVBORw0KGgo=");
    expect(png?.mime).toBe("image/png");
    expect([...png!.buffer.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    const svg = decodeDataUri("data:image/svg+xml;charset=utf-8,%3Csvg%3E%3C/svg%3E");
    expect(svg).toMatchObject({ mime: "image/svg+xml" });
    expect(svg!.buffer.toString("utf8")).toBe("<svg></svg>");
    expect(decodeDataUri("data:,hello")?.mime).toBe("text/plain");
  });

  it("returns null for anything else", () => {
    expect(decodeDataUri("https://a.example/x.png")).toBeNull();
    expect(decodeDataUri("data:image/svg+xml,%E0%A4%A")).toBeNull();
  });
});
