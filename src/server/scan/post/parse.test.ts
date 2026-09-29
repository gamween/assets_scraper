import { describe, expect, it, vi } from "vitest";
import { LINEAR_OP_GROWTH_BOUND, opGrowth } from "../fonts/testing";
import { decodeDataUri, forEachStylesheetUrl, largestIconSize, MAX_ICON_SIZES_CHARS, svgSize, type StylesheetUrl } from "./parse";

/**
 * The characters the text readers step over, counted, so `opGrowth` sees how their work grows with the input: the CSS
 * value reader (`readCssToken`) and the forward search (`searchFrom`). css-tree splits a sheet into declarations first,
 * in linear time.
 */
const ops = vi.hoisted(() => ({ count: 0 }));
vi.mock("../inpage/css-tokens", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../inpage/css-tokens")>();
  return {
    ...actual,
    readCssToken: (text: string, start: number) => {
      const token = actual.readCssToken(text, start);
      ops.count += token.end - start;
      return token;
    },
  };
});
vi.mock("./search", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./search")>();
  return {
    ...actual,
    searchFrom: (text: string, pattern: RegExp, from: number) => {
      const match = actual.searchFrom(text, pattern, from);
      ops.count += (match ? match.index + match[0].length : text.length) - from;
      return match;
    },
  };
});

/** Every image URL `forEachStylesheetUrl` reads from a stylesheet, in order. */
const stylesheetUrls = (cssText: string, baseUrl: string) => {
  const out: StylesheetUrl[] = [];
  forEachStylesheetUrl(cssText, baseUrl, (item) => {
    out.push(item);
  });
  return out;
};

