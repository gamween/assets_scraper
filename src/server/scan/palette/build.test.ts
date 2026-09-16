import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Palette } from "@/lib/contract";
import { buildPalette, DEFAULT_CONFIG, toContractPalette, type BuiltPalette } from "./build";
import { hexToRgb, hueDiff, oklabToLch, rgbToOklab, type RGB } from "./color";
import type { Pixels } from "./png";
import type { RawPaletteSignals } from "./signals";

const FIXTURES = path.join(process.cwd(), "tests/fixtures/palette");
const loadSignals = (host: string): RawPaletteSignals =>
  JSON.parse(readFileSync(path.join(FIXTURES, `${host}.signals.json`), "utf8")) as RawPaletteSignals;

const hue = (hex: string) => oklabToLch(rgbToOklab(hexToRgb(hex))).h;

/** A width x height RGBA screenshot filled with `background`, plus optional solid blocks (CSS px, scale 1). */
const screenshot = (width: number, height: number, background: string, blocks: { rect: [number, number, number, number]; hex: string }[] = []): Pixels => {
  const data = new Uint8Array(width * height * 4);
  const paint = (x0: number, y0: number, w: number, h: number, rgb: RGB) => {
    for (let y = y0; y < Math.min(height, y0 + h); y++) {
      for (let x = x0; x < Math.min(width, x0 + w); x++) data.set([...rgb, 255], (y * width + x) * 4);
    }
  };
  paint(0, 0, width, height, hexToRgb(background));
  for (const { rect, hex } of blocks) paint(rect[0], rect[1], rect[2], rect[3], hexToRgb(hex));
  return { width, height, channels: 4, data };
};

/** Recorded lab signals, the dominant background of the lab screenshot and the expected brand color. */
const SITES = [
  { host: "stripe.com", background: "#ffffff", brand: "#533afd" },
  { host: "uniswap.org", background: "#fdfdfd", brand: "#ff37c7" },
  { host: "www.spotify.com", background: "#121212", brand: "#1ed760" },
  { host: "www.coinbase.com", background: "#ffffff", brand: "#0052ff" },
  { host: "chain.link", background: "#0847f7", brand: "#0847f7" },
  { host: "linear.app", background: "#08090a", brand: "#5e6ad2" },
];

const HEX = /^#[0-9a-f]{6}$/;

const expectShape = (palette: BuiltPalette) => {
  expect(palette.brand.length).toBeLessThanOrEqual(6);
  expect(palette.neutrals.length).toBeLessThanOrEqual(5);
  for (const color of palette.colors) expect(color.hex).toMatch(HEX);
  expect(palette.colors.map((c) => c.hex)).toEqual([...palette.brand, ...palette.neutrals]);
  expect(new Set(palette.colors.map((c) => c.hex)).size).toBe(palette.colors.length);
};

/** Minimal signals for targeted cases. */
const signals = (overrides: Partial<RawPaletteSignals> = {}): RawPaletteSignals => ({
  url: "https://example.com/",
  vw: 100,
  vh: 100,
  docH: 100,
  samples: [],
  vars: [],
  meta: { themeColor: null, tileColor: null, maskIconColor: null, manifestTheme: null, manifestBackground: null },
  mediaRects: [],
  logoImageRects: [],
  logoBackdrop: null,
  logoFound: false,
  iconUrls: [],
  manifestUrl: null,
  stats: { visited: 100, walkMs: 5, hidden: 0, truncated: false },
  ...overrides,
});

describe("buildPalette on recorded signals", () => {
  const results = SITES.map((site) => {
    const pixels = screenshot(1440, 900, site.background, [{ rect: [100, 400, 200, 60], hex: site.brand }]);
    return { ...site, palette: buildPalette(loadSignals(site.host), pixels, DEFAULT_CONFIG) };
  });

  it("finds the expected brand hue in the top 3 on at least 5 of 6 sites", () => {
    const hits = results.filter(({ palette, brand }) => palette.brand.slice(0, 3).some((hex) => hueDiff(hue(hex), hue(brand)) <= 20));
    expect(hits.length).toBeGreaterThanOrEqual(5);
  });

  it("keeps the output shape on every site, with and without pixels", () => {
    for (const { host, palette } of results) {
      expectShape(palette);
      expectShape(buildPalette(loadSignals(host), null));
    }
  });

  it("labels Stripe as the lab did", () => {
    const stripe = results[0].palette;
    expect(stripe.colors[0]).toMatchObject({ hex: "#533afd", kind: "brand", role: "primary" });
    expect(stripe.colors.find((c) => c.role === "background")?.hex).toBe("#ffffff");
    expect(stripe.colors.find((c) => c.role === "text")?.hex).toBe("#061b31");
    expect(stripe.confidence).toBe("high");
  });

  it("maps to the contract palette", () => {
    for (const { palette } of results) {
      const contract = toContractPalette(palette);
      expect(Palette.parse(contract)).toEqual(contract);
      expect(contract.brand.map((s) => s.hex)).toEqual(palette.brand);
      expect(contract.neutrals.map((s) => s.hex)).toEqual(palette.neutrals);
    }
    const stripe = toContractPalette(results[0].palette);
    expect(stripe.brand[0]).toEqual({ hex: "#533afd", role: "primary" });
    const unlabeled = results[0].palette.colors.find((c) => c.role === null);
    expect(unlabeled).toBeDefined();
    const swatch = [...stripe.brand, ...stripe.neutrals].find((s) => s.hex === unlabeled?.hex);
    expect(swatch).toEqual({ hex: unlabeled?.hex });
  });
});

