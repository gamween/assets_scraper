import { describe, expect, it } from "vitest";
import { hexToRgb, type RGB } from "./color";
import type { Pixels } from "./png";
import { dropBlends, quantize, ringColor, smoothness } from "./quantize";

const image = (width: number, height: number, paint: (x: number, y: number) => RGB): Pixels => {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data.set([...paint(x, y), 255], (y * width + x) * 4);
  }
  return { width, height, channels: 4, data };
};

const WHITE = hexToRgb("#ffffff");
const BRAND = hexToRgb("#533afd");
/** 70 percent white columns, 30 percent brand columns. */
const split = image(100, 100, (x) => (x < 70 ? WHITE : BRAND));

describe("quantize", () => {
  it("returns each color with its share", () => {
    const { all, masked, coverage } = quantize(split);
    expect(all.map(([hex]) => hex)).toEqual(["#ffffff", "#533afd"]);
    expect(all[0][1]).toBeCloseTo(0.7, 1);
    expect(Math.abs(all[0][1] - 0.7)).toBeLessThanOrEqual(0.02);
    expect(Math.abs(all[1][1] - 0.3)).toBeLessThanOrEqual(0.02);
    expect(masked).toEqual(all);
    expect(coverage).toBe(1);
  });

  it("leaves masked rects out of `masked` but keeps them in `all`", () => {
    const { all, masked, coverage } = quantize(split, { masks: [[70, 0, 30, 100]] });
    expect(all).toHaveLength(2);
    expect(masked).toEqual([["#ffffff", 1]]);
    expect(Math.abs(coverage - 0.7)).toBeLessThanOrEqual(0.02);
  });

  it("scales CSS rects to screenshot pixels and limits the region", () => {
    const { all } = quantize(split, { scale: 2, region: [35, 0, 15, 50], step: 1 });
    expect(all).toEqual([["#533afd", 1]]);
  });

  it("drops bins under the minimum share", () => {
    const dotted = image(100, 100, (x, y) => (x === 0 && y === 0 ? BRAND : WHITE));
    expect(quantize(dotted, { step: 1 }).all).toEqual([["#ffffff", 0.9999]]);
    expect(quantize(dotted, { step: 1, minShare: 0 }).all).toHaveLength(2);
  });

  it("averages the real pixels of a 5-bit bin", () => {
    const noisy = image(10, 10, (x) => (x % 2 ? [200, 16, 32] : [202, 18, 34]));
    expect(quantize(noisy, { step: 1 }).all).toEqual([["#c91121", 1]]);
  });
});

describe("dropBlends", () => {
  it("removes anti-aliasing blends between dominant colors", () => {
    const list: [string, number][] = [["#808080", 0.05], ["#000000", 0.5], ["#ff0000", 0.05], ["#ffffff", 0.4]];
    expect(dropBlends(list)).toEqual([["#000000", 0.5], ["#ffffff", 0.4], ["#ff0000", 0.05]]);
  });

  it("keeps colors when the anchors are too close to define a segment", () => {
    const list: [string, number][] = [["#000000", 0.5], ["#0a0a0a", 0.4], ["#050505", 0.1]];
    expect(dropBlends(list)).toHaveLength(3);
  });

  it("only uses the given number of anchors", () => {
    const list: [string, number][] = [
      ["#ff0000", 0.3], ["#00ff00", 0.25], ["#0000ff", 0.2], ["#000000", 0.15], ["#ffffff", 0.06], ["#7f7f7f", 0.04],
    ];
    expect(dropBlends(list, 4).map(([hex]) => hex)).toContain("#7f7f7f");
    expect(dropBlends(list, 6).map(([hex]) => hex)).not.toContain("#7f7f7f");
  });
});

describe("ringColor", () => {
  it("returns the dominant color just outside a rect", () => {
    const logo = image(100, 100, (x, y) => (x >= 40 && x < 60 && y >= 40 && y < 60 ? BRAND : [128, 128, 128]));
    expect(ringColor(logo, [40, 40, 20, 20], 1)).toBe("#808080");
    expect(ringColor(logo, [20, 20, 10, 10], 2)).toBe("#808080");
  });

  it("ignores the 2 px next to the rect", () => {
    const halo = image(100, 100, (x, y) => (x >= 38 && x < 62 && y >= 38 && y < 62 ? WHITE : [0, 0, 0]));
    expect(ringColor(halo, [40, 40, 20, 20], 1)).toBe("#000000");
  });

  it("returns null when the backdrop is mixed", () => {
    const stripes: RGB[] = [[255, 0, 0], [0, 255, 0], [0, 0, 255]];
    const mixed = image(100, 100, (x, y) => stripes[(x + y) % 3]);
    expect(ringColor(mixed, [40, 40, 20, 20], 1)).toBeNull();
  });

  it("clips the ring to the image", () => {
    const flat = image(20, 20, () => BRAND);
    expect(ringColor(flat, [0, 0, 20, 20], 1)).toBeNull();
    expect(ringColor(flat, [0, 0, 10, 10], 1)).toBe("#533afd");
  });
});

describe("smoothness", () => {
  it("is high for flat fills and gradients and low for noise", () => {
    expect(smoothness(split, [0, 0, 60, 100], 1)).toBe(1);
    const gradient = image(300, 50, (x) => [Math.floor(x / 3), 40, 90]);
    expect(smoothness(gradient, [0, 0, 300, 50], 1)).toBeGreaterThanOrEqual(0.85);
    let seed = 7;
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) >> 16) & 255;
    const noise = image(100, 100, () => [random(), random(), random()]);
    expect(smoothness(noise, [0, 0, 100, 100], 1)).toBeLessThan(0.1);
  });

  it("is 0 for an empty region", () => {
    expect(smoothness(split, [200, 200, 10, 10], 1)).toBe(0);
  });
});
