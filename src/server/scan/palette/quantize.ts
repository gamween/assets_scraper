import { hexToRgb, rgbToHex } from "./color";
import type { Pixels } from "./png";
import type { RectTuple } from "./signals";

/** 5-bit-per-channel bin key -> [sum r, sum g, sum b, count]. */
type Histogram = Map<number, [number, number, number, number]>;

const binKey = (r: number, g: number, b: number) => ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);

const addToBin = (histogram: Histogram, key: number, r: number, g: number, b: number) => {
  const entry = histogram.get(key);
  if (entry) {
    entry[0] += r; entry[1] += g; entry[2] += b; entry[3]++;
  } else histogram.set(key, [r, g, b, 1]);
};

/** Bins as [mean hex, share], largest first. */
const histogramToList = (histogram: Histogram, total: number, minShare: number): [string, number][] => {
  const out: [string, number][] = [];
  for (const e of histogram.values()) {
    if (total && e[3] / total >= minShare) out.push([rgbToHex([e[0] / e[3], e[1] / e[3], e[2] / e[3]]), e[3] / total]);
  }
  return out.sort((a, b) => b[1] - a[1]);
};

export interface QuantizeOptions {
  /** Sample every `step` screenshot pixels in both directions (default 3). */
  step?: number;
  /** CSS px rects left out of `masked` (kept in `all`). */
  masks?: RectTuple[];
  /** CSS px rect to sample, default the whole image. */
  region?: RectTuple;
  /** Screenshot px per CSS px (default 1). */
  scale?: number;
  /** Bins under this share are dropped (default 0.002). */
  minShare?: number;
}

/**
 * One pass, 5 bits per channel histogram. `coverage` is the unmasked fraction of the sampled pixels, so `masked`
 * shares are relative to the unmasked area. Masks are merged per row into sorted intervals, so the cost is one pass
 * over the sampled pixels plus rows times masks, whatever the masks overlap.
 */
export function quantize(px: Pixels, options: QuantizeOptions = {}) {
  const step = options.step ?? 3, scale = options.scale ?? 1, minShare = options.minShare ?? 0.002;
  const region = options.region;
  const x0 = region ? Math.max(0, Math.floor(region[0] * scale)) : 0;
  const y0 = region ? Math.max(0, Math.floor(region[1] * scale)) : 0;
  const x1 = region ? Math.min(px.width, Math.ceil((region[0] + region[2]) * scale)) : px.width;
  const y1 = region ? Math.min(px.height, Math.ceil((region[1] + region[3]) * scale)) : px.height;
  // [left, top, right, bottom] in screenshot px, left edges ascending
  const masks = (options.masks ?? [])
    .map((r) => [r[0] * scale, r[1] * scale, (r[0] + r[2]) * scale, (r[1] + r[3]) * scale])
    .filter((m) => m[2] > m[0] && m[3] > m[1])
    .sort((a, b) => a[0] - b[0]);
  const all: Histogram = new Map(), masked: Histogram = new Map();
  /** Masked [start, end) intervals of the current row, flattened, disjoint and ascending. */
  const row: number[] = [];
  let nAll = 0, nMasked = 0;
  for (let y = y0; y < y1; y += step) {
    row.length = 0;
    for (const m of masks) {
      if (y < m[1] || y >= m[3]) continue;
      if (row.length && m[0] <= row[row.length - 1]) row[row.length - 1] = Math.max(row[row.length - 1], m[2]);
      else row.push(m[0], m[2]);
    }
    let k = 0;
    for (let x = x0; x < x1; x += step) {
      const i = (y * px.width + x) * px.channels;
      const r = px.data[i], g = px.data[i + 1], b = px.data[i + 2];
      const key = binKey(r, g, b);
      addToBin(all, key, r, g, b);
      nAll++;
      while (k < row.length && x >= row[k + 1]) k += 2;
      if (k >= row.length || x < row[k]) {
        addToBin(masked, key, r, g, b);
        nMasked++;
      }
    }
  }
  return {
    all: histogramToList(all, nAll, minShare),
    masked: histogramToList(masked, nMasked, minShare),
    coverage: nAll ? nMasked / nAll : 0,
  };
}

