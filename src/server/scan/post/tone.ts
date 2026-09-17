import sharp from "sharp";
import type { Tone } from "@/lib/contract";
import { untilAborted } from "@/server/async";
import { limits } from "@/server/config/limits";
import { formatFromContentType, sniffFormat } from "./format";

/**
 * Preview tone (spec 8.8): decides the background of a tile. Rasters are reduced to 32 px, SVGs rendered at 64 px.
 * A mean alpha of at least 0.98 is `opaque`, rather than a count of opaque pixels: the soft edge that downscaling adds
 * to a fully covered image, or a uniform 99 percent alpha, does not count as transparency. Otherwise the alpha-weighted mean luminance (Rec. 709) of the visible pixels gives `light`
 * above 0.7, `dark` below 0.3 and `mixed` in between.
 */

const RASTER_SIZE = 32;
const SVG_SIZE = 64;
const MAX_INPUT_PIXELS = 8192 * 8192;
/**
 * sharp calls in flight at once across the process, capture and post-processing and every scan together. sharp runs
 * them on the libuv thread pool (4 threads by default), which DNS lookups (`dns.lookup` in `safeFetch` and the egress
 * proxy) and fs calls share. Neither sharp nor a timeout can stop a librsvg render, and a page chooses how slow its SVGs
 * are, so a render keeps its slot until it really ends, even once its budget gave up on it: the other threads stay free.
 */
const RENDER_CONCURRENCY = 2;

let renders = 0;
let rendersStarted = 0;
const waiting: (() => void)[] = [];

/** sharp calls in flight, and started since the process began. For tests. */
export const toneRenderStats = () => ({ active: renders, started: rendersStarted });

