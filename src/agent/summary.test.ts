import { describe, expect, it } from "vitest";
import { fit, MAX_SUMMARY_BYTES, summarize } from "./summary";
import type { BrandFile, FontFamily, FontFile } from "@/lib/contract";
import { testAsset, testFontFamily, testFontFile, testScan, testWordmark } from "./testing";

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

  it("passes the page's brand kit links on, capped and cut, and an empty list when it has none", () => {
    const base = testScan();
    expect(summarize(base).brandLinks).toEqual([]);
    const links = Array.from({ length: 9 }, (_, index) => ({ href: `https://x.com/brand/${index}/${"p".repeat(400)}`, text: `Brand ${index} ${"t".repeat(200)}` }));
    const summary = summarize({ ...base, page: { ...base.page, brandLinks: links } });
    expect(summary.brandLinks).toHaveLength(6);
    expect(summary.brandLinks[0].href.startsWith("https://x.com/brand/0/")).toBe(true);
    expect(summary.brandLinks.every((link) => link.href.length <= 200 && link.text.length <= 60)).toBe(true);
    expect(summary.page).not.toHaveProperty("brandLinks");
    expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThan(4_096);
  });

  it("lists the brand files archives first, at most 8, cut, and counts the rest", () => {
    const base = testScan();
    expect(summarize(base)).toMatchObject({ brandFiles: [], otherBrandFiles: 0 });
    const file = (index: number, type: BrandFile["type"]): BrandFile => ({
      id: `f${index}`.padEnd(12, "0"),
      url: `https://monad.xyz/brand-page-assets/${index}/${"p".repeat(400)}.${type}`,
      name: `Logo ${index} ${"n".repeat(200)}`,
      type,
      foundIn: "script",
      ...(index === 0 ? { bytes: 29_679_666 } : {}),
    });
    const files = [file(1, "svg"), file(2, "png"), file(3, "svg"), file(4, "pdf"), file(0, "zip"), ...Array.from({ length: 7 }, (_, index) => file(10 + index, "svg"))];
    const summary = summarize({ ...base, page: { ...base.page, brandFiles: files } });
    expect(summary.brandFiles.map((row) => row.type)).toEqual(["zip", "pdf", "svg", "svg", "svg", "svg", "svg", "svg"]);
    expect(summary.brandFiles[0]).toMatchObject({ id: "f00000000000", bytes: 29_679_666 });
    expect(summary.brandFiles[1]).not.toHaveProperty("bytes");
    expect(summary.brandFiles.every((row) => row.url.length <= 200 && row.name.length <= 60)).toBe(true);
    expect(summary.otherBrandFiles).toBe(files.length - 8);
    expect(summary.page).not.toHaveProperty("brandFiles");
    expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThan(4_096);
  });

  it("passes the wordmark on, and leaves it out of a page that has none", () => {
    const base = testScan();
    expect(summarize(base)).not.toHaveProperty("wordmark");
    const summary = summarize({ ...base, page: { ...base.page, wordmark: testWordmark() } });
    expect(summary.wordmark).toEqual(testWordmark());
    expect(summary.wordmark?.withLogo?.id).toBe(summary.logos[0].id);
    expect(summary.page).not.toHaveProperty("wordmark");
  });

  it("cuts the wordmark's strings and caps its runs, whatever a hosted app sends", () => {
    const base = testScan();
    const wordmark = testWordmark({
      text: "t".repeat(500),
      family: "f".repeat(500),
      runs: Array.from({ length: 9 }, (_, index) => ({ text: `${index}${"r".repeat(300)}`, hex: "#130d21" })),
      withLogo: { id: "i".repeat(500), width: 36, height: 36 },
    });
    const summary = summarize({ ...base, page: { ...base.page, wordmark } });
    expect(summary.wordmark?.text.length).toBeLessThanOrEqual(40);
    expect(summary.wordmark?.family.length).toBeLessThanOrEqual(60);
    // The runs share the text's 40 characters: the first takes them all here.
    expect(summary.wordmark?.runs).toHaveLength(1);
    expect(summary.wordmark?.runs[0].text).toHaveLength(40);
    expect(summary.wordmark?.withLogo?.id.length).toBeLessThanOrEqual(60);
    expect(Buffer.byteLength(JSON.stringify(summary.wordmark))).toBeLessThan(400);
    const four = summarize({ ...base, page: { ...base.page, wordmark: testWordmark({ runs: Array.from({ length: 9 }, (_, index) => ({ text: `run${index}`, hex: "#130d21" })) }) } });
    expect(four.wordmark?.runs.map((run) => run.text)).toEqual(["run0", "run1", "run2", "run3"]);
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
    scan.page.brandFiles = Array.from({ length: 16 }, (_, index) => ({
      id: `${index}`.padStart(12, "0"), url: `https://x.com/${long(300)}/${index}.zip`, name: long(200), type: "zip" as const, foundIn: "link" as const, bytes: 123_456_789,
    }));
    scan.page.wordmark = testWordmark({
      text: long(40),
      family: long(60),
      runs: Array.from({ length: 4 }, (_, index) => ({ text: long(10), hex: `#00000${index}` })),
      withLogo: { id: `${"a1b2c3d4".repeat(5)}0`, width: 36, height: 36 },
    });
    const summary = summarize(scan);
    expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThanOrEqual(MAX_SUMMARY_BYTES);
    expect(summary.otherBrandFiles).toBe(16 - summary.brandFiles.length);
    expect(summary.logos.length).toBeGreaterThan(0);
    // What an agent needs to ask for anything else survives, and the logos it gave up are counted with the rest.
    expect(summary.scanId).toBe("scan-1");
    expect(summary.counts.assets).toBe(308);
    expect(summary.page.host).toHaveLength(100);
    expect(summary.otherAssets).toBe(308 - summary.logos.length);
  });
});

