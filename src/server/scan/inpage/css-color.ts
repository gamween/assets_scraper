/**
 * CSS colors as 8-bit sRGB, for the in-page palette and the collector's wordmark: one reader, so a wordmark run and a
 * palette swatch of the same color always give the same hex. Pure apart from the painter, so Node tests read it with a
 * stand-in for the canvas.
 */

/** Red, green and blue from 0 to 255, alpha from 0 to 1. */
export type RGBA = [number, number, number, number];
export type RGB = [number, number, number];

/** Paints one CSS color and reads it back as sRGB, or null when the browser does not take it as a color. */
export type ColorPainter = (value: string) => RGBA | null;

const RGB_RE = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/;

/** Below this alpha a color paints nothing a reader can see. */
const MIN_ALPHA = 0.02;

/**
 * A painter on a 1x1 canvas: the one converter every browser has for lab(), oklch(), color() and named colors.
 * Tailwind v4 computes its theme colors to lab() and oklch(), which no regex here reads: investirday.fr's accent is
 * `lab(56.2517 80.3767 1.26251)` in its computed style.
 */
export function canvasPainter(doc: Document): ColorPainter {
  const canvas = doc.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  return (value) => {
    if (!ctx || !CSS.supports("color", value)) return null;
    ctx.globalCompositeOperation = "copy";
    ctx.fillStyle = "#000";
    ctx.fillStyle = value;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3] / 255];
  };
}

/**
 * Any CSS color to sRGB plus alpha, or null for none, `transparent`, `currentcolor` and a color under 2 percent alpha.
 * `rgb()` and `rgba()` are read here, since that is what most computed styles hold; everything else goes to `paint`.
 * Raw strings (custom properties, meta colors) can hold channels a browser would clamp or refuse, so they are clamped
 * and checked. Answers are cached per string: a page repeats a handful of colors thousands of times.
 */
export function colorReader(paint: ColorPainter): (value: string | null | undefined) => RGBA | null {
  const cache = new Map<string, RGBA | null>();
  return (value) => {
    if (!value) return null;
    const str = value.trim();
    if (!str || str === "none" || str === "transparent" || str === "currentcolor") return null;
    const hit = cache.get(str);
    if (hit !== undefined) return hit;
    let color: RGBA | null = null;
    const m = RGB_RE.exec(str);
    const channels = m ? [+m[1], +m[2], +m[3]] : [];
    if (m && channels.every((c) => Number.isFinite(c))) {
      const a = m[4] === undefined ? 1 : m[5] ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
      const [r, g, b] = channels.map((c) => Math.min(255, c));
      color = [r, g, b, a];
    } else {
      color = paint(str);
    }
    if (color && color[3] < MIN_ALPHA) color = null;
    cache.set(str, color);
    return color;
  };
}

/** `fg` at `alphaMul` times its own alpha over the opaque `bg`. */
export const over = (fg: RGBA, alphaMul: number, bg: RGB): RGB => {
  const a = Math.max(0, Math.min(1, fg[3] * alphaMul));
  return [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a)];
};

/** `#rrggbb`, alpha ignored. */
export const toHex = (c: RGB | RGBA): string =>
  "#" + ((1 << 24) | (Math.round(c[0]) << 16) | (Math.round(c[1]) << 8) | Math.round(c[2])).toString(16).slice(1);

/** Color functions and hex codes in a CSS value, a gradient's stops among them, in the order they are written. */
export const COLOR_TOKEN_RE = /(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^()]*\)|#[0-9a-fA-F]{3,8}\b/g;
