import type { Asset, AssetFormat } from "@/lib/contract";
import { sniffContentType } from "@/server/security/sniff";
import { agentLimits } from "./limits";
import { type ImageFingerprint, canonicalizeSvg, fingerprint, sameVisual, sha1 } from "./hash";
import type { DropReason, Selection, SelectionBudget, SelectionOptions } from "./types";

/**
 * What a download actually takes (spec 4). The `deck` profile drops what is not usable, in this order: role filter,
 * size gate, per-file ceiling, prefer vector, exact duplicates, near duplicates, cap, byte budget. `all` keeps
 * everything the explicit filters allow, minus byte-identical copies, the cap and the byte budget. Every drop is
 * counted under its reason, so a caller can say why it did not take something.
 *
 * The file count cap used to be the only bound on a download, which says nothing about what lands on a disk: the cap is
 * the same 60 files whether they are 60 wordmarks or 60 photographs, so `get` with no filters was an unbounded number
 * of megabytes. The byte budget is the bound that was missing, and the per-file ceiling is what keeps one hero
 * photograph from spending it alone.
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
 * What one asset weighs, best answer first: the bytes in hand, then what the scan measured, then what the source it
 * would be fetched from declared, then the markup it carries itself. 0 means "not known", and nothing is ever dropped
 * for a size nobody measured: the second pass runs with the bytes in hand, so a file that turns out to be too big is
 * dropped then rather than guessed at now.
 */
function assetBytes(asset: Asset, bytes?: ReadonlyMap<string, Buffer>): number {
  const fetched = bytes?.get(asset.id);
  if (fetched) return fetched.length;
  const inline = asset.inline;
  if (inline) return "text" in inline ? Buffer.byteLength(inline.text, "utf8") : Math.floor((inline.base64.length * 3) / 4);
  return asset.bytes ?? (asset.original ?? asset.display)?.bytes ?? 0;
}

/**
 * A limit the caller may raise or lift: a whole number above 0 is the limit, exactly 0 lifts it, and anything else,
 * `undefined` or a number that is not one, takes `fallback`. Lifting a budget is a thing a caller says deliberately,
 * so a NaN from a JSON body reads as "the default" rather than as "no limit at all".
 */