describe("fit", () => {
  /**
   * The caps keep a summary well under the budget once its brand rows are gone, so only a document wider than
   * `summarize` makes reaches the wordmark: one with more palette rows than it keeps, here.
   */
  const wide = (swatches: number) => {
    const base = summarize(testScan({ warnings: [], fonts: [] }));
    return { ...base, wordmark: testWordmark(), palette: Array.from({ length: swatches }, () => ({ hex: "#635bff", role: "primary" })) };
  };
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

  it("gives up the wordmark before any logo row, since it is the other half of a logo", () => {
    let swatches = 0;
    while (bytes(wide(swatches + 1)) <= MAX_SUMMARY_BYTES) swatches += 1;
    // One swatch more than fits, and less than the wordmark weighs: dropping the wordmark is enough.
    const summary = fit(wide(swatches + 1), 236, 0);
    expect(summary.wordmark).toBeUndefined();
    expect(summary.logos).toHaveLength(8);
    expect(summary.palette).toHaveLength(swatches + 1);
  });

  it("gives up logo rows only once the wordmark is gone, and the palette last", () => {
    let swatches = 0;
    while (bytes(wide(swatches + 1)) <= MAX_SUMMARY_BYTES + 600) swatches += 1;
    const summary = fit(wide(swatches), 236, 0);
    expect(summary.wordmark).toBeUndefined();
    expect(summary.logos.length).toBeLessThan(8);
    expect(summary.palette).toHaveLength(swatches);
    expect(summary.otherAssets).toBe(236 - summary.logos.length);
    expect(bytes(summary)).toBeLessThanOrEqual(MAX_SUMMARY_BYTES);
  });
});

describe("the installable column", () => {
  const installable = (family: FontFamily): boolean => summarize(testScan({ fonts: [family] })).fonts[0].installable;
  const withFiles = (name: string, files: Partial<FontFile>[]): FontFamily =>
    testFontFamily({ name, faces: [{ weight: "400", style: "normal", loaded: true, files: files.map((file) => testFontFile(file)) }] });

  it("says what the installer would install, whatever the licence", () => {
    expect(installable(testFontFamily({ name: "Inter" }))).toBe(true);
    expect(installable(testFontFamily({ name: "Proxima Nova", source: "adobe-fonts", downloadable: false }))).toBe(false);
    expect(installable(testFontFamily({ name: "Empty", faces: [] }))).toBe(false);
    expect(installable(testFontFamily({ name: "Commercial", license: { kind: "commercial" }, convertible: false }))).toBe(true);
    expect(installable(withFiles("Eot", [{ url: "https://x/f.eot", format: "eot" }]))).toBe(false);
    expect(installable(withFiles("Woff", [{ url: "https://x/f.woff", format: "woff" }]))).toBe(true);
  });

  /**
   * Regression: the summary kept its own copy of the rule, which ignored `coversLatin`, so every icon font and every
   * Cyrillic-only subset read `installable: true` and then failed `install_fonts` with `no-latin-file`.
   */
  it("says no for a family whose files cover no Basic Latin, as the installer does", () => {
    expect(installable(withFiles("Icons", [{ url: "https://x/icons.woff2", format: "woff2", coversLatin: false }]))).toBe(false);
    expect(installable(withFiles("Mixed", [{ url: "https://x/cyr.woff2", coversLatin: false }, { url: "https://x/latin.woff2" }]))).toBe(true);
  });
});
