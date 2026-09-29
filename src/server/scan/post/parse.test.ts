import { describe, expect, it, vi } from "vitest";
import { LINEAR_OP_GROWTH_BOUND, opGrowth } from "../fonts/testing";
import { decodeDataUri, forEachStylesheetUrl, type StylesheetUrl } from "./parse";

/**
 * The characters the CSS value reader steps over (`readCssToken`), counted, so `opGrowth` sees how the work on the
 * values of a captured stylesheet grows with it. css-tree splits the sheet into declarations first, in linear time.
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
