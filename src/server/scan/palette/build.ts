/**
 * Palette post-processing: screenshot quantization, per-source normalization, perceptual clustering, scoring and
 * role labeling. Port of the validated lab code (v2, every fix enabled).
 */
import type { Palette, Swatch } from "@/lib/contract";
import {
  contrastRatio, hexToRgb, hueDiff, isNeutral, lstar, oklabDistance, oklabToLch, rgbToHex, rgbToOklab,
  type Lab, type LCh,
} from "./color";
import type { Pixels } from "./png";
import { dropBlends, quantize, ringColor, smoothness } from "./quantize";
import type { MediaRect, PaletteSource, RawPaletteSignals, RectTuple } from "./signals";

export interface PaletteConfig {
  /** Weight of each source's share when ranking chromatic (brand) colors. */
  brandWeights: Partial<Record<PaletteSource, number>>;
  /** Weight of each source's share when ranking neutrals. */
  neutralWeights: Partial<Record<PaletteSource, number>>;
  /** Media kinds masked out of the screenshot histograms. Video and canvas stay in: they hold motion brand graphics. */
  maskKinds: MediaRect[4][];
  /** Chromatic merge: OKLab distance (lightness halved) and hue difference in degrees. */
  chromaMergeDist: number;
  chromaMergeHue: number;
  /** Neutral merge distance in CIE L*, dark (L* under 30) and light range. */
  neutralMergeDark: number;
  neutralMergeLight: number;
  minBrandScore: number;
  minBrandRel: number;
  singleFamilyMinScore: number;
  maxBrand: number;
  /** Neutral slots, plus one for a neutral covering at least 20 percent of the viewport. */
  maxNeutral: number;
}

export const DEFAULT_CONFIG: PaletteConfig = {
  brandWeights: { cta: 3, logo: 2, icon: 1, meta: 1, var: 1.5, link: 1, bg: 1, text: 0.5, grad: 0.5, svg: 0.5, border: 0.3, shot: 0.8 },
  neutralWeights: { bg: 1, text: 1, pix: 0.6, border: 0.15, cta: 0.3, svg: 0.1, logo: 0.2 },
  maskKinds: ["img", "bgimg", "iframe"],
  chromaMergeDist: 0.09,
  chromaMergeHue: 14,
  neutralMergeDark: 11,
  neutralMergeLight: 2,
  minBrandScore: 0.1,
  minBrandRel: 0.02,
  singleFamilyMinScore: 0.2,
  maxBrand: 6,
  maxNeutral: 4,
};

export type PaletteRole = "primary" | "accent" | "background" | "text" | null;

export interface PaletteColor {
  hex: string;
  kind: "brand" | "neutral";
  role: PaletteRole;
  /** 0..1 relative to the strongest color of the same kind. */
  score: number;
  /** Raw score, comparable across sites (a brand color at 0.3 or more is a solid signal). */
  weight: number;
  /** Sources that contributed, strongest share first. */
  sources: PaletteSource[];
  /** OKLCh: L 0..1, C, h in degrees. */
  oklch: [number, number, number];
  /** Site colors merged into this entry, the representative first. */
  variants: string[];
}

export interface BuiltPalette {
  /** Brand colors (primary first, then by score), then neutrals (background, text, surface, muted, fill). */
  colors: PaletteColor[];
  brand: string[];
  neutrals: string[];
  confidence: "high" | "medium" | "low";
}

type Shares = Partial<Record<PaletteSource, number>>;

interface Cluster {
  hex: string;
  lab: Lab;
  lch: LCh;
  /** CIE L* of the representative. */
  L: number;
  neutral: boolean;
  share: Shares;
  members: string[];
  memberShares: Shares[];
  varName: number;
  score: number;
}

/** Favicon generator boilerplate (realfavicongenerator Windows tiles, Safari mask-icon default): not brand evidence. */
const GENERATOR_DEFAULTS = new Set([
  "#da532c", "#2b5797", "#00aba9", "#2d89ef", "#b91d47", "#9f00a7", "#603cba", "#ffc40d", "#ee1111", "#00a300", "#1e7145",
  "#7e3878", "#5bbad5",
]);