/** Waits for a render slot. Resolves false, without a slot, when `signal` aborts first. */
function acquireRender(signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  if (renders < RENDER_CONCURRENCY) {
    renders++;
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const onAbort = () => {
      const index = waiting.indexOf(start);
      if (index >= 0) waiting.splice(index, 1);
      resolve(false);
    };
    const start = () => {
      signal?.removeEventListener("abort", onAbort);
      renders++;
      resolve(true);
    };
    waiting.push(start);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Runs `work` in a render slot, or gives `unknown` without running it when `signal` aborts first. */
async function rendered(work: () => Promise<Tone>, signal?: AbortSignal): Promise<Tone> {
  if (!(await acquireRender(signal))) return "unknown";
  try {
    if (signal?.aborted) return "unknown";
    rendersStarted++;
    return await work();
  } catch {
    return "unknown";
  } finally {
    renders--;
    waiting.shift()?.();
  }
}

async function toneOf(image: ReturnType<typeof sharp>, size: number): Promise<Tone> {
  const { data, info } = await image
    .resize(size, size, { fit: "inside" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const channels = info.channels;
  let pixels = 0;
  let alphaSum = 0;
  let luminanceSum = 0;
  for (let i = 0; i + channels - 1 < data.length; i += channels) {
    pixels++;
    const alpha = data[i + channels - 1] / 255;
    if (alpha === 0) continue;
    const luminance = channels >= 4 ? (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255 : data[i] / 255;
    alphaSum += alpha;
    luminanceSum += alpha * luminance;
  }
  if (!pixels || alphaSum === 0) return "unknown";
  if (alphaSum / pixels >= 0.98) return "opaque";
  const mean = luminanceSum / alphaSum;
  return mean > 0.7 ? "light" : mean < 0.3 ? "dark" : "mixed";
}

const isJpeg = (buffer: Buffer, contentType: string) =>
  formatFromContentType(contentType, "") === "jpg" || sniffFormat(buffer.subarray(0, 16)) === "jpg";

const isSvg = (buffer: Buffer, contentType: string) =>
  formatFromContentType(contentType, "") === "svg" || sniffFormat(buffer.subarray(0, 1024)) === "svg";

/** Tone of SVG markup. `signal` only matters while the render waits for a slot: once started, a render runs to its end. */
export function toneFromSvg(markup: string, signal?: AbortSignal): Promise<Tone> {
  return rendered(async () => {
    const input = Buffer.from(markup);
    // Render close to the preview size instead of rendering the declared size and downscaling it.
    const { width, height } = await sharp(input, { limitInputPixels: false }).metadata();
    const density = width && height ? Math.min(Math.max((72 * SVG_SIZE) / Math.max(width, height), 1), 10_000) : 72;
    return toneOf(sharp(input, { density, limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" }), SVG_SIZE);
  }, signal);
}

function toneFromRaster(buffer: Buffer, signal?: AbortSignal): Promise<Tone> {
  return rendered(() => toneOf(sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error", animated: false }), RASTER_SIZE), signal);
}

/** Tone of image bytes, like `toneFromSvg` for `signal`. JPEG needs no render and is always `opaque`. */
export async function toneFromBytes(buffer: Buffer, contentType: string, signal?: AbortSignal): Promise<Tone> {
  if (!buffer.length) return "unknown";
  if (isJpeg(buffer, contentType)) return "opaque";
  if (isSvg(buffer, contentType)) return toneFromSvg(buffer.toString("utf8"), signal);
  return toneFromRaster(buffer, signal);
}

export interface ToneBudget {
  raster(buffer: Buffer, contentType: string): Promise<Tone>;
  svg(markup: string): Promise<Tone>;
}

/**
 * Tone with the scan caps (spec 8.8): at most `maxRasters` rasters and `maxSvgs` SVGs, `maxBytes` per input (and
 * `maxSvgBytes` per SVG, whose markup is never kept past that), and `budgetMs` of tone work in total, then `unknown`.
 *
 * Renders take process-wide slots in call order, so a caller that asks in relevance order tones the most relevant
 * assets first. The clock runs while this budget has renders waiting for a slot or in flight, so the time spent before
 * the first one (fetches, verification) never counts. Once the budget is spent or `signal` aborts, every render of this
 * budget resolves `unknown` and those still waiting for a slot never start. JPEG needs no render and is always `opaque`.
 * `tone` replaces the renderer, for tests.
 */
export function createToneBudget(
  options: {
    maxRasters?: number;
    maxSvgs?: number;
    maxBytes?: number;
    maxSvgBytes?: number;
    budgetMs?: number;
    signal?: AbortSignal;
    tone?: (buffer: Buffer, contentType: string, signal: AbortSignal) => Promise<Tone>;
  } = {},
): ToneBudget {
  const maxRasters = options.maxRasters ?? limits.toneMaxRasters;
  const maxSvgs = options.maxSvgs ?? limits.toneMaxSvgs;
  const maxBytes = options.maxBytes ?? limits.toneMaxBytes;
  const maxSvgBytes = Math.min(maxBytes, options.maxSvgBytes ?? limits.svgMaxBytes);
  const budgetMs = options.budgetMs ?? limits.toneBudgetMs;
  const tone = options.tone ?? toneFromBytes;
  let rasters = 0;
  let svgs = 0;

  const spentBudget = new AbortController();
  const signal = options.signal ? AbortSignal.any([spentBudget.signal, options.signal]) : spentBudget.signal;
  let active = 0;
  let spentMs = 0;
  let busySince = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const run = async (buffer: Buffer, contentType: string): Promise<Tone> => {
    if (signal.aborted || spentMs >= budgetMs) return "unknown";
    if (active++ === 0) {
      busySince = performance.now();
      timer = setTimeout(() => spentBudget.abort(), budgetMs - spentMs);
    }
    try {
      // A render that outlives the budget keeps running and keeps its slot; its result is ignored.
      return await untilAborted(tone(buffer, contentType, signal), signal);
    } catch {
      return "unknown";
    } finally {
      if (--active === 0) {
        clearTimeout(timer);
        spentMs += performance.now() - busySince;
      }
    }
  };

  const svg = (buffer: Buffer): Promise<Tone> | Tone => {
    if (svgs >= maxSvgs || buffer.length > maxSvgBytes) return "unknown";
    svgs++;
    return run(buffer, "image/svg+xml");
  };

  return {
    async svg(markup) {
      return Buffer.byteLength(markup) > maxSvgBytes ? "unknown" : svg(Buffer.from(markup));
    },
    async raster(buffer, contentType) {
      if (!buffer.length || buffer.length > maxBytes) return "unknown";
      if (isJpeg(buffer, contentType)) return "opaque";
      if (isSvg(buffer, contentType)) return svg(buffer);
      if (rasters >= maxRasters) return "unknown";
      rasters++;
      return run(buffer, contentType);
    },
  };
}