const limitOf = (asked: number | undefined, fallback: number): number =>
  asked === 0 ? 0
  : asked !== undefined && Number.isSafeInteger(asked) && asked > 0 ? asked
  : fallback;

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
  /** Stops the near duplicate pass: the images not fingerprinted by then are compared with nothing, and kept. */
  signal?: AbortSignal,
): Promise<Selection> {
  const dropped: Partial<Record<DropReason, number>> = {};
  const drop = (reason: DropReason, count = 1): false => {
    if (count > 0) dropped[reason] = (dropped[reason] ?? 0) + count;
    return false;
  };
  const duplicates: { keptId: string; droppedIds: string[] }[] = [];
  const profile = options.profile ?? "deck";
  // The `all` profile has no ceiling of its own, because it is the profile that means "give me what is there", but a
  // caller naming a number gets it under either profile. The total budget applies to both: it is the bound on what a
  // download writes, not a taste rule about what a deck can use.
  const maxFileBytes = limitOf(options.maxFileBytes, profile === "deck" ? agentLimits.maxFileBytes : 0);
  const maxTotalBytes = limitOf(options.maxTotalBytes, agentLimits.maxTotalBytes);

  let pool = assets.filter((asset) => isAvailable(asset) || drop("unavailable"));

  /**
   * The tail both paths end on: sort by relevance, cap, spend the byte budget on the best of what is left, and report
   * only the duplicate groups whose winner survived. `applied` is what the byte rules actually were for this call, so a
   * call naming ids reports none of them: an asset the caller asked for by id is never dropped for its size (spec 4,
   * explicit ids win over every filter and every profile rule), and the manifest should not claim a ceiling it skipped.
   */
  const finish = (selected: Asset[], applied: Pick<SelectionBudget, "maxTotalBytes" | "maxFileBytes">): Selection => {
    const sorted = selected.sort(byRelevance);
    const max = options.max ?? agentLimits.maxFiles;
    const capped = capByKind(sorted, Math.max(0, max));
    drop("cap", sorted.length - capped.length);
    const keep = withinBudget(capped, applied.maxTotalBytes, bytes, drop);
    const kept = new Set(keep.map((asset) => asset.id));
    const budget: SelectionBudget = { ...applied, keptBytes: keep.reduce((total, asset) => total + assetBytes(asset, bytes), 0) };
    return { keep, dropped, duplicates: duplicates.filter((group) => kept.has(group.keptId)), budget };
  };

  // Explicit ids win over every filter and every profile rule (spec 4). The cap is not one of those: it is the only
  // guard on how many files one download writes, and on the MCP `download_assets` surface the ids come straight from an
  // agent, so a request naming four thousand of them is capped and reported under `cap` like any other. A caller that
  // means to take more says so with `max`.
  if (options.ids) {
    const wanted = new Set(options.ids);
    const named = pool.filter((asset) => wanted.has(asset.id));
    drop("filter", pool.length - named.length);
    return finish(named, { maxTotalBytes: 0, maxFileBytes: 0 });
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

  // The per-file ceiling, the size gate's opposite end. A 12 MB PNG of a photograph is not an asset a deck can use, and
  // left in it spends the whole byte budget on one file. It runs on whatever size is known at this point: the scan's own
  // measure on the first pass, so the bytes are never spent, and the real length on the second, so a URL that answered
  // with more than it declared is still dropped before it is written.
  if (maxFileBytes > 0) {
    pool = pool.filter((asset) => {
      const size = assetBytes(asset, bytes);
      return size === 0 || size <= maxFileBytes || drop("too-large");
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
      if (!buffer) return null;
      // SVG markup is hashed with its ids renumbered, so the same component rendered twice is one file rather than two:
      // the near-duplicate pass below only reads rasters, and raw bytes differ for every framework-generated id. The
      // bytes decide, not `asset.kind`, so a vector and a raster serving the same markup still group together.
      const svg = sniffContentType(buffer) === "image/svg+xml";
      return sha1(svg ? Buffer.from(canonicalizeSvg(buffer.toString("utf8")), "utf8") : buffer);
    }, "duplicate", drop, duplicates);

    if (profile === "deck") {
      const rasters = pool.filter((asset) => asset.kind === "image" && bytes.has(asset.id));
      pool = nearDuplicates(pool, await fingerprintAll(rasters, bytes, signal), drop, duplicates);
    }
  }

  return finish(pool, { maxTotalBytes, maxFileBytes });
}

/**
 * The byte budget of a selection: the best scoring files that fit, in relevance order. A file too big for what is left
 * is passed over rather than ending the list, so one 6 MB illustration in the middle of the order does not cost a
 * caller the twenty wordmarks under it, and the cheapest useful files are the ones a truncated budget keeps.
 *
 * A size nobody measured counts as 0 here, which is the same direction the rest of the selection takes: an unmeasured
 * asset is kept and the second pass, which has the bytes, is where it meets the budget for real.
 */
function withinBudget(
  sorted: Asset[],
  maxTotalBytes: number,
  bytes: ReadonlyMap<string, Buffer> | undefined,
  drop: (reason: DropReason, count?: number) => false,
): Asset[] {
  if (maxTotalBytes <= 0) return sorted;
  const keep: Asset[] = [];
  let spent = 0;
  for (const asset of sorted) {
    const size = assetBytes(asset, bytes);
    if (spent + size > maxTotalBytes) {
      drop("over-budget");
      continue;
    }
    spent += size;
    keep.push(asset);
  }
  return keep;
}

/**
 * The cap of spec 4.6, with each kind keeping its share of the pool (review issue 5). A plain prefix of the relevance
 * order emptied the download of pictures: the v1 score ranks every role-logo vector above every photo, so on a real page
 * (stripe.com, 149 assets surviving the deck filters) the top 60 were 59 SVG and 1 image, and 45 rasters of 600 px and up
 * were dropped under `cap`, half the kept vectors being unnamed fragments and four of them a single solid rectangle.
 *
 * Each kind therefore gets `floor(max * its share)` of the cap, filled in relevance order, and the slots left over by
 * rounding or by a kind with fewer files than its share go to the most relevant of whatever remains, whatever its kind.
 * The output keeps the relevance order, so the rule is invisible to a caller reading the list.
 */
function capByKind(sorted: Asset[], max: number): Asset[] {
  if (sorted.length <= max) return sorted;
  const kept = new Set<string>();
  for (const kind of ["svg", "image"] as const) {
    const ofKind = sorted.filter((asset) => asset.kind === kind);
    const quota = Math.floor((max * ofKind.length) / sorted.length);
    for (const asset of ofKind.slice(0, quota)) kept.add(asset.id);
  }
  for (const asset of sorted) {
    if (kept.size >= max) break;
    kept.add(asset.id);
  }
  return sorted.filter((asset) => kept.has(asset.id));
}

/**
 * Fingerprints the rasters, `downloadConcurrency` at a time. `fingerprint` waits for the process-wide render slot as
 * well, so this bound is about how many buffers are queued rather than how many decodes run at once: one unbounded
 * `Promise.all` over `maxFiles` rasters spent 25 s of CPU and 576 MB of peak RSS in a single burst, on the same function
 * that drives Chromium and whose thread pool `dns.lookup` shares (review issue 3).
 */
async function fingerprintAll(rasters: Asset[], bytes: ReadonlyMap<string, Buffer>, signal?: AbortSignal): Promise<Map<string, ImageFingerprint>> {
  const prints = new Map<string, ImageFingerprint>();
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (signal?.aborted) return;
      const asset = rasters[cursor++];
      if (asset === undefined) return;
      const buffer = bytes.get(asset.id);
      if (buffer === undefined) continue;
      const print = await fingerprint(buffer);
      if (print !== null) prints.set(asset.id, print);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(agentLimits.downloadConcurrency, rasters.length)) }, worker));
  return prints;
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
