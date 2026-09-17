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

  it("masks exactly the union of many overlapping, touching and fractional rects", () => {
    let seed = 11;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const noise = image(120, 90, () => [Math.floor(random() * 256), Math.floor(random() * 256), Math.floor(random() * 256)]);
    const masks: [number, number, number, number][] = Array.from({ length: 60 }, () => [random() * 130 - 10, random() * 100 - 10, random() * 40, random() * 30]);
    masks.push([10, 10, 20, 20], [30, 10, 20, 20], [0, 50, 0, 20], [5, 5, -3, 10]);
    const scale = 1.5;
    // Reference: a per-pixel check against every mask
    const counts = new Map<string, number>();
    let total = 0, kept = 0;
    for (let y = 0; y < noise.height; y += 2) {
      for (let x = 0; x < noise.width; x += 2) {
        total++;
        if (masks.some((m) => x >= m[0] * scale && x < (m[0] + m[2]) * scale && y >= m[1] * scale && y < (m[1] + m[3]) * scale)) continue;
        kept++;
        const i = (y * noise.width + x) * 4;
        const key = [noise.data[i] >> 3, noise.data[i + 1] >> 3, noise.data[i + 2] >> 3].join();
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    const { masked, coverage } = quantize(noise, { masks, scale, step: 2, minShare: 0 });
    expect(coverage).toBe(kept / total);
    expect(masked.map(([, share]) => Math.round(share * kept)).sort((a, b) => a - b)).toEqual([...counts.values()].sort((a, b) => a - b));
  });

  it("stays linear in the number of masks", () => {
    const masks = Array.from({ length: 2_000 }, (_, i): [number, number, number, number] => [1 + 3 * (i % 480) + 0.1, 0, 1, 900]);
    const started = performance.now();
    quantize(image(1440, 900, () => WHITE), { masks });
    expect(performance.now() - started).toBeLessThan(500);
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

  it("reads the same band as a check of every pixel around the rect", () => {
    let seed = 5;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    // Two colors, so the dominant one often clears the 40 percent bar
    const twoTone = image(80, 60, () => (random() < 0.7 ? WHITE : BRAND));
    const reference = (r: [number, number, number, number], scale: number) => {
      const counts = new Map<string, number>();
      let n = 0;
      for (let y = Math.max(0, Math.floor((r[1] - 6) * scale)); y < Math.min(60, Math.ceil((r[1] + r[3] + 6) * scale)); y++) {
        for (let x = Math.max(0, Math.floor((r[0] - 6) * scale)); x < Math.min(80, Math.ceil((r[0] + r[2] + 6) * scale)); x++) {
          if (x >= (r[0] - 2) * scale && x < (r[0] + r[2] + 2) * scale && y >= (r[1] - 2) * scale && y < (r[1] + r[3] + 2) * scale) continue;
          const hex = twoTone.data[(y * 80 + x) * 4] === 255 ? "#ffffff" : "#533afd";
          counts.set(hex, (counts.get(hex) ?? 0) + 1);
          n++;
        }
      }
      const [hex, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
      return count >= 0.4 * n ? hex : null;
    };
    for (let k = 0; k < 200; k++) {
      const r: [number, number, number, number] = [random() * 90 - 10, random() * 70 - 10, random() * 30 - 2, random() * 30 - 2];
      const scale = [1, 1.25, 2][k % 3];
      expect(ringColor(twoTone, r, scale)).toBe(reference(r, scale));
    }
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
