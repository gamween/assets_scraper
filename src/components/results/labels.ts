import { HiddenReason, type Asset, type FoundIn } from "@/lib/contract";
import { formatBytes, formatCount, formatDimensions } from "@/lib/format";
import { assetBytes, type SectionId } from "@/lib/client/filters";

/**
 * Card badges (spec 12.3): only roles worth calling out, and never the one that repeats the section header above the
 * card. Inside `Logos`, every card would carry a `Logo` badge and none of them would say anything; `Favicon` still
 * does, because that section holds both.
 */
export function roleBadge(asset: Asset, section?: SectionId): string | null {
  switch (asset.role) {
    case "site-logo":
    case "logo":
      return section === "logos" ? null : "Logo";
    case "favicon":
      return "Favicon";
    case "social":
      return "OG image";
    default:
      return null;
  }
}

const ROLE_LABELS: Record<Asset["role"], string> = {
  "site-logo": "Site logo",
  logo: "Logo",
  favicon: "Favicon",
  social: "OG image",
  icon: "Icon",
  illustration: "Illustration",
  image: "Image",
  "sprite-symbol": "Sprite symbol",
};

/** Detail view badge (spec 12.2): every role has one, unlike the card badges. */
export const roleLabel = (asset: Pick<Asset, "role">) => ROLE_LABELS[asset.role];

const isInlineSvg = (asset: Asset) => asset.kind === "svg" && !!asset.inline && "text" in asset.inline;

/** Parts of the card meta line: `SVG · 88×22 · 3.0 KB · Inline`, `JPG · 1200×630 · 352 KB`. */
export function assetMetaParts(asset: Asset): string[] {
  const parts = [asset.format === "other" ? "FILE" : asset.format.toUpperCase()];
  const dims = formatDimensions(asset.original?.width ?? asset.width, asset.original?.height ?? asset.height);
  if (dims) parts.push(dims);
  const bytes = assetBytes(asset);
  if (bytes > 0) parts.push(formatBytes(bytes));
  if (asset.kind === "svg") parts.push(isInlineSvg(asset) ? "Inline" : "File");
  return parts;
}

export const assetMeta = (asset: Asset) => assetMetaParts(asset).join(" · ");

/** Each reason as `[one, many]`: a single hidden file reads `1 hidden: a tracking pixel`, not `1 hidden: tracking pixels`. */
const HIDDEN_PHRASES: Record<HiddenReason, [string, string]> = {
  tracker: ["a tracking pixel", "tracking pixels"],
  pixel: ["a tracking pixel", "tracking pixels"],
  spacer: ["a spacer image", "spacer images"],
  "tiny-data-uri": ["a spacer image", "spacer images"],
  placeholder: ["a placeholder", "placeholders"],
  "not-image": ["a broken file", "broken files"],
  consent: ["a consent banner", "consent banners"],
  widget: ["a third-party widget", "third-party widgets"],
  "probe-failed": ["an unreachable file", "unreachable files"],
  "probe-skipped": ["an unchecked file", "unchecked files"],
  "blob-unavailable": ["an unreadable image", "unreadable images"],
  "lottie-frame": ["an animation frame", "animation frames"],
  "tiny-svg": ["a tiny SVG", "tiny SVGs"],
  "svg-too-large": ["an oversized SVG", "oversized SVGs"],
  "unreferenced-symbol": ["an unused sprite symbol", "unused sprite symbols"],
};
const OTHER_PHRASE: [string, string] = ["another file", "other files"];

const joinPhrases = (phrases: string[]) =>
  phrases.length <= 1 ? (phrases[0] ?? "") : `${phrases.slice(0, -1).join(", ")} and ${phrases.at(-1)}`;

/**
 * Footer line from `stats.hidden` (spec 12.2): `9 hidden: tracking pixels and spacer images`. Reasons that share a
 * phrase add up, phrases are ordered by count, and unknown reasons count toward the total as "other files".
 */
export function hiddenSummary(hidden: Record<string, number>): string | null {
  // Keyed by the plural, which is what reasons that share a phrase (`tracker` and `pixel`) have in common.
  const byPhrase = new Map<string, { one: string; count: number }>();
  let total = 0;
  let unknown = 0;
  for (const [reason, count] of Object.entries(hidden)) {
    if (!Number.isFinite(count) || count <= 0) continue;
    total += count;
    const parsed = HiddenReason.safeParse(reason);
    if (!parsed.success) {
      unknown += count;
      continue;
    }
    const [one, many] = HIDDEN_PHRASES[parsed.data];
    byPhrase.set(many, { one, count: (byPhrase.get(many)?.count ?? 0) + count });
  }
  if (!total) return null;
  const counted = [...byPhrase.entries()].sort((a, b) => b[1].count - a[1].count);
  const shown = counted.slice(0, 3).map(([many, entry]) => (entry.count === 1 ? entry.one : many));
  // The last phrase stands for every file left: the reasons past the third and the ones this version cannot name.
  // Its number is what decides the plural, not how many reasons ended up in it.
  const others = counted.slice(3).reduce((sum, [, entry]) => sum + entry.count, unknown);
  if (others > 0) shown.push(OTHER_PHRASE[others === 1 ? 0 : 1]);
  return `${formatCount(total)} hidden: ${joinPhrases(shown)}`;
}

const FOUND_IN_LABELS: Record<FoundIn, string> = {
  img: "<img> tag",
  picture: "<picture> source",
  "lazy-attribute": "Lazy-load attribute",
  noscript: "<noscript> fallback",
  "video-poster": "Video poster",
  "svg-image": "SVG <image>",
  "object-embed": "<object> or <embed>",
  "css-background": "CSS background",
  "css-mask": "CSS mask",
  "css-pseudo": "CSS pseudo-element",
  "css-other": "CSS property",
  stylesheet: "Stylesheet",
  "icon-link": '<link rel="icon">',
  "meta-icon": "Meta tag",
  manifest: "Web app manifest",
  "og-image": "og:image tag",
  "twitter-image": "twitter:image tag",
  "json-ld": "JSON-LD logo",
  "inline-svg": "Inline <svg>",
  "sprite-symbol": "Sprite symbol",
  network: "Network request",
  "shadow-dom": "Shadow DOM",
  iframe: "Same-origin iframe",
  "public-source": "Public source",
};

export const foundInLabel = (foundIn: FoundIn[]) => foundIn.map((item) => FOUND_IN_LABELS[item]).join(", ");
