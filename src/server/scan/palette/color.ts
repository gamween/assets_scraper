/** Color math for the palette: sRGB hex, OKLab/OKLCh, CIE L*, WCAG contrast. */

export type RGB = [r: number, g: number, b: number];
export interface Lab { L: number; a: number; b: number }
export interface LCh { l: number; c: number; h: number }

export const hexToRgb = (hex: string): RGB => {
  const n = parseInt(hex.slice(1, 7), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

export const rgbToHex = (c: RGB): string =>
  "#" + ((1 << 24) | (Math.round(c[0]) << 16) | (Math.round(c[1]) << 8) | Math.round(c[2])).toString(16).slice(1);

const linear = (v: number) => {
  v /= 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

export const rgbToOklab = (c: RGB): Lab => {
  const r = linear(c[0]), g = linear(c[1]), b = linear(c[2]);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
};

export const oklabToLch = (p: Lab): LCh => ({
  l: p.L,
  c: Math.hypot(p.a, p.b),
  h: ((Math.atan2(p.b, p.a) * 180) / Math.PI + 360) % 360,
});

/** Euclidean distance in OKLab (about 0.02 is a just noticeable difference). */
export const oklabDistance = (x: Lab, y: Lab): number => Math.hypot(x.L - y.L, x.a - y.a, x.b - y.b);

const relativeLuminance = (c: RGB) => 0.2126 * linear(c[0]) + 0.7152 * linear(c[1]) + 0.0722 * linear(c[2]);

/** CIE L* (0..100). Used for neutrals: its linear toe does not over-separate near-blacks like OKLab does. */
export const lstar = (c: RGB): number => {
  const y = relativeLuminance(c);
  return y > 0.008856 ? 116 * Math.cbrt(y) - 16 : 903.3 * y;
};

/** WCAG contrast ratio between two hex colors (1..21). */
export const contrastRatio = (x: string, y: string): number => {
  const a = relativeLuminance(hexToRgb(x)), b = relativeLuminance(hexToRgb(y));
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};

/** Low chroma in OKLCh. Darks and near-whites tolerate a tint (navy text, tinted surfaces). */
export const isNeutral = (p: LCh): boolean => p.c < (p.l < 0.3 ? 0.075 : p.l > 0.92 ? 0.04 : 0.048);

/** Smallest angle between two hues, in degrees (0..180). */
export const hueDiff = (a: number, b: number): number => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};
