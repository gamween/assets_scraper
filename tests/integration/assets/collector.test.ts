import type { Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RawCandidate, RawCollectorOutput, RawSvg } from "@/server/scan/types";
import type { FixtureServer } from "../../fixtures/serve";
import { collectorOptions, launchChrome, openPage, runCollector, serveAssetsFixture } from "./harness";

let server: FixtureServer;
let browser: Browser;
let output: RawCollectorOutput;
let headerLogoColor: string;

const asset = (name: string) => `${server.origin}/assets/${name}`;
const candidates = (name: string): RawCandidate[] => output.candidates.filter((c) => c.url === asset(name));
const svgWith = (text: string): RawSvg[] => output.svgs.filter((s) => s.markup.includes(text));

beforeAll(async () => {
  server = await serveAssetsFixture({
    "/edge.html": (_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><head><title>Edge</title><link rel="stylesheet" href="/assets/style.css"><link rel="manifest" href="/site.webmanifest"></head><body>
        <div class="lottie-player"><svg width="100" height="100"><g id="__lottie_element_1"><rect width="100" height="100"/></g></svg></div>
        <svg style="display:none"><symbol id="used" viewBox="0 0 8 8"><path d="M0 0h8v8z"/></symbol><symbol id="unused" viewBox="0 0 8 8"><circle cx="4" cy="4" r="4"/></symbol></svg>
        <svg width="16" height="16"><use href="#used"/></svg>
        <svg width="120" height="30"><text x="0" y="20" style="font-family: '__Inter_d65c78'">Brand</text></svg>
        <svg width="120" height="30"><text x="0" y="20" style="font-family: serif">Plain</text></svg>
        <a href="/logout">Log out</a> <a href="/wordpress-tips">Tips</a> <a href="/impressum">Impressum</a> <a href="/express">Express shipping</a>
        <a href="/brand-assets">Assets</a> <a href="/brand-assets#top">Assets again</a> <a href="/brandassets">Downloads</a> <a href="/logopack">Pack</a>
      </body></html>`);
    },
    "/labels.html": (_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><head><title>Labels</title></head><body>
        <a href="/a" aria-label="Link label"><svg width="30" height="30" alt="Alt one"><title>Title one</title><rect width="30" height="30"/></svg></a>
        <svg width="31" height="31" alt="Alt two" title="Attribute two" data-framer-name="Framer two"><title>Title two</title><rect width="31" height="31"/></svg>
        <svg width="32" height="32" alt="Alt three" title="Attribute three"><rect width="32" height="32"/></svg>
        <div data-framer-name="Framer four"><img src="/assets/og.png" title="Attribute four"></div>
        <img src="/assets/touch.png" title="Attribute five">
      </body></html>`);
    },
  });
  browser = await launchChrome();
  const { context, page } = await openPage(browser, `${server.origin}/`);
  output = await runCollector(page, collectorOptions(server.host, "Fixture"));
  headerLogoColor = await page.evaluate(() => getComputedStyle(document.querySelector("header svg path")!).fill);
  await context.close();
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

describe("collector on the fixture page", () => {
  it("reads the page", () => {
    expect(output.page).toMatchObject({ title: "Fixture Co", siteName: "Fixture", baseUrl: `${server.origin}/` });
    expect(output.page.elementCount).toBeGreaterThan(50);
    expect(output.stats.truncated).toBe(false);
    expect(output.stats.ms).toBeLessThan(5_000);
    expect(output.unreadableSheets).toEqual([]);
  });

  it("normalizes the header logo with currentColor resolved", () => {
    const [logo] = output.svgs.filter((s) => s.context.homeLink && s.context.header);
    expect(logo).toBeDefined();
    expect(logo.label).toBe("Fixture home");
    // currentColor comes from the wrapping link, whose UA color is not the body color
    expect(headerLogoColor).toBe("rgb(0, 0, 238)");
    expect(logo.markup).toContain(`color: ${headerLogoColor}`);
    expect(logo.markup).toMatch(/^<svg[^>]* xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    expect(logo.markup).not.toContain("class=");
    expect(logo).toMatchObject({ source: "inline", visible: true, usedCount: 1, hasLiveText: false });
    expect(logo.rect).toMatchObject({ width: 120, height: 32 });
    expect(logo.context.logoWord && logo.context.siteWord).toBe(true);
  });

  it("copies referenced definitions and resolves var() colors", () => {
    const [gradient] = svgWith("<linearGradient");
    expect(gradient.markup).toContain("rgb(255, 51, 102)");
    expect(gradient.markup).toMatch(/<defs><linearGradient/);
    expect(gradient.markup).not.toContain("var(");
    const [external] = svgWith("M12 2l3 7h7l-5.5 4 2 7-6.5-4.5L5.5 20l2-7L2 9h7z");
    expect(external.markup).toContain('href="#ext-star"');
    const [symbolUse] = svgWith("M4 12l5 5L20 6").filter((s) => s.source === "inline");
    expect(symbolUse.markup).toContain('<symbol id="sym-check"');
    const [fallback] = output.svgs.filter((s) => /<circle cx="15" cy="15" r="12"/.test(s.markup));
    expect(fallback.markup).toContain("rgb(255, 51, 102)");
  });

  it("inlines page CSS and dedupes identical SVGs", () => {
    const icons = svgWith("rgb(0, 170, 119)");
    expect(icons).toHaveLength(1);
    expect(icons[0].usedCount).toBe(2);
    const clips = svgWith("clip-path");
    expect(clips).toHaveLength(1);
    expect(clips[0].usedCount).toBe(2);
    const [innerStyle] = svgWith(".st0{fill:#123456}");
    expect(innerStyle.markup).toContain('class="st0"');
  });

  it("keeps hidden SVGs without their display:none", () => {
    const hidden = output.svgs.filter((s) => s.markup.includes("M0 0h40v40z"));
    expect(hidden).toHaveLength(1);
    expect(hidden[0].visible).toBe(false);
    expect(hidden[0].markup).not.toMatch(/display:\s*none/);
    expect(hidden[0].markup).toContain('width="40"');
  });

  it("walks shadow roots and same-origin iframes", () => {
    const [shadow] = svgWith("rgb(0, 153, 255)");
    expect(shadow.context.shadowRoot).toBe(true);
    const [frame] = output.svgs.filter((s) => s.context.iframe);
    expect(frame.markup).toContain("purple");
  });

  it("expands referenced sprite symbols", () => {
    const symbols = output.svgs.filter((s) => s.source === "sprite-symbol");
    expect(symbols).toHaveLength(1);
    expect(symbols[0]).toMatchObject({ referenced: true, visible: false, label: "sym-check" });
    expect(symbols[0].markup).toContain('viewBox="0 0 24 24"');
  });

  it("finds every image candidate with its element group", () => {
    const small = candidates("photo-small.png");
    const large = candidates("photo-large.png");
    expect(large).toHaveLength(1);
    expect(large[0]).toMatchObject({ foundIn: "img", descriptor: { w: 1600 }, label: "Photo", visible: false });
    expect(large[0].rect).toBeUndefined();
    expect(small.some((c) => c.group === large[0].group && c.naturalWidth! > 0 && c.visible && c.rect?.width === 200)).toBe(true);
    // the <picture> fallback src is not what that element shows
    expect(small.find((c) => c.group !== large[0].group && c.foundIn === "img")).toMatchObject({ visible: false });
    expect(candidates("hero.jpg")).toEqual([
      expect.objectContaining({ foundIn: "picture", media: "(min-width: 800px)", type: "image/jpeg", descriptor: { w: 1200 }, naturalWidth: 1440 }),
    ]);
    expect(candidates("lazy.jpg")).toEqual([expect.objectContaining({ foundIn: "lazy-attribute", label: "lazy", visible: false })]);
    expect(candidates("noscript.jpg")).toEqual([expect.objectContaining({ foundIn: "noscript", visible: false })]);
    expect(candidates("poster.jpg")[0]).toMatchObject({ foundIn: "video-poster", visible: true });
    expect(candidates("bg.png").map((c) => c.foundIn)).toContain("css-background");
    expect(candidates("hover.png")).toEqual([expect.objectContaining({ foundIn: "stylesheet", declaredOnly: true, visible: false })]);
    expect(candidates("pseudo.png").map((c) => c.foundIn)).toContain("css-pseudo");
    const [one] = candidates("imgset-1x.png").filter((c) => c.foundIn === "css-background");
    const [two] = candidates("imgset-2x.png").filter((c) => c.foundIn === "css-background");
    expect(one.group).toBe(two.group);
    expect(candidates("mask.svg").map((c) => c.foundIn)).toContain("css-mask");
    expect(candidates("shadow.png")[0]).toMatchObject({ foundIn: "shadow-dom", label: "shadow", context: expect.objectContaining({ shadowRoot: true }) });
    expect(candidates("iframe.png")[0]).toMatchObject({ foundIn: "iframe", context: expect.objectContaining({ iframe: true }) });
    expect(candidates("og.png").map((c) => c.foundIn).sort()).toEqual(["og-image", "svg-image"]);
    expect(candidates("touch.png").map((c) => c.foundIn)).toEqual(["icon-link"]);
    expect(candidates("logo.svg").map((c) => c.foundIn).sort()).toEqual(["icon-link", "img"]);
    expect(candidates("logo.svg").find((c) => c.foundIn === "icon-link")).toMatchObject({ type: "image/svg+xml" });
    expect(output.candidates.filter((c) => c.url === "https://example.invalid/jsonld-logo.png")).toEqual([
      expect.objectContaining({ foundIn: "json-ld", visible: false, declaredOnly: false }),
    ]);
    const lazyPlaceholder = output.candidates.filter((c) => c.url.startsWith("data:image/gif"));
    expect(lazyPlaceholder).toHaveLength(1);
    expect(output.candidates.every((c) => /^(?:https?|data|blob):/.test(c.url))).toBe(true);
  });

  it("orders candidates by page position", () => {
    const [touch] = candidates("touch.png");
    const [poster] = candidates("poster.jpg");
    const [hover] = candidates("hover.png");
    expect(touch.order).toBeLessThan(poster.order);
    expect(poster.order).toBeLessThan(hover.order);
  });

  it("captures blob images while the page is alive", () => {
    expect(output.blobs).toHaveLength(1);
    expect(output.blobs[0].mime).toBe("image/png");
    expect(Buffer.from(output.blobs[0].base64, "base64").subarray(1, 4).toString()).toBe("PNG");
    expect(output.candidates.filter((c) => c.url === output.blobs[0].url)[0]).toMatchObject({ foundIn: "img", label: "blob" });
  });

  it("reads font faces, statuses and usage", () => {
    const inter = output.fontFaces.filter((f) => f.family === "__Inter_d65c78");
    expect(inter).toHaveLength(2);
    expect(inter.map((f) => f.unicodeRange)).toEqual(["U+0-FF", "U+400-45F"]);
    expect(inter[0]).toMatchObject({ weight: "100 900", style: "normal", origin: "cssom", baseUrl: asset("style.css") });
    expect(inter[0].src).toEqual([{ url: asset("__inter.woff2"), format: "woff2" }]);
    expect(output.fontFaces.map((f) => f.family)).toEqual(expect.arrayContaining(["Brand Serif", "Unused Face"]));
    expect(output.fontStatuses).toContainEqual(expect.objectContaining({ family: "__Inter_d65c78", status: "loaded" }));
    expect(output.fontStatuses).toContainEqual(expect.objectContaining({ family: "Unused Face", status: "unloaded" }));
    const interUsage = output.fontUsage.find((u) => u.stack.includes("__Inter_d65c78"));
    const serifUsage = output.fontUsage.find((u) => u.stack.includes("Brand Serif"));
    expect(interUsage?.chars).toBeGreaterThan(10);
    expect(serifUsage?.chars).toBe("Serif text".length);
  });

  it("finds same-site brand links", () => {
    expect(output.brandLinks).toEqual([{ href: `${server.origin}/press`, text: "Press kit" }]);
  });
});

describe("collector noise and edge cases", () => {
  it("drops Lottie frames and unreferenced symbols, flags live text and ignores look-alike links", async () => {
    const { context, page } = await openPage(browser, `${server.origin}/edge.html`);
    const edge = await runCollector(page, collectorOptions(server.host, "Fixture"));
    await context.close();
    expect(edge.noise).toMatchObject({ "lottie-frame": 1, "unreferenced-symbol": 1 });
    expect(edge.svgs.filter((s) => s.source === "sprite-symbol").map((s) => s.label)).toEqual(["used"]);
    expect(edge.svgs.find((s) => s.markup.includes("<text"))).toMatchObject({ hasLiveText: true });
    expect(edge.svgs.find((s) => s.markup.includes("Plain"))).toMatchObject({ hasLiveText: false });
    expect(edge.brandLinks).toEqual([
      { href: `${server.origin}/brand-assets`, text: "Assets" },
      { href: `${server.origin}/brandassets`, text: "Downloads" },
      { href: `${server.origin}/logopack`, text: "Pack" },
    ]);
    expect(edge.manifestUrl).toBe(`${server.origin}/site.webmanifest`);
  });
});

describe("collector labels", () => {
  it("takes the first label in order: aria-label, link aria-label, <title>, alt, data-framer-name, title attribute", async () => {
    const { context, page } = await openPage(browser, `${server.origin}/labels.html`);
    const labels = await runCollector(page, collectorOptions(server.host, "Fixture"));
    await context.close();
    const svgLabel = (width: number) => labels.svgs.find((s) => s.rect?.width === width)?.label;
    expect(svgLabel(30)).toBe("Link label");
    expect(svgLabel(31)).toBe("Title two");
    expect(svgLabel(32)).toBe("Alt three");
    expect(labels.candidates.find((c) => c.url === asset("og.png"))?.label).toBe("Framer four");
    expect(labels.candidates.find((c) => c.url === asset("touch.png"))?.label).toBe("Attribute five");
  });
});

describe("collector limits and hostile pages", () => {
  // The isolated world cannot see the page's patches; the main world, where runInPage falls back, runs among them.
  it.each(["isolated", "main"] as const)("still produces output when the page overrides built-ins, in the %s world", async (world) => {
    const { context, page } = await openPage(browser, `${server.origin}/`);
    await page.evaluate(() => {
      Array.prototype.includes = () => {
        throw new Error("tampered");
      };
      JSON.stringify = () => "{}";
    });
    const tampered = await runCollector(page, collectorOptions(server.host, "Fixture"), world);
    await context.close();
    expect(tampered.svgs.length).toBe(output.svgs.length);
    expect(tampered.candidates.length).toBe(output.candidates.length);
    expect(tampered.blobs).toHaveLength(1);
  });

  it("stops at the element cap and the SVG caps and says so", async () => {
    const { context, page } = await openPage(browser, `${server.origin}/`);
    const capped = await runCollector(page, collectorOptions(server.host, "Fixture", { maxElements: 20 }));
    const noSvgs = await runCollector(page, collectorOptions(server.host, "Fixture", { maxSvgNormalizations: 2 }));
    const tinySvgs = await runCollector(page, collectorOptions(server.host, "Fixture", { maxSvgBytes: 150 }));
    await context.close();
    expect(capped.stats).toMatchObject({ elements: 20, truncated: true });
    expect(noSvgs.stats.truncated).toBe(true);
    expect(noSvgs.svgs.filter((s) => s.source === "inline")).toHaveLength(2);
    expect(tinySvgs.noise["svg-too-large"]).toBeGreaterThan(0);
    expect(tinySvgs.svgs.every((s) => s.markup.length <= 150)).toBe(true);
  });
});
