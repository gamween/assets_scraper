import { describe, expect, it } from "vitest";
import { assetBytes, findSection, isSmallIcon, sectionize, tabCounts, visibleItems } from "./filters";
import { makeAsset, makeFont, makeFontFile, remoteSource } from "./testing";

const siteLogo = makeAsset({ id: "site-logo", kind: "svg", role: "site-logo", name: "Linear logo", score: 1140, order: 3 });
const logo = makeAsset({ id: "logo", kind: "svg", role: "logo", name: "OpenAI", score: 590, order: 40 });
const favicon = makeAsset({ id: "favicon", kind: "image", role: "favicon", name: "Linear favicon", score: 300, order: 1, width: 32, height: 32 });
const social = makeAsset({ id: "og", kind: "image", role: "social", name: "Linear social image", score: 200, order: 2, format: "jpg" });
const hero = makeAsset({
  id: "hero",
  kind: "image",
  role: "image",
  name: "Hero",
  filename: "linear-hero.webp",
  score: 240,
  order: 10,
  width: 2560,
  height: 1429,
  bytes: 64_000,
  renderedWidth: 1200,
  renderedHeight: 670,
  original: remoteSource("https://linear.app/cdn-cgi/imagedelivery/abc/hero"),
});
const avatar = makeAsset({ id: "avatar", kind: "image", role: "image", name: "Avatar of Karri", score: 150, order: 20, width: 144, height: 144, bytes: 9_000, renderedWidth: 64, renderedHeight: 64 });
const illustration = makeAsset({ id: "illu", kind: "svg", role: "illustration", name: "Timeline", score: 190, order: 30, width: 825, height: 400, bytes: 82_000, renderedWidth: 825, renderedHeight: 400 });
const chevron = makeAsset({ id: "chevron", kind: "svg", role: "icon", name: "Chevron", score: 60, order: 50, renderedWidth: 16, renderedHeight: 16 });
const tinyRaster = makeAsset({ id: "tiny", kind: "image", role: "image", name: "Tiny", score: 100, order: 55, width: 32, height: 32 });
const declared = makeAsset({ id: "declared", kind: "image", role: "image", name: "Background", declaredOnly: true, visible: false, score: 100, order: 60, width: 800, height: 600 });

const assets = [chevron, hero, declared, avatar, logo, social, illustration, favicon, siteLogo, tinyRaster];

const inter = makeFont({ id: "inter", name: "Inter Variable", usage: 0.8, faces: [{ weight: "100 900", style: "normal", loaded: true, files: [makeFontFile({ url: "https://static.linear.app/fonts/InterVariable.woff2", bytes: 344_000 })] }] });
const mono = makeFont({ id: "mono", name: "Berkeley Mono", usage: 0.1, faces: [{ weight: "400", style: "normal", loaded: true, files: [makeFontFile({ bytes: 157_000 })] }] });
const unused = makeFont({ id: "unused", name: "Unused Face", usedOnPage: false, usage: 0 });
const fonts = [mono, unused, inter];

const ids = (items: { id: string }[] | undefined) => items?.map((item) => item.id);

