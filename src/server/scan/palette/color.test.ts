import { describe, expect, it } from "vitest";
import { contrastRatio, hexToRgb, hueDiff, isNeutral, lstar, oklabDistance, oklabToLch, rgbToHex, rgbToOklab } from "./color";

const lch = (hex: string) => oklabToLch(rgbToOklab(hexToRgb(hex)));

describe("color math", () => {
  it("converts between hex and RGB", () => {
    expect(hexToRgb("#533afd")).toEqual([83, 58, 253]);
    expect(hexToRgb("#533AFD")).toEqual([83, 58, 253]);
    expect(rgbToHex([83, 58, 253])).toBe("#533afd");
    expect(rgbToHex(hexToRgb("#061b31"))).toBe("#061b31");
    expect(rgbToHex([0, 0, 0])).toBe("#000000");
    expect(rgbToHex([82.6, 58.4, 252.5])).toBe("#533afd");
  });

  it("converts to OKLab and OKLCh", () => {
    const white = lch("#ffffff");
    expect(white.l).toBeCloseTo(1, 3);
    expect(white.c).toBeCloseTo(0, 3);
    const black = lch("#000000");
    expect(black.l).toBeCloseTo(0, 3);
    const brand = lch("#533afd");
    expect(brand.l).toBeCloseTo(0.521, 2);
    expect(brand.c).toBeCloseTo(0.268, 2);
    expect(brand.h).toBeCloseTo(277.4, 0);
  });

  it("measures perceptual distance, lightness, contrast and hue difference", () => {
    expect(oklabDistance(rgbToOklab([10, 10, 10]), rgbToOklab([10, 10, 10]))).toBe(0);
    expect(oklabDistance(rgbToOklab([0, 0, 0]), rgbToOklab([255, 255, 255]))).toBeCloseTo(1, 3);
    expect(lstar([255, 255, 255])).toBeCloseTo(100, 1);
    expect(lstar([0, 0, 0])).toBe(0);
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBe(1);
    expect(hueDiff(350, 10)).toBe(20);
    expect(hueDiff(10, 190)).toBe(180);
  });

  it("classifies neutrals in OKLCh with a tint tolerance for darks and near-whites", () => {
    expect(isNeutral(lch("#061b31"))).toBe(true);
    expect(isNeutral(lch("#533afd"))).toBe(false);
    expect(isNeutral(lch("#808080"))).toBe(true);
    expect(isNeutral(lch("#f5f7fa"))).toBe(true);
    expect(isNeutral(lch("#1ed760"))).toBe(false);
  });
});
