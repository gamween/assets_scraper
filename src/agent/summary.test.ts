import { describe, expect, it } from "vitest";
import { isInstallableFamily, summarize } from "./summary";
import { testFontFamily, testScan } from "./testing";

describe("summarize", () => {
  it("stays small on a page with 236 assets", () => {
    const summary = summarize(testScan());
    expect(summary.logos.length).toBeLessThanOrEqual(8);
    expect(summary.logos.length).toBeGreaterThan(0);
    expect(summary.otherAssets).toBe(236 - summary.logos.length);
    expect(summary.counts).toEqual({ assets: 236, svg: 40, images: 196, fonts: 2, hidden: 12 });
    expect(summary.durationMs).toBe(12_345);
    expect(summary.scanId).toBe("scan-1");
    expect(summary.page.host).toBe("stripe.com");
    expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThan(4_096);
  });

  it("returns the palette hexes with their roles", () => {
    expect(summarize(testScan()).palette).toEqual([
      { hex: "#635bff", role: "primary" },
      { hex: "#0a2540", role: "accent" },
      { hex: "#ffffff", role: "background" },
      { hex: "#f6f9fc", role: "surface" },
      { hex: "#425466", role: "text" },
    ]);
    expect(summarize(testScan({ palette: null })).palette).toEqual([]);
  });

  it("returns one row per font family, with what can be installed", () => {
    const scan = testScan({
      fonts: [
        testFontFamily({ name: "Inter" }),
        testFontFamily({ name: "Proxima Nova", source: "adobe-fonts", downloadable: false, convertible: false, license: { kind: "commercial" }, usedOnPage: false }),
      ],
    });
    expect(summarize(scan).fonts).toEqual([
      { family: "Inter", license: "open", usedOnPage: true, installable: true },
      { family: "Proxima Nova", license: "commercial", usedOnPage: false, installable: false },
    ]);
  });

  it("keeps the logos the scan ranked first, with their dimensions", () => {
    const summary = summarize(testScan());
    expect(summary.logos[0]).toEqual({ id: "asset-0", name: "asset-0", kind: "image", width: 1200, height: 800 });
    expect(summary.logos.every((logo) => logo.id.startsWith("asset-"))).toBe(true);
  });

  it("cuts a long title and a long list of warnings", () => {
    const summary = summarize(testScan({
      page: { url: "https://x.com", finalUrl: "https://x.com/", host: "x.com", title: "t".repeat(3_000), siteName: "s".repeat(500) },
      warnings: Array.from({ length: 40 }, (_, index) => `warning ${index} ${"x".repeat(200)}`),
    }));
    expect(summary.page.title.length).toBeLessThanOrEqual(120);
    expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThan(4_096);
  });
});

describe("isInstallableFamily", () => {
  it("is false for Adobe Fonts and for a family with no file, true for a self-hosted WOFF2", () => {
    expect(isInstallableFamily(testFontFamily({ name: "Inter" }))).toBe(true);
    expect(isInstallableFamily(testFontFamily({ name: "Proxima Nova", source: "adobe-fonts", downloadable: false }))).toBe(false);
    expect(isInstallableFamily(testFontFamily({ name: "Empty", faces: [] }))).toBe(false);
    expect(isInstallableFamily(testFontFamily({ name: "Commercial", license: { kind: "commercial" }, convertible: false }))).toBe(true);
    expect(
      isInstallableFamily(testFontFamily({ name: "Eot", faces: [{ weight: "400", style: "normal", loaded: true, files: [{ url: "https://x/f.eot", proxy: "", format: "eot", coversLatin: true }] }] })),
    ).toBe(false);
  });
});