/** Independent evidence families: a color seen through a single family must score higher to be kept. */
const FAMILY: Partial<Record<PaletteSource, string>> = {
  var: "declared", meta: "declared", icon: "declared", logo: "identity", cta: "action",
  text: "content", link: "content", svg: "content", border: "content", bg: "surface", grad: "surface", shot: "pixels",
};

/** Sources that prove a color is painted on the page. */
const RENDERED: PaletteSource[] = ["bg", "text", "border", "svg", "cta", "link", "grad", "logo"];

const EPS = 0.004;

const oklabOf = (hex: string) => rgbToOklab(hexToRgb(hex));
const lchOf = (hex: string) => oklabToLch(oklabOf(hex));

export function buildPalette(sig: RawPaletteSignals, pixels: Pixels | null, cfg: PaletteConfig = DEFAULT_CONFIG): BuiltPalette {
  const raw: [PaletteSource, string, number][] = sig.samples.map((s) => [s[0], s[1], s[2]]);
  const varName = new Map<string, number>();
  for (const v of sig.vars) {
    raw.push(["var", v[1], v[2]]);
    varName.set(v[1], Math.max(varName.get(v[1]) ?? 0, v[2]));
  }
  const m = sig.meta;
  const metaColors: [string | null, number][] = [[m.themeColor, 1], [m.maskIconColor, 1], [m.tileColor, 0.6], [m.manifestTheme, 1]];
  for (const [color, weight] of metaColors) {
    if (color && !GENERATOR_DEFAULTS.has(color.toLowerCase())) raw.push(["meta", color.toLowerCase(), weight]);
  }

  /** Unmasked fraction of the viewport (`pix` shares are relative to it). */
  let coverage = 1;
  /** Pooled vivid screenshot color -> viewport share. */
  const vivid = new Map<string, number>();
  if (pixels) {
    const scale = pixels.width / sig.vw;
    // A smooth CSS background image covering the viewport is the page background (Discord), not a photo
    const isBackdrop = (r: MediaRect) =>
      r[4] === "bgimg" && r[2] * r[3] >= 0.9 * sig.vw * sig.vh && smoothness(pixels, [r[0], r[1], r[2], r[3]], scale) >= 0.85;
    const masks = sig.mediaRects.filter((r) => cfg.maskKinds.includes(r[4]) && !isBackdrop(r)).map((r): RectTuple => [r[0], r[1], r[2], r[3]]);
    const q = quantize(pixels, { scale, masks, minShare: 0 });
    coverage = q.coverage;
    for (const [hex, share] of q.masked) if (share >= 0.002) raw.push(["pix", hex, share]);

    // A glow or gradient spreads its vivid pixels over dozens of 5-bit bins, each under the 0.2 percent floor, and the
    // surviving bins are its dark falloff (Framer). Pool vivid pixels (C >= 0.12, L >= 0.3) per hue group (a peak 20 degree
    // bucket and its neighbors); a group covering at least 4 percent of the viewport becomes one sample at its mean color.
    const pooled = new Set<string>();
    const shareOf = new Map(q.masked);
    const buckets: [number, string[]][] = Array.from({ length: 18 }, () => [0, []]);
    for (const [hex, share] of q.masked) {
      const p = lchOf(hex);
      if (p.c < 0.12 || p.l < 0.3) continue;
      const bucket = buckets[Math.round(p.h / 20) % 18];
      bucket[0] += share;
      bucket[1].push(hex);
    }
    // Peaks first; a group is a peak bucket plus its unclaimed neighbors, so distinct hues are never averaged
    const claimed = new Set<number>();
    for (const k of [...buckets.keys()].sort((a, b) => buckets[b][0] - buckets[a][0])) {
      if (claimed.has(k) || buckets[k][0] * coverage < 0.003) continue;
      const group = [k, (k + 17) % 18, (k + 1) % 18].filter((j) => !claimed.has(j) && buckets[j][0] > 0);
      for (const j of group) claimed.add(j);
      const total = group.reduce((sum, j) => sum + buckets[j][0], 0);
      if (total * coverage < 0.04) continue;
      // Mean weighted towards the most chromatic pixels (the glow's core, not its falloff)
      let weight = 0;
      const acc = [0, 0, 0];
      for (const j of group) {
        for (const hex of buckets[j][1]) {
          const rgb = hexToRgb(hex), c = oklabToLch(rgbToOklab(rgb)).c, w = (shareOf.get(hex) ?? 0) * c * c;
          weight += w;
          acc[0] += rgb[0] * w; acc[1] += rgb[1] * w; acc[2] += rgb[2] * w;
        }
      }
      const mean = rgbToHex([acc[0] / weight, acc[1] / weight, acc[2] / weight]);
      raw.push(["shot", mean, total * coverage * Math.min(1.5, lchOf(mean).c / 0.15)]);
      vivid.set(mean, total * coverage);
      for (const j of group) for (const hex of buckets[j][1]) pooled.add(hex);
    }
    for (const [hex, share] of q.masked) {
      if (share < 0.002 || pooled.has(hex)) continue;
      // Vivid pixels are what a designer notices; dull and dark pixels (photos, shadows, falloff) count less
      const p = lchOf(hex);
      raw.push(["shot", hex, share * Math.min(1.5, p.c / 0.15) * (p.l < 0.3 ? 0.3 : 1)]);
    }

    // Raster logos: sample their pixels without the backdrop (the DOM color and what really surrounds the logo on
    // screen, since a background image can hide the DOM color) and without anti-aliasing blends. Shares are relative
    // to the non-backdrop pixels, so small multi-color marks survive (Slack).
    for (const r of sig.logoImageRects) {
      const backs = [sig.logoBackdrop, ringColor(pixels, r, scale)].filter((h): h is string => !!h).map(oklabOf);
      const isBack = (hex: string) => {
        const p = oklabOf(hex);
        return backs.some((b) => oklabDistance(p, b) < 0.06);
      };
      const all = quantize(pixels, { scale, region: r, step: 1, minShare: 0.003 }).all;
      const foreground = all.reduce((sum, [hex, share]) => sum + (isBack(hex) ? 0 : share), 0);
      for (const [hex, share] of dropBlends(all, 6)) {
        if (isBack(hex) || !(foreground > 0) || share / foreground < 0.03) continue;
        raw.push(["logo", hex, share * r[2] * r[3]]);
      }
    }
  }

  // 1. Per-source normalization: share of that source's total weight (neutrals included in the denominator).
  // Screenshot weights are already fractions of the viewport, so they are not renormalized.
  const totals: Shares = {};
  for (const [source, , weight] of raw) totals[source] = (totals[source] ?? 0) + weight;
  if (totals.shot) totals.shot = 1;
  if (totals.pix) totals.pix = 1;
  const byHex = new Map<string, Shares>();
  for (const [source, hex, weight] of raw) {
    const total = totals[source];
    if (!total) continue;
    const entry = byHex.get(hex) ?? {};
    entry[source] = (entry[source] ?? 0) + weight / total;
    byHex.set(hex, entry);
  }

  // 2. Greedy perceptual clustering, most salient color first (it becomes the representative)
  const weigh = (share: Shares, weights: Partial<Record<PaletteSource, number>>) => {
    let sum = 0;
    for (const k of Object.keys(share) as PaletteSource[]) sum += (weights[k] ?? 0) * (share[k] ?? 0);
    return sum;
  };
  const unique = [...byHex.entries()]
    .map(([hex, share]) => {
      const rgb = hexToRgb(hex), lab = rgbToOklab(rgb), lch = oklabToLch(lab), neutral = isNeutral(lch);
      return { hex, share, lab, lch, L: lstar(rgb), neutral, salience: weigh(share, neutral ? cfg.neutralWeights : cfg.brandWeights) };
    })
    .sort((a, b) => b.salience - a.salience);

  const neutralTolerance = (a: { L: number }, b: { L: number }) => (Math.min(a.L, b.L) < 30 ? cfg.neutralMergeDark : cfg.neutralMergeLight);
  const clusters: Cluster[] = [];
  for (const u of unique) {
    let target: Cluster | undefined;
    let bestDistance = Infinity;
    for (const c of clusters) {
      if (c.neutral !== u.neutral) continue;
      let d: number;
      if (u.neutral) {
        d = Math.abs(c.L - u.L);
        if (d > neutralTolerance(c, u) || Math.abs(c.lch.c - u.lch.c) > 0.025) continue;
      } else {
        d = Math.hypot((c.lab.L - u.lab.L) * 0.5, c.lab.a - u.lab.a, c.lab.b - u.lab.b);
        if (d > cfg.chromaMergeDist || hueDiff(c.lch.h, u.lch.h) > cfg.chromaMergeHue) continue;
      }
      if (d < bestDistance) {
        bestDistance = d;
        target = c;
      }
    }
    if (!target) {
      target = { hex: u.hex, lab: u.lab, lch: u.lch, L: u.L, neutral: u.neutral, share: {}, members: [], memberShares: [], varName: 0, score: 0 };
      clusters.push(target);
    }
    target.members.push(u.hex);
    target.memberShares.push(u.share);
    target.varName = Math.max(target.varName, varName.get(u.hex) ?? 0);
    for (const k of Object.keys(u.share) as PaletteSource[]) target.share[k] = (target.share[k] ?? 0) + (u.share[k] ?? 0);
  }

  // Neutral representative: the member carrying most of the cluster's dominant signal (the real body text color).
  // For background clusters, prefer the DOM color visible on screen (Linear #08090a over body #101112): pixel bins
  // are 5-bit means, so a DOM member is credited with the pixels of members within 3 per channel.
  for (const c of clusters) {
    if (!c.neutral || c.members.length < 2) continue;
    let dominant: PaletteSource = "bg", best = -1;
    for (const k of Object.keys(c.share) as PaletteSource[]) {
      const v = (cfg.neutralWeights[k] ?? 0) * (c.share[k] ?? 0);
      if (v > best) {
        best = v;
        dominant = k;
      }
    }
    const rgbs = c.members.map(hexToRgb);
    const key = (shares: Shares, i: number) => {
      if (!(dominant === "bg" && pixels)) return shares[dominant] ?? 0;
      if (!shares.bg) return -1;
      let v = shares.bg;
      c.memberShares.forEach((other, j) => {
        if (Math.max(...rgbs[j].map((x, k) => Math.abs(x - rgbs[i][k]))) <= 3) v += other.pix ?? 0;
      });
      return v;
    };
    let bi = 0;
    c.memberShares.forEach((shares, i) => {
      if (key(shares, i) > key(c.memberShares[bi], bi)) bi = i;
    });
    if (bi) {
      const hex = c.members[bi], rgb = hexToRgb(hex);
      c.members.splice(bi, 1);
      c.members.unshift(hex);
      c.hex = hex;
      c.lab = rgbToOklab(rgb);
      c.lch = oklabToLch(c.lab);
      c.L = lstar(rgb);
    }
  }

  // 3. Scoring
  const sourcesOf = (c: Cluster) => (Object.keys(c.share) as PaletteSource[]).filter((k) => (c.share[k] ?? 0) > EPS);
  const brandScore = (c: Cluster) => {
    let s = weigh(c.share, cfg.brandWeights);
    const sources = sourcesOf(c).filter((k) => k !== "pix");
    const rendered = sources.some((k) => RENDERED.includes(k));
    s *= 1 + 0.2 * Math.max(0, Math.min(sources.length, 6) - 1); // independent signals agree
    if (!rendered) {
      // declared but never painted
      if (sources.length === 1 && sources[0] === "var") s *= c.varName >= 1 ? 0.4 : c.varName >= 0.8 ? 0.15 : 0;
      else s *= 0.5; // only icon, meta, var or screenshot evidence
    }
    if (c.lch.c < 0.08) s *= 0.6; // dull chromatic: usually photo or shadow noise
    return s;
  };
  for (const c of clusters) c.score = c.neutral ? weigh(c.share, cfg.neutralWeights) : brandScore(c);
  // A dark, low-chroma surface in the primary's hue family that is visible on screen is a brand shade (Starbucks
  // #32462f band), not a gray. Text-dominant tints (Stripe navy text) stay neutral.
  const top = clusters.filter((c) => !c.neutral).sort((a, b) => b.score - a.score)[0];
  if (top && top.score >= 0.3) {
    for (const c of clusters) {
      if (!c.neutral || c.lch.c < 0.03 || c.lch.l > 0.6 || hueDiff(c.lch.h, top.lch.h) > 20) continue;
      const surface = (c.share.bg ?? 0) + (c.share.cta ?? 0);
      if ((c.share.pix ?? 0) < 0.02 || surface < 0.1 || surface < (c.share.text ?? 0)) continue;
      c.neutral = false;
      c.score = brandScore(c);
    }
  }

  // 4. Brand selection
  const brandClusters = clusters.filter((c) => !c.neutral).sort((a, b) => b.score - a.score);
  const topBrand = brandClusters[0]?.score ?? 0;
  const families = (c: Cluster) => new Set(sourcesOf(c).map((k) => FAMILY[k]).filter(Boolean)).size;
  // A color only declared (theme-color, variable, favicon), never painted nor seen, is dropped when a painted brand
  // color already leads (Discord theme-color); it is still the fallback when nothing is painted
  const seenOrPainted = (c: Cluster) => sourcesOf(c).some((k) => RENDERED.includes(k)) || (c.share.shot ?? 0) >= 0.01;
  const leadPainted = !!brandClusters[0] && seenOrPainted(brandClusters[0]);
  const vividOf = (c: Cluster) => Math.max(0, ...c.members.map((hex) => vivid.get(hex) ?? 0));
  const brand = brandClusters
    .filter(
      (c) =>
        vividOf(c) >= 0.04 ||
        (c.score >= cfg.minBrandScore &&
          c.score >= cfg.minBrandRel * topBrand &&
          (c === brandClusters[0] || !leadPainted || seenOrPainted(c)) &&
          (families(c) >= 2 || c.score >= cfg.singleFamilyMinScore || c.varName >= 1 || ((c.share.shot ?? 0) >= 0.04 && c.lch.c >= 0.12))),
    )
    .slice(0, cfg.maxBrand);

  // 5. Neutral selection: background, text, dominant, secondary surface, muted text, then fill (L* separated)
  const neutralClusters = clusters.filter((c) => c.neutral && c.score >= 0.02).sort((a, b) => b.score - a.score);
  const roles = new Map<Cluster, PaletteRole>();
  const picked: Cluster[] = [];
  const far = (c: Cluster, min = 0) => picked.every((p) => Math.abs(p.L - c.L) >= Math.max(min, neutralTolerance(p, c)));
  const argmax = (list: Cluster[], key: (c: Cluster) => number) =>
    list.reduce<Cluster | undefined>((best, c) => (!best || key(c) > key(best) ? c : best), undefined);
  // Page background: DOM background area, cross-checked with what is actually on screen
  const bgShare = (c: Cluster) => (c.share.bg ?? 0) + 0.5 * (c.share.pix ?? 0);
  const textShare = (c: Cluster) => c.share.text ?? 0;
  const bg = argmax(neutralClusters, bgShare);
  if (bg && bgShare(bg) >= 0.2) {
    picked.push(bg);
    const next = Math.max(0, ...neutralClusters.filter((c) => c !== bg).map(bgShare));
    const onScreen = !pixels || (bg.share.pix ?? 0) >= 0.1; // visible outside photos too
    if (onScreen && bgShare(bg) >= 0.35 && bgShare(bg) >= 1.3 * next) roles.set(bg, "background");
  }
  // Body text: among heavy text colors (at least half the heaviest), the one contrasting most with the background
  const textPool = neutralClusters.filter((c) => !picked.includes(c) && textShare(c) > 0);
  const maxText = Math.max(0, ...textPool.map(textShare));
  const refBg = bg ?? argmax(neutralClusters, bgShare);
  const text = argmax(
    textPool.filter((c) => textShare(c) >= 0.5 * maxText && (!refBg || contrastRatio(c.hex, refBg.hex) >= 3)),
    (c) => (refBg ? contrastRatio(c.hex, refBg.hex) : 0) + textShare(c),
  );
  if (text && textShare(text) >= 0.03) {
    picked.push(text);
    if (textShare(text) >= 0.2) roles.set(text, "text");
  }
  // A neutral covering at least 20 percent of the visible viewport gets an extra slot (Apple's black hero)
  let extraSlot = 0;
  if (pixels) {
    const dominant = argmax(
      neutralClusters.filter((c) => !picked.includes(c) && (c.share.pix ?? 0) * coverage >= 0.2 && picked.every((p) => Math.abs(p.L - c.L) >= 8)),
      (c) => c.share.pix ?? 0,
    );
    if (dominant) {
      picked.push(dominant);
      extraSlot = 1;
    }
  }
  const surface = argmax(neutralClusters.filter((c) => !picked.includes(c) && bgShare(c) >= 0.04 && far(c, 2)), bgShare);
  if (surface) picked.push(surface);
  const muted = argmax(neutralClusters.filter((c) => !picked.includes(c) && textShare(c) >= 0.05 && far(c, 8)), textShare);
  if (muted) picked.push(muted);
  const maxNeutral = cfg.maxNeutral + extraSlot;
  for (const c of neutralClusters) {
    if (picked.length >= maxNeutral) break;
    if (!picked.includes(c) && far(c)) picked.push(c);
  }
  const neutrals = picked.slice(0, maxNeutral);

  // 6. Brand roles
  if (brand.length) {
    const p = brand[0];
    const backed = (p.share.cta ?? 0) + (p.share.logo ?? 0) + (p.share.link ?? 0) > 0.01 || (p.share.var ?? 0) + (p.share.meta ?? 0) + (p.share.icon ?? 0) > 0.05;
    const lead = brand[1] ? p.score / brand[1].score : Infinity;
    if (backed && p.score >= 0.3 && lead >= 1.25) roles.set(p, "primary");
    for (const b of brand) if (!roles.has(b) && b.score >= 0.2 && sourcesOf(b).some((k) => RENDERED.includes(k))) roles.set(b, "accent");
  }

  const topNeutral = Math.max(...neutrals.map((c) => c.score), 1e-9);
  const toColor = (c: Cluster, topScore: number): PaletteColor => ({
    hex: c.hex,
    kind: c.neutral ? "neutral" : "brand",
    role: roles.get(c) ?? null,
    score: +(c.score / (topScore || 1)).toFixed(3),
    weight: +c.score.toFixed(4),
    sources: sourcesOf(c).sort((a, b) => (c.share[b] ?? 0) - (c.share[a] ?? 0)),
    oklch: [+c.lch.l.toFixed(3), +c.lch.c.toFixed(3), +c.lch.h.toFixed(1)],
    variants: c.members.slice(0, 6),
  });
  const colors = [...brand.map((c) => toColor(c, topBrand)), ...neutrals.map((c) => toColor(c, topNeutral))];
  const primary = colors.find((c) => c.role === "primary");
  const confidence = primary ? (primary.sources.length >= 3 ? "high" : "medium") : brand.length === 0 ? "medium" : "low";
  return {
    colors,
    brand: colors.filter((c) => c.kind === "brand").map((c) => c.hex),
    neutrals: colors.filter((c) => c.kind === "neutral").map((c) => c.hex),
    confidence,
  };
}

/** Contract shape: brand then neutral swatches in palette order, with a role only when one was assigned. */
export function toContractPalette(palette: BuiltPalette): Palette {
  const swatch = (c: PaletteColor): Swatch => (c.role ? { hex: c.hex, role: c.role } : { hex: c.hex });
  return {
    brand: palette.colors.filter((c) => c.kind === "brand").map(swatch),
    neutrals: palette.colors.filter((c) => c.kind === "neutral").map(swatch),
  };
}
