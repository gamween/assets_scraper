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
  server = await serveAssetsFixture();
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
    expect(large[0]).toMatchObject({ foundIn: "img", descriptor: { w: 1600 }, label: "Photo" });
    expect(small.some((c) => c.group === large[0].group && c.naturalWidth! > 0 && c.visible)).toBe(true);
    expect(candidates("hero.jpg")).toEqual([
      expect.objectContaining({ foundIn: "picture", media: "(min-width: 800px)", type: "image/jpeg", descriptor: { w: 1200 }, naturalWidth: 1440 }),
    ]);
    expect(candidates("lazy.jpg")).toEqual([expect.objectContaining({ foundIn: "lazy-attribute", label: "lazy" })]);
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

describe("collector limits and hostile pages", () => {
  it("still produces output when the page overrides built-ins", async () => {
    const { context, page } = await openPage(browser, `${server.origin}/`);
    await page.evaluate(() => {
      Array.prototype.includes = () => {
        throw new Error("tampered");
      };
      JSON.stringify = () => "{}";
    });
    const tampered = await runCollector(page, collectorOptions(server.host, "Fixture"));
    await context.close();
    expect(tampered.svgs.length).toBe(output.svgs.length);
    expect(tampered.candidates.length).toBe(output.candidates.length);
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