describe("forEachStylesheetUrl", () => {
  it("reads url() declarations with their property, resolved against the sheet URL", () => {
    const css = `
      @font-face { font-family: X; src: url(x.woff2); }
      .a { background-image: url(img/a.png); cursor: url(c.cur), auto; }
      @media (max-width: 600px) { .b { --icon: url("/icons/b.svg"); mask-image: image-set("m.png" 1x, "m@2x.png" 2x); } }
      .c { filter: url(#blur); }
    `;
    expect(stylesheetUrls(css, "https://cdn.example/css/site.css")).toEqual([
      { url: "https://cdn.example/css/img/a.png", property: "background-image", declaration: 0, imageSet: false },
      { url: "https://cdn.example/icons/b.svg", property: "--icon", declaration: 1, imageSet: false },
      { url: "https://cdn.example/css/m.png", property: "mask-image", declaration: 2, imageSet: true },
      { url: "https://cdn.example/css/m@2x.png", property: "mask-image", declaration: 2, imageSet: true },
    ]);
  });

  it("tells image-set declarations of the same property apart", () => {
    const css = '.hero{background-image:image-set("a.png" 1x,"a2.png" 2x)} .card{background-image:image-set("c.png" 1x,"c2.png" 2x)}';
    const urls = stylesheetUrls(css, "https://s.example/");
    expect(urls.map((u) => [u.url, u.declaration])).toEqual([
      ["https://s.example/a.png", 0], ["https://s.example/a2.png", 0], ["https://s.example/c.png", 1], ["https://s.example/c2.png", 1],
    ]);
  });

  it("reads nested rules, unquoted data URIs with semicolons and comments, and skips invalid property names", () => {
    const css = `@supports (display:grid) { .a { .b:hover { /* c */ Background-Image: url(data:image/svg+xml;utf8,%3Csvg%3E) } --x: url(v.png); *zoom: url(z.png) } }`;
    expect(stylesheetUrls(css, "https://s.example/").map((u) => [u.property, u.url])).toEqual([
      ["background-image", "data:image/svg+xml;utf8,%3Csvg%3E"],
      ["--x", "https://s.example/v.png"],
    ]);
  });

  it("reads a declaration after a comment that contains a colon", () => {
    const css = ".hero{color:#fff;\n /* retina: 2x */\n background-image:url(hero@2x.png)} .b{/* Hero: banner */ background-image:url(hero.jpg)} .c{/* a: */ /* b: */ --i/* x: */:url(i.svg)}";
    expect(stylesheetUrls(css, "https://s.example/").map((u) => [u.property, u.url])).toEqual([
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

  it("drops the fragment of an http(s) URL, the way the network reports it, and keeps the one of a data: URI", () => {
    const data = "data:image/svg+xml,<svg><use href='#i'/></svg>";
    const css = `.a{background:url(icons.svg#arrow)} .b{mask-image:url("${data}")}`;
    expect(stylesheetUrls(css, "https://s.example/css/site.css").map((u) => u.url)).toEqual(["https://s.example/css/icons.svg", new URL(data).href]);
    expect(new URL(data).hash).not.toBe("");
  });

  it("survives broken CSS", () => {
    expect(stylesheetUrls(".a { background: url(ok.png) } }}} .b { color: ", "https://s.example/")).toEqual([
      { url: "https://s.example/ok.png", property: "background", declaration: 0, imageSet: false },
    ]);
  });

  /**
   * Regression: the declaration left open at the end of a sheet is the rest of the sheet, and the regular expressions
   * that read its URLs backtracked from every `url(` to the end of it. A captured 1 MB sheet of `url(url(url(` held the
   * event loop for minutes, past the scan's own deadline, with every other request on the instance waiting behind it.
   */
  it("reads the values of a hostile stylesheet in linear time", async () => {
    const hostile: Record<string, (size: number) => string> = {
      urls: (size) => `a{background:${"url(".repeat(size / 4)}`,
      spaces: (size) => `a{background:url(${" ".repeat(size)}`,
      quotes: (size) => `a{b:image-set("${'\\"'.repeat(size / 2)}`,
    };
    for (const [kind, sheet] of Object.entries(hostile)) {
      const { small, factor } = await opGrowth((size) => stylesheetUrls(sheet(size), "https://s.example/"), 16_000, ops);
      expect.soft(small, kind).toBeGreaterThan(0);
      expect.soft(factor, kind).toBeLessThan(LINEAR_OP_GROWTH_BOUND);
    }
    expect(stylesheetUrls(`a{background:${"url(".repeat(250_000)}`, "https://s.example/")).toEqual([]);
  });
});

describe("largestIconSize", () => {
  it("reads the largest size of a sizes list", () => {
    expect(largestIconSize("16x16 32x32 any")).toEqual({ width: 32, height: 32 });
    expect(largestIconSize("192X192")).toEqual({ width: 192, height: 192 });
    expect(largestIconSize("any")).toBeUndefined();
    expect(largestIconSize(undefined)).toBeUndefined();
    // A number longer than five digits is no size, rather than the size of its last five
    expect(largestIconSize("123456x7 48x48")).toEqual({ width: 48, height: 48 });
  });

  /**
   * Regression: `(\d+)x(\d+)` backtracked over a digit run from every digit of it, and the value comes as it is from a
   * `<link sizes>` or a web manifest. Half a million digits held the event loop for over a minute. The read is capped,
   * so the work stops growing with the value at all.
   */
  it("reads a bounded prefix of a hostile value", async () => {
    for (const [kind, value] of Object.entries({ digits: (size: number) => "1".repeat(size), sizes: (size: number) => "1x1 ".repeat(size / 4) })) {
      const { small, large } = await opGrowth((size) => largestIconSize(value(size)), 4_000, ops);
      expect.soft(small, kind).toBeGreaterThan(0);
      expect.soft(large, kind).toBeLessThanOrEqual(MAX_ICON_SIZES_CHARS);
    }
    expect(largestIconSize(`${"1".repeat(1_000_000)}x1`)).toBeUndefined();
  });
});

describe("svgSize", () => {
  it("reads the root attributes, then falls back to the viewBox", () => {
    expect(svgSize(`<svg width="24" height="24"></svg>`)).toEqual({ width: 24, height: 24 });
    expect(svgSize(`<svg width=" 24px " height='1.5'></svg>`)).toEqual({ width: 24, height: 1.5 });
    expect(svgSize(`<svg WIDTH=".5" HEIGHT=".25"></svg>`)).toEqual({ width: 0.5, height: 0.25 });
    expect(svgSize(`<svg viewBox="0 0 16 32"></svg>`)).toEqual({ width: 16, height: 32 });
    expect(svgSize(`<svg width="0" height="0" viewBox="0 0 16 32"></svg>`)).toEqual({ width: 16, height: 32 });
    expect(svgSize(`<svg width="24"></svg>`)).toEqual({});
  });

  it("finds the root tag in linear time", async () => {
    // Regression: `<svg\b[^>]*>` over the whole markup read from every `<svg` to the end when no `>` followed. A 1 MB
    // captured SVG that sharp could not measure took minutes, three times per asset.
    const hostile: Record<string, (size: number) => string> = {
      open: (size) => "<svg".repeat(size / 4),
      late: (size) => `${"<svg ".repeat(size / 5)}width="4" height="2">`,
    };
    for (const [kind, markup] of Object.entries(hostile)) {
      const { small, large, factor } = await opGrowth((size) => svgSize(markup(size)), 32_000, ops);
      expect.soft(small, kind).toBeGreaterThan(0);
      expect.soft(factor, kind).toBeLessThan(LINEAR_OP_GROWTH_BOUND);
      expect.soft(large, kind).toBeLessThanOrEqual(markup(32_000 * 8).length);
    }
    expect(svgSize("<svg".repeat(250_000))).toEqual({});
    // A root tag past the cut is read from its first 4 KB, as before
    expect(svgSize(`<svg width="4" height="2" data-x="${"x".repeat(8_000)}"><rect/></svg>`)).toEqual({ width: 4, height: 2 });
  });

  it("stays fast on a root tag carrying a long digit run", () => {
    // An unbounded digit run in the width pattern backtracks quadratically, which blocks the scan past every deadline.
    const started = performance.now();
    expect(svgSize(`<svg width='${"9".repeat(200_000)}x'><rect width="10" height="10"/></svg>`)).toEqual({});
    expect(performance.now() - started).toBeLessThan(100);
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

  it("keeps a literal percent, the way a browser does", () => {
    // An unescaped SVG data URI uses raw percent signs in gradients and percentage geometry, and Chrome paints it.
    const svg = decodeDataUri("data:image/svg+xml,<svg width='120' height='120'><stop offset='0%' stop-color='%23ff0000'/><rect fill='url(%23g)'/></svg>");
    expect(svg?.mime).toBe("image/svg+xml");
    expect(svg!.buffer.toString("utf8")).toBe("<svg width='120' height='120'><stop offset='0%' stop-color='#ff0000'/><rect fill='url(#g)'/></svg>");
    // A truncated escape is bytes too, not a reason to drop the URI.
    expect([...decodeDataUri("data:image/svg+xml,%E0%A4%A")!.buffer]).toEqual([0xe0, 0xa4, 0x25, 0x41]);
  });

  it("returns null for anything that is not a data URI", () => {
    expect(decodeDataUri("https://a.example/x.png")).toBeNull();
  });
});
