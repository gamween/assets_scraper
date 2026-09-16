import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readIconColors, readSignals, type RawPaletteSignals } from "./signals";

const FIXTURES = path.join(process.cwd(), "tests/fixtures/palette");

const valid = (): RawPaletteSignals => ({
  url: "https://example.com/",
  vw: 1440,
  vh: 900,
  docH: 4000,
  samples: [["bg", "#ffffff", 1000, 3], ["cta", "#0052ff", 40, 2]],
  vars: [["--brand", "#0052ff", 1]],
  meta: { themeColor: "#0052ff", tileColor: null, maskIconColor: null, manifestTheme: null, manifestBackground: null },
  mediaRects: [[0, 100, 600, 400, "img"]],
  logoImageRects: [[20, 20, 120, 32]],
  logoBackdrop: "#ffffff",
  logoFound: true,
  iconUrls: ["https://example.com/apple-touch-icon.png"],
  manifestUrl: "https://example.com/site.webmanifest",
  stats: { visited: 900, walkMs: 30, hidden: 1, truncated: false },
});

describe("readSignals", () => {
  it("keeps valid in-page signals as they are", () => {
    expect(readSignals(valid())).toEqual(valid());
  });

  it("accepts the recorded lab signals once node-side sources are left out", () => {
    for (const file of readdirSync(FIXTURES).filter((f) => f.endsWith(".signals.json"))) {
      const recorded = JSON.parse(readFileSync(path.join(FIXTURES, file), "utf8")) as RawPaletteSignals;
      const read = readSignals(recorded);
      expect(read?.samples).toEqual(recorded.samples.filter((s) => s[0] !== "icon"));
      expect(read?.vars).toEqual(recorded.vars);
      expect(read?.mediaRects).toEqual(recorded.mediaRects);
    }
  });

  it("rejects values that are not signals", () => {
    for (const value of [null, undefined, 42, "signals", [], { vw: 0, vh: 900 }, { vw: 1440, vh: Number.NaN }]) {
      expect(readSignals(value)).toBeNull();
    }
  });

  it("drops malformed entries instead of failing", () => {
    const signals = {
      ...valid(),
      samples: [
        ["bg", "#ffffff", 1000, 3], ["pix", "#000000", 0.5, 1], ["text", "#3e70000", 10, 1], ["text", "#ABCDEF", 10, 1],
        ["cta", "#0052ff", Number.POSITIVE_INFINITY, 1], ["link", "#0052ff", -1, 1], "junk", ["svg", "#0052ff", 5, 1],
      ],
      vars: [["--brand", "#0052ff", 1], ["--x", "red", 1], [1, "#000000", 1]],
      meta: { themeColor: "blue", tileColor: "#ffffff", maskIconColor: 3 },
      mediaRects: [[0, 0, 10, 10, "img"], [0, 0, 10, 10, "photo"], [0, 0, "10", 10, "img"]],
      logoImageRects: [[1, 2, 3, 4], [1, 2, 3]],
      logoBackdrop: "white",
      iconUrls: ["https://example.com/a.png", "javascript:alert(1)", "data:image/png;base64,AAAA", "http://example.com/b.png"],
      manifestUrl: "file:///etc/passwd",
      stats: undefined,
    };
    expect(readSignals(signals)).toEqual({
      ...valid(),
      samples: [["bg", "#ffffff", 1000, 3], ["svg", "#0052ff", 5, 1]],
      vars: [["--brand", "#0052ff", 1]],
      meta: { themeColor: null, tileColor: "#ffffff", maskIconColor: null, manifestTheme: null, manifestBackground: null },
      mediaRects: [[0, 0, 10, 10, "img"]],
      logoImageRects: [[1, 2, 3, 4]],
      logoBackdrop: null,
      iconUrls: ["https://example.com/a.png", "http://example.com/b.png"],
      manifestUrl: null,
      stats: { visited: 0, walkMs: 0, hidden: 0, truncated: false },
    });
  });

  it("caps list sizes", () => {
    const many = {
      ...valid(),
      samples: Array.from({ length: 50_000 }, (_, i) => ["svg", `#${i.toString(16).padStart(6, "0")}`, 1, 1]),
      vars: Array.from({ length: 1_000 }, (_, i) => [`--brand-${i}`, "#0052ff", 1]),
      mediaRects: Array.from({ length: 5_000 }, () => [0, 0, 10, 10, "img"]),
      logoImageRects: Array.from({ length: 500 }, () => [0, 0, 10, 10]),
      iconUrls: Array.from({ length: 10 }, (_, i) => `https://example.com/${i}.png`),
    };
    const read = readSignals(many);
    expect(read?.samples.length).toBeLessThanOrEqual(20_000);
    expect(read?.vars.length).toBeLessThanOrEqual(400);
    expect(read?.mediaRects.length).toBeLessThanOrEqual(2_000);
    expect(read?.logoImageRects.length).toBeLessThanOrEqual(20);
    expect(read?.iconUrls).toHaveLength(3);
  });
});

describe("readIconColors", () => {
  it("keeps valid [hex, count] pairs", () => {
    expect(readIconColors([["#0052ff", 120], ["#ffffff", 8], ["#nothex", 3], ["#000000", Number.NaN], "x"])).toEqual([["#0052ff", 120], ["#ffffff", 8]]);
    expect(readIconColors("nope")).toEqual([]);
  });
});
