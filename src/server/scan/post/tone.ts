import sharp from "sharp";
import type { Tone } from "@/lib/contract";
import { limits } from "@/server/config/limits";
import { formatFromContentType, sniffFormat } from "./format";

/**
 * Preview tone (spec 8.8): decides the background of a tile. Rasters are reduced to 32 px, SVGs rendered at 64 px.
 * At least 98 percent opaque pixels is `opaque`; otherwise the alpha-weighted mean luminance (Rec. 709) of the visible
 * pixels gives `light` above 0.7, `dark` below 0.3 and `mixed` in between.
 */

const RASTER_SIZE = 32;
const SVG_SIZE = 64;
const MAX_INPUT_PIXELS = 8192 * 8192;

async function toneOf(image: ReturnType<typeof sharp>, size: number): Promise<Tone> {
  const { data, info } = await image
    .resize(size, size, { fit: "inside" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const channels = info.channels;
  let pixels = 0;
  let opaque = 0;
  let alphaSum = 0;
  let luminanceSum = 0;
  for (let i = 0; i + channels - 1 < data.length; i += channels) {
    pixels++;
    const alpha = data[i + channels - 1] / 255;
    if (alpha >= 254 / 255) opaque++;
    if (alpha === 0) continue;
    const luminance = channels >= 4 ? (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255 : data[i] / 255;
    alphaSum += alpha;
    luminanceSum += alpha * luminance;
  }
  if (!pixels) return "unknown";
  if (opaque / pixels >= 0.98) return "opaque";
  if (alphaSum === 0) return "unknown";
  const mean = luminanceSum / alphaSum;
  return mean > 0.7 ? "light" : mean < 0.3 ? "dark" : "mixed";
}

const isJpeg = (buffer: Buffer, contentType: string) =>
  formatFromContentType(contentType, "") === "jpg" || sniffFormat(buffer.subarray(0, 16)) === "jpg";

const isSvg = (buffer: Buffer, contentType: string) =>
  formatFromContentType(contentType, "") === "svg" || sniffFormat(buffer.subarray(0, 1024)) === "svg";

export async function toneFromSvg(markup: string): Promise<Tone> {
  try {
    return await toneOf(sharp(Buffer.from(markup), { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" }), SVG_SIZE);
  } catch {
    return "unknown";
  }
}

export async function toneFromBytes(buffer: Buffer, contentType: string): Promise<Tone> {
  if (!buffer.length) return "unknown";
  if (isJpeg(buffer, contentType)) return "opaque";
  if (isSvg(buffer, contentType)) return toneFromSvg(buffer.toString("utf8"));
  try {
    return await toneOf(sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error", animated: false }), RASTER_SIZE);
  } catch {
    return "unknown";
  }
}

export interface ToneBudget {
  raster(buffer: Buffer, contentType: string): Promise<Tone>;
  svg(markup: string): Promise<Tone>;
}

/** Tone with the scan caps: at most `maxRasters` rasters, `maxSvgs` SVGs, `maxBytes` per input and `budgetMs` in total. */
export function createToneBudget(
  options: { maxRasters?: number; maxSvgs?: number; maxBytes?: number; budgetMs?: number; now?: () => number } = {},
): ToneBudget {
  const now = options.now ?? Date.now;
  const maxRasters = options.maxRasters ?? limits.toneMaxRasters;
  const maxSvgs = options.maxSvgs ?? limits.toneMaxSvgs;
  const maxBytes = options.maxBytes ?? limits.toneMaxBytes;
  const deadline = now() + (options.budgetMs ?? limits.toneBudgetMs);
  let rasters = 0;
  let svgs = 0;
  return {
    async raster(buffer, contentType) {
      if (!buffer.length || buffer.length > maxBytes || now() > deadline) return "unknown";
      if (isJpeg(buffer, contentType)) return "opaque";
      if (isSvg(buffer, contentType)) return this.svg(buffer.toString("utf8"));
      if (rasters >= maxRasters) return "unknown";
      rasters++;
      return toneFromBytes(buffer, contentType);
    },
    async svg(markup) {
      if (svgs >= maxSvgs || Buffer.byteLength(markup) > maxBytes || now() > deadline) return "unknown";
      svgs++;
      return toneFromSvg(markup);
    },
  };
}