describe("sectionize", () => {
  it("builds the All sections in order", () => {
    const sections = sectionize(assets, fonts, { tab: "all", query: "", sort: "relevance" });
    expect(sections.map((s) => s.id)).toEqual(["logos", "svg", "images", "fonts", "small-icons", "stylesheets", "declared-fonts"]);
    expect(ids(findSection(sections, "logos")?.items)).toEqual(["site-logo", "logo", "favicon"]);
    expect(ids(findSection(sections, "svg")?.items)).toEqual(["illu"]);
    // Social images lead the Images section.
    expect(ids(findSection(sections, "images")?.items)).toEqual(["og", "hero", "avatar"]);
    expect(ids(findSection(sections, "fonts")?.items)).toEqual(["inter", "mono"]);
    expect(ids(findSection(sections, "small-icons")?.items)).toEqual(["tiny", "chevron"]);
    expect(ids(findSection(sections, "stylesheets")?.items)).toEqual(["declared"]);
    expect(ids(findSection(sections, "declared-fonts")?.items)).toEqual(["unused"]);
    expect(sections.filter((s) => s.collapsible).map((s) => s.id)).toEqual(["small-icons", "stylesheets", "declared-fonts"]);
  });

  it("uses the single small-icon rule with logo roles exempt", () => {
    expect(isSmallIcon(chevron)).toBe(true);
    expect(isSmallIcon(tinyRaster)).toBe(true);
    expect(isSmallIcon(makeAsset({ id: "x", role: "image", renderedWidth: 48, renderedHeight: 20, width: 400, height: 200 }))).toBe(true);
    expect(isSmallIcon(makeAsset({ id: "x", role: "image", renderedWidth: 49, renderedHeight: 20 }))).toBe(false);
    expect(isSmallIcon(makeAsset({ id: "x", role: "favicon", width: 16, height: 16 }))).toBe(false);
    expect(isSmallIcon(makeAsset({ id: "x", role: "site-logo", renderedWidth: 20, renderedHeight: 20 }))).toBe(false);
    expect(isSmallIcon(makeAsset({ id: "x", role: "image" }))).toBe(false);
  });

  it("has no Logos section in the type tabs", () => {
    const svg = sectionize(assets, fonts, { tab: "svg", query: "", sort: "relevance" });
    expect(svg.map((s) => s.id)).toEqual(["svg", "small-icons"]);
    expect(ids(findSection(svg, "svg")?.items)).toEqual(["site-logo", "logo", "illu"]);

    const images = sectionize(assets, fonts, { tab: "images", query: "", sort: "relevance" });
    expect(images.map((s) => s.id)).toEqual(["images", "small-icons", "stylesheets"]);
    expect(ids(findSection(images, "images")?.items)).toEqual(["og", "favicon", "hero", "avatar"]);

    const fontTab = sectionize(assets, fonts, { tab: "fonts", query: "", sort: "relevance" });
    expect(fontTab.map((s) => s.id)).toEqual(["fonts", "declared-fonts"]);
  });

  it("matches the query against names, filenames, URLs and font names, case-insensitively", () => {
    const byQuery = (query: string) =>
      sectionize(assets, fonts, { tab: "all", query, sort: "relevance" }).flatMap((s) => s.items.map((item) => item.id));
    expect(byQuery("KARRI")).toEqual(["avatar"]);
    expect(byQuery("linear-hero.webp")).toEqual(["hero"]);
    expect(byQuery("imagedelivery")).toEqual(["hero"]);
    expect(byQuery("inter var")).toEqual(["inter"]);
    expect(byQuery("InterVariable.woff2")).toEqual(["inter"]);
    expect(byQuery("  berkeley ")).toEqual(["mono"]);
    expect(byQuery("zzz")).toEqual([]);
  });

  it("sorts within sections", () => {
    const images = (sort: "relevance" | "page-order" | "largest" | "file-size" | "name") =>
      ids(findSection(sectionize(assets, fonts, { tab: "images", query: "", sort }), "images")?.items);
    expect(images("page-order")).toEqual(["og", "favicon", "hero", "avatar"]);
    expect(images("largest")).toEqual(["og", "hero", "avatar", "favicon"]);
    // `hero` has an original whose probe recorded no size, so its size is unknown and it sorts with the unsized.
    expect(images("file-size")).toEqual(["og", "avatar", "favicon", "hero"]);
    expect(images("name")).toEqual(["og", "avatar", "hero", "favicon"]);

    const fontNames = (sort: "relevance" | "name" | "file-size") =>
      ids(findSection(sectionize(assets, fonts, { tab: "fonts", query: "", sort }), "fonts")?.items);
    expect(fontNames("relevance")).toEqual(["inter", "mono"]);
    expect(fontNames("name")).toEqual(["mono", "inter"]);
    expect(fontNames("file-size")).toEqual(["inter", "mono"]);
  });

  it("counts tabs for the current query", () => {
    expect(tabCounts(assets, fonts, "")).toEqual({ all: 13, svg: 4, images: 6, fonts: 3 });
    expect(tabCounts(assets, fonts, "linear")).toEqual({ all: 5, svg: 1, images: 3, fonts: 1 });
  });

  it("flattens visible items and skips collapsed sections", () => {
    const sections = sectionize(assets, fonts, { tab: "all", query: "", sort: "relevance" });
    const keys = visibleItems(sections, new Set()).map((item) => item.key);
    expect(keys).toEqual(["asset:site-logo", "asset:logo", "asset:favicon", "asset:illu", "asset:og", "asset:hero", "asset:avatar", "font:inter", "font:mono"]);
    const expanded = visibleItems(sections, new Set(["small-icons"])).map((item) => item.key);
    expect(expanded.slice(-2)).toEqual(["asset:tiny", "asset:chevron"]);
  });
});

describe("assetBytes", () => {
  it("reports the original, never the display derivative", () => {
    const asset = makeAsset({
      id: "aerial",
      kind: "image",
      bytes: 205_658,
      display: { ...remoteSource("https://cdn.test/aerial.webp"), format: "webp", width: 1632, height: 703, bytes: 205_658 },
      original: { ...remoteSource("https://cdn.test/aerial.png"), width: 2460, height: 1060 },
    });
    // The download delivers the 2460x1060 original; 205 658 is the WebP the page showed, a different file.
    expect(assetBytes(asset)).toBe(0);
    expect(assetBytes({ ...asset, original: { ...asset.original!, bytes: 4_274_919 } })).toBe(4_274_919);
  });

  it("falls back to the page's own bytes when there is no original", () => {
    expect(assetBytes(makeAsset({ id: "inline", kind: "svg", bytes: 3_040 }))).toBe(3_040);
    expect(assetBytes(makeAsset({ id: "display-only", display: { ...remoteSource("https://cdn.test/a.png"), bytes: 1_200 } }))).toBe(1_200);
    expect(assetBytes(makeAsset({ id: "nothing" }))).toBe(0);
  });
});
