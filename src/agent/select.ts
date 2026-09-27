import type { Asset, AssetFormat } from "@/lib/contract";
import { agentLimits } from "./limits";
import { type ImageFingerprint, fingerprint, sameVisual, sha1 } from "./hash";
import type { DropReason, Selection, SelectionOptions } from "./types";

/**
 * What a download actually takes (spec 4). The `deck` profile drops what is not usable, in this order: role filter,
 * size gate, prefer vector, exact duplicates, near duplicates, cap. `all` keeps everything the explicit filters allow,
 * minus byte-identical copies and the cap. Every drop is counted under its reason, so a caller can say why it did not
 * take something.
 */

/** Which file wins inside a group of duplicates, best first (spec 4.4). */
const FORMAT_ORDER: AssetFormat[] = ["svg", "png", "webp", "avif", "jpg", "gif"];

/** Roles the size gate never applies to: a logo is useful at any size (spec 4.2). */
const SIZE_EXEMPT_ROLES = new Set(["site-logo", "logo", "favicon"]);

/** Suffixes a served variant adds to the same picture (spec 4.3). */
const VARIANT_SUFFIX =
  /[@._-](?:\d+x|\d{2,5}x\d{2,5}|large|larger|small|smaller|medium|thumb|thumbnail|scaled|resized|full|original|orig|min|hd|retina|mobile|tablet|desktop)$/;

const formatRank = (format: AssetFormat): number => {
  const rank = FORMAT_ORDER.indexOf(format);
  return rank === -1 ? FORMAT_ORDER.length : rank;
};

const pixelArea = (asset: Asset): number => (asset.width ?? asset.renderedWidth ?? 0) * (asset.height ?? asset.renderedHeight ?? 0);

/** The longest side in pixels, or undefined when the scan never measured the asset. */
const longSide = (asset: Asset): number | undefined => {
  const width = asset.width ?? asset.renderedWidth;
  const height = asset.height ?? asset.renderedHeight;
  return width === undefined && height === undefined ? undefined : Math.max(width ?? 0, height ?? 0);
};

/** Whether the bytes can be had at all: inline markup, a display URL or an original URL. */
const isAvailable = (asset: Asset): boolean => Boolean(asset.inline ?? asset.display?.url ?? asset.original?.url);

/**
 * The name two variants of the same picture share: no extension, no `@2x`, no `-1024x512`, no `_large`, lower case.
 * `logo-dark` keeps its suffix, because a dark variant is a different picture (the perceptual hash decides that one).
 */
