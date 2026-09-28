import { describe, expect, it } from "vitest";
import { MAX_SUMMARY_BYTES, isInstallableFamily, summarize } from "./summary";
import { testAsset, testFontFamily, testScan } from "./testing";

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
    expect(summary.logos[0]).toEqual({ id: "asset-0", name: "asset-0", kind: "image", format: "png", width: 1200, height: 800 });
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

  it("cuts a long host", () => {
    // Regression: the host was the one string copied raw, so a 247 character host (inside the DNS limit, so reachable)
    // took the worst case summary to 4381 bytes, over the budget every other string here is cut to keep.
    const host = `${"label".repeat(9)}.${"sub".repeat(60)}.example.com`;
    expect(host.length).toBeGreaterThan(200);
    const summary = summarize(testScan({
      page: { url: `https://${host}/`, finalUrl: `https://${host}/`, host, title: "t".repeat(3_000), siteName: "s".repeat(500) },
      warnings: Array.from({ length: 40 }, (_, index) => `warning ${index} ${"x".repeat(200)}`),
    }));
    expect(summary.page.host.length).toBeLessThanOrEqual(100);
    expect(summary.page.host.startsWith("labellabel")).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThan(4_096);
  });

  it("cuts a long URL and a long final URL", () => {
    // Regression: every other string was cut but these two were not, so a 2048 character URL (the most ScanRequest
    // allows) plus a redirect to one as long blew the budget on its own, at 5218 bytes.
    const url = `https://example.com/?q=${"a".repeat(2_000)}`;
    const summary = summarize(testScan({ page: { url, finalUrl: `${url}&redirected=1`, host: "example.com", title: "Example" } }));
    expect(summary.page.url.length).toBeLessThanOrEqual(200);
    expect(summary.page.finalUrl.length).toBeLessThanOrEqual(200);
    expect(summary.page.url.startsWith("https://example.com/?q=aaa")).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThan(4_096);
  });

  it("fits the budget with every string and every list at its cap", () => {
    // The caps alone are not a bound: 8 logos carrying a 40 character id, 12 font families and 12 swatches, every name
    // at its cap, measure well over the budget, so the document gives up rows rather than the budget.
    const long = (count: number): string => "w".repeat(count);
    const scan = testScan({
      page: { url: `https://${long(300)}.com/${long(2_000)}`, finalUrl: `https://${long(300)}.com/${long(2_000)}`, host: `${long(240)}.com`, title: long(3_000), siteName: long(500) },
      assets: [
        ...Array.from({ length: 8 }, (_, index) => testAsset({ id: `${"a1b2c3d4".repeat(5)}${index}`, role: "logo", name: long(200), width: 123_456, height: 123_456, score: 100 })),
        ...Array.from({ length: 300 }, (_, index) => testAsset({ id: `asset-${index}` })),
      ],
      fonts: Array.from({ length: 20 }, (_, index) => testFontFamily({ name: `${long(200)}-${index}`, license: { kind: "commercial" } })),
      palette: {
        brand: Array.from({ length: 8 }, () => ({ hex: "#635bff", role: "background" as const })),
        neutrals: Array.from({ length: 8 }, () => ({ hex: "#f6f9fc", role: "background" as const })),
      },
      stats: { assets: 308, svg: 8, images: 300, fonts: 20, hidden: { tracker: 3 }, durationMs: 12_345 },
      warnings: Array.from({ length: 40 }, () => long(400)),
    });
    const summary = summarize(scan);
    expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThanOrEqual(MAX_SUMMARY_BYTES);
    // What an agent needs to ask for anything else survives, and the logos it gave up are counted with the rest.
    expect(summary.scanId).toBe("scan-1");
    expect(summary.counts.assets).toBe(308);
    expect(summary.page.host).toHaveLength(100);
    expect(summary.otherAssets).toBe(308 - summary.logos.length);
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