describe("buildPalette rules", () => {
  it("returns an empty palette without signals", () => {
    const palette = buildPalette(signals(), null);
    expect(palette).toMatchObject({ colors: [], brand: [], neutrals: [], confidence: "medium" });
    expect(toContractPalette(palette)).toEqual({ brand: [], neutrals: [] });
  });

  it("picks a primary backed by CTAs, a background and a text color", () => {
    const palette = buildPalette(
      signals({
        samples: [
          ["bg", "#ffffff", 9000, 3], ["text", "#111111", 500, 40], ["cta", "#e11d48", 200, 3], ["link", "#e11d48", 20, 4],
          ["bg", "#e11d48", 300, 2], ["text", "#6b7280", 60, 10],
        ],
      }),
      screenshot(100, 100, "#ffffff", [{ rect: [10, 10, 20, 10], hex: "#e11d48" }]),
    );
    expect(palette.brand).toEqual(["#e11d48"]);
    expect(palette.colors[0].role).toBe("primary");
    expect(palette.colors.find((c) => c.hex === "#ffffff")?.role).toBe("background");
    expect(palette.colors.find((c) => c.hex === "#111111")?.role).toBe("text");
    expect(palette.neutrals).toContain("#6b7280");
  });

  it("ignores favicon generator default colors in meta tags", () => {
    const palette = buildPalette(signals({ meta: { ...signals().meta, tileColor: "#DA532C", themeColor: "#2b5797" } }), null);
    expect(palette.colors).toEqual([]);
  });

  it("drops a declared-only color when a painted brand color leads", () => {
    const palette = buildPalette(
      signals({
        samples: [["bg", "#ffffff", 9000, 1], ["cta", "#16a34a", 300, 4], ["link", "#16a34a", 30, 3], ["text", "#111111", 400, 20]],
        vars: [["--brand-secondary", "#7c3aed", 1]],
        meta: { ...signals().meta, themeColor: "#7c3aed" },
      }),
      null,
    );
    expect(palette.brand).toEqual(["#16a34a"]);
  });

  it("keeps a declared color when nothing is painted", () => {
    const palette = buildPalette(signals({ samples: [["bg", "#ffffff", 9000, 1]], vars: [["--brand", "#7c3aed", 1]], meta: { ...signals().meta, themeColor: "#7c3aed" } }), null);
    expect(palette.brand).toEqual(["#7c3aed"]);
  });

  it("gives an extra neutral slot to a neutral covering at least 20 percent of the viewport", () => {
    const samples: RawPaletteSignals["samples"] = [
      ["bg", "#f5f5f7", 5000, 2], ["text", "#333336", 800, 50], ["bg", "#ffffff", 3000, 2], ["text", "#6e6e73", 200, 20],
      ["text", "#86868b", 100, 10], ["border", "#d2d2d7", 400, 10],
    ];
    const hero = buildPalette(signals({ samples }), screenshot(100, 100, "#f5f5f7", [{ rect: [0, 0, 100, 40], hex: "#000000" }]));
    expect(hero.neutrals).toEqual(["#f5f5f7", "#333336", "#000000", "#ffffff", "#6e6e73"]);
    const flat = buildPalette(signals({ samples }), screenshot(100, 100, "#f5f5f7"));
    expect(flat.neutrals).toEqual(["#f5f5f7", "#333336", "#ffffff", "#6e6e73"]);
  });

  it("pools a vivid glow spread over many pixel bins into one brand color", () => {
    const width = 300, height = 100;
    const glow = screenshot(width, height, "#000000");
    for (let y = 0; y < 40; y++) {
      for (let x = 0; x < width; x++) glow.data.set([20 + (x % 60), 60 + (y % 50), 255 - (x % 40), 255], (y * width + x) * 4);
    }
    const palette = buildPalette(signals({ vw: width, vh: height, samples: [["bg", "#000000", 9000, 1], ["text", "#ffffff", 300, 20]] }), glow);
    expect(palette.brand).toHaveLength(1);
    expect(hueDiff(hue(palette.brand[0]), 265)).toBeLessThanOrEqual(20);
  });

  it("samples raster logo colors from the pixels without their real backdrop", () => {
    // DOM says the logo sits on white, but a background image paints navy around it
    const pixels = screenshot(200, 100, "#ffffff", [
      { rect: [0, 0, 100, 60], hex: "#0b1b3f" },
      { rect: [20, 20, 12, 20], hex: "#e3066a" },
      { rect: [32, 20, 12, 20], hex: "#fcc003" },
      { rect: [44, 20, 12, 20], hex: "#2eb67d" },
    ]);
    const palette = buildPalette(
      signals({
        vw: 200,
        samples: [["bg", "#ffffff", 9000, 1], ["text", "#111111", 400, 20], ["cta", "#e3066a", 100, 2]],
        logoImageRects: [[10, 10, 60, 40]],
        logoBackdrop: "#ffffff",
        mediaRects: [[0, 0, 100, 60, "bgimg"]],
      }),
      pixels,
    );
    expect(palette.brand).toEqual(expect.arrayContaining(["#e3066a", "#fcc003", "#2eb67d"]));
    expect(palette.colors.every((c) => !c.sources.includes("logo") || c.hex !== "#0b1b3f")).toBe(true);
  });
});