export function normalizeAssetName(name: string): string {
  let base = name.trim().toLowerCase().replace(/\.[a-z0-9]{2,5}$/, "");
  for (;;) {
    const stripped = base.replace(VARIANT_SUFFIX, "");
    if (stripped === base) break;
    base = stripped;
  }
  return base.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** The name two files are compared by: the file name when there is one, the asset name otherwise. */
const nameKey = (asset: Asset): string => normalizeAssetName(asset.filename || asset.name);

/** Best first: a vector, then the larger picture, then the better format, then the score the scan gave it. */
const byPreference = (a: Asset, b: Asset): number =>
  Number(b.kind === "svg") - Number(a.kind === "svg") ||
  pixelArea(b) - pixelArea(a) ||
  formatRank(a.format) - formatRank(b.format) ||
  b.score - a.score ||
  a.order - b.order ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The output order: the scan's relevance score, then the order it found the assets in (spec: same input, same output). */
const byRelevance = (a: Asset, b: Asset): number => b.score - a.score || a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export async function selectAssets(
  assets: Asset[],
  options: SelectionOptions = {},
  /** Downloaded bytes by asset id. The byte rules (exact and near duplicates) only run on the ids present here. */
  bytes?: ReadonlyMap<string, Buffer>,
): Promise<Selection> {
  const dropped: Partial<Record<DropReason, number>> = {};
  const drop = (reason: DropReason, count = 1): false => {
    if (count > 0) dropped[reason] = (dropped[reason] ?? 0) + count;
    return false;
  };
  const duplicates: { keptId: string; droppedIds: string[] }[] = [];
  const profile = options.profile ?? "deck";

  let pool = assets.filter((asset) => isAvailable(asset) || drop("unavailable"));

  // Explicit ids win over every filter and every profile rule.
  if (options.ids) {
    const wanted = new Set(options.ids);
    const named = pool.filter((asset) => wanted.has(asset.id));
    drop("filter", pool.length - named.length);
    return { keep: named.sort(byRelevance), dropped, duplicates };
  }

  const needle = options.nameContains?.toLowerCase();
  pool = pool.filter((asset) => {
    if (options.kinds && !options.kinds.includes(asset.kind)) return drop("filter");
    if (options.roles && !options.roles.includes(asset.role)) return drop("filter");
    if (needle && !`${asset.name} ${asset.filename}`.toLowerCase().includes(needle)) return drop("filter");
    return true;
  });

  if (profile === "deck") {
    pool = pool.filter((asset) => {
      if (asset.role === "sprite-symbol") return drop("sprite");
      if (asset.role === "icon" && options.includeIcons !== true) return drop("icon");
      return true;
    });

    // Only the largest favicon is worth a file.
    const favicons = pool.filter((asset) => asset.role === "favicon").sort(byPreference);
    if (favicons.length > 1) {
      const extra = new Set(favicons.slice(1).map((asset) => asset.id));
      pool = pool.filter((asset) => !extra.has(asset.id) || drop("extra-favicon"));
    }
  }

  // The size gate (spec 4.2), in one place whatever the number came from: `deck` applies its default, and `all` applies
  // only a `minLongSide` the caller asked for. A logo is useful at any size, so the exempt roles pass either way, and a
  // vector has no size to gate on. An explicit number used to filter ahead of this pass, with no role exemption, so a
  // 400x120 logo was kept with the default 600 and dropped when a caller passed 600 itself.
  const gate = options.minLongSide ?? (profile === "deck" ? agentLimits.minLongSide : undefined);
  if (gate !== undefined) {
    pool = pool.filter((asset) => {
      if (asset.kind === "svg" || SIZE_EXEMPT_ROLES.has(asset.role)) return true;
      const side = longSide(asset);
      return side === undefined || side >= gate || drop("small");
    });
  }

  if (profile === "deck") {
    // The same name served as a vector and as a raster: the vector is the one to keep. A name that normalizes to
    // nothing matches nothing, so an unnamed SVG never takes a raster with it.
    const vectorNames = new Set(
      pool.filter((asset) => asset.kind === "svg").map(nameKey).filter((name) => name !== ""),
    );
    pool = pool.filter((asset) => asset.kind === "svg" || !vectorNames.has(nameKey(asset)) || drop("vector-preferred"));
  }

  if (bytes && bytes.size > 0) {
    pool = groupOut(pool, (asset) => {
      const buffer = bytes.get(asset.id);
      return buffer ? sha1(buffer) : null;
    }, "duplicate", drop, duplicates);

    if (profile === "deck") {
      const rasters = pool.filter((asset) => asset.kind === "image" && bytes.has(asset.id));
      const printed = await Promise.all(rasters.map(async (asset) => [asset.id, await fingerprint(bytes.get(asset.id) as Buffer)] as const));
      const prints = new Map(printed.filter((entry): entry is readonly [string, ImageFingerprint] => entry[1] !== null));
      pool = nearDuplicates(pool, prints, drop, duplicates);
    }
  }

  const sorted = pool.sort(byRelevance);
  const max = options.max ?? agentLimits.maxFiles;
  const keep = sorted.slice(0, Math.max(0, max));
  drop("cap", sorted.length - keep.length);

  const kept = new Set(keep.map((asset) => asset.id));
  return { keep, dropped, duplicates: duplicates.filter((group) => kept.has(group.keptId)) };
}

/** Keeps one asset per group key (null means "no key, always kept"), recording the rest under `reason`. */
function groupOut(
  pool: Asset[],
  keyOf: (asset: Asset) => string | null,
  reason: DropReason,
  drop: (reason: DropReason, count?: number) => false,
  duplicates: { keptId: string; droppedIds: string[] }[],
): Asset[] {
  const groups = new Map<string, Asset[]>();
  for (const asset of pool) {
    const key = keyOf(asset);
    if (key === null) continue;
    const group = groups.get(key);
    if (group) group.push(asset);
    else groups.set(key, [asset]);
  }
  const losers = new Set<string>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const [best, ...rest] = [...group].sort(byPreference);
    for (const asset of rest) losers.add(asset.id);
    duplicates.push({ keptId: best.id, droppedIds: rest.sort(byRelevance).map((asset) => asset.id) });
    drop(reason, rest.length);
  }
  return pool.filter((asset) => !losers.has(asset.id));
}

/**
 * Groups rasters whose fingerprints read as the same picture, keeping the preferred one of each group. A raster with no
 * fingerprint (bytes that do not decode, or a field with too little contrast to group on) leads no group and joins
 * none: it is kept, because refusing to download a distinct asset costs more than one duplicate on disk.
 */
function nearDuplicates(
  pool: Asset[],
  prints: Map<string, ImageFingerprint>,
  drop: (reason: DropReason, count?: number) => false,
  duplicates: { keptId: string; droppedIds: string[] }[],
): Asset[] {
  const distance = agentLimits.nearDuplicateDistance;
  const leaders: { asset: Asset; print: ImageFingerprint; followers: Asset[] }[] = [];
  const losers = new Set<string>();
  for (const asset of [...pool].sort(byPreference)) {
    const print = prints.get(asset.id);
    if (!print) continue;
    const leader = leaders.find((candidate) => sameVisual(candidate.print, print, distance));
    if (!leader) {
      leaders.push({ asset, print, followers: [] });
      continue;
    }
    leader.followers.push(asset);
    losers.add(asset.id);
  }
  for (const leader of leaders) {
    if (leader.followers.length === 0) continue;
    duplicates.push({ keptId: leader.asset.id, droppedIds: leader.followers.sort(byRelevance).map((asset) => asset.id) });
    drop("near-duplicate", leader.followers.length);
  }
  return pool.filter((asset) => !losers.has(asset.id));
}