/** Removes anti-aliasing blends: a minor color lying on the RGB segment between two of the `anchors` dominant colors. */
export function dropBlends(list: [string, number][], anchors = 4): [string, number][] {
  const sorted = [...list].sort((a, b) => b[1] - a[1]);
  const points = sorted.slice(0, anchors).map(([hex, weight]) => [...hexToRgb(hex), weight]);
  return sorted.filter(([hex, weight]) => {
    const x = hexToRgb(hex);
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        const A = points[i], B = points[j];
        if (weight >= Math.min(A[3], B[3])) continue;
        const d = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], l2 = d[0] ** 2 + d[1] ** 2 + d[2] ** 2;
        if (l2 < 900) continue;
        const t = ((x[0] - A[0]) * d[0] + (x[1] - A[1]) * d[1] + (x[2] - A[2]) * d[2]) / l2;
        const distance2 = (A[0] + t * d[0] - x[0]) ** 2 + (A[1] + t * d[1] - x[1]) ** 2 + (A[2] + t * d[2] - x[2]) ** 2;
        if (t > 0.06 && t < 0.94 && distance2 < 500) return false;
      }
    }
    return true;
  });
}

/** Dominant color of a band 2 to 6 CSS px outside a rect (the real backdrop behind a raster logo), or null if mixed. */
export function ringColor(px: Pixels, r: RectTuple, scale: number): string | null {
  const bins: Histogram = new Map();
  let n = 0;
  const x0 = Math.max(0, Math.floor((r[0] - 6) * scale)), x1 = Math.min(px.width, Math.ceil((r[0] + r[2] + 6) * scale));
  const y0 = Math.max(0, Math.floor((r[1] - 6) * scale)), y1 = Math.min(px.height, Math.ceil((r[1] + r[3] + 6) * scale));
  const iy0 = (r[1] - 2) * scale, iy1 = (r[1] + r[3] + 2) * scale;
  // Columns [skipFrom, skipTo) of the rows crossing the inner rect are left out, so only the band is read
  const skipFrom = Math.min(x1, Math.max(x0, Math.ceil((r[0] - 2) * scale)));
  const skipTo = Math.max(skipFrom, Math.min(x1, Math.ceil((r[0] + r[2] + 2) * scale)));
  const add = (x: number, y: number) => {
    const i = (y * px.width + x) * px.channels;
    addToBin(bins, binKey(px.data[i], px.data[i + 1], px.data[i + 2]), px.data[i], px.data[i + 1], px.data[i + 2]);
    n++;
  };
  for (let y = y0; y < y1; y++) {
    const inner = y >= iy0 && y < iy1;
    for (let x = x0; x < (inner ? skipFrom : x1); x++) add(x, y);
    if (inner) for (let x = skipTo; x < x1; x++) add(x, y);
  }
  let best: [number, number, number, number] | null = null;
  for (const e of bins.values()) if (!best || e[3] > best[3]) best = e;
  return best && best[3] >= 0.4 * n ? rgbToHex([best[0] / best[3], best[1] / best[3], best[2] / best[3]]) : null;
}

/**
 * Share of horizontally adjacent samples (3 px apart, every 3 rows) whose channels differ by 6 or less in total:
 * about 0.9 for gradients and flat art, under 0.8 for photos.
 */
export function smoothness(px: Pixels, r: RectTuple, scale: number): number {
  let same = 0, n = 0;
  const x1 = Math.min(px.width - 3, Math.floor((r[0] + r[2]) * scale) - 3);
  const y1 = Math.min(px.height, Math.floor((r[1] + r[3]) * scale));
  for (let y = Math.max(0, Math.floor(r[1] * scale)); y < y1; y += 3) {
    for (let x = Math.max(0, Math.floor(r[0] * scale)); x < x1; x += 3) {
      const i = (y * px.width + x) * px.channels, j = i + 3 * px.channels;
      const diff = Math.abs(px.data[i] - px.data[j]) + Math.abs(px.data[i + 1] - px.data[j + 1]) + Math.abs(px.data[i + 2] - px.data[j + 2]);
      if (diff <= 6) same++;
      n++;
    }
  }
  return n ? same / n : 0;
}
