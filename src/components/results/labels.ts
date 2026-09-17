import { HiddenReason, type Asset, type FoundIn } from "@/lib/contract";
import { formatBytes, formatCount, formatDimensions } from "@/lib/format";
import { assetBytes } from "@/lib/client/filters";

/** Card badges (spec 12.3): only roles worth calling out. */
export function roleBadge(asset: Asset): string | null {
  switch (asset.role) {
    case "site-logo":
    case "logo":
      return "Logo";
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

/** Splits `name.ext` so the base can truncate while the extension stays visible. */
export function splitExtension(filename: string): [string, string] {
  const dot = filename.lastIndexOf(".");
  return dot > 0 && filename.length - dot <= 6 ? [filename.slice(0, dot), filename.slice(dot)] : [filename, ""];
}

const HIDDEN_PHRASES: Record<HiddenReason, string> = {
  tracker: "tracking pixels",
  pixel: "tracking pixels",
  spacer: "spacer images",
  "tiny-data-uri": "spacer images",
  placeholder: "placeholders",
  "not-image": "broken files",
  consent: "consent banners",
  widget: "third-party widgets",
  "probe-failed": "unreachable files",
  "blob-unavailable": "unreadable images",
  "lottie-frame": "animation frames",
  "tiny-svg": "tiny SVGs",
  "svg-too-large": "oversized SVGs",
  "unreferenced-symbol": "unused sprite symbols",
};

const joinPhrases = (phrases: string[]) =>
  phrases.length <= 1 ? (phrases[0] ?? "") : `${phrases.slice(0, -1).join(", ")} and ${phrases.at(-1)}`;

/**
 * Footer line from `stats.hidden` (spec 12.2): `9 hidden: tracking pixels and spacer images`. Reasons that share a
 * phrase add up, phrases are ordered by count, and unknown reasons count toward the total as "other files".
 */
export function hiddenSummary(hidden: Record<string, number>): string | null {
  const byPhrase = new Map<string, number>();
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
    const phrase = HIDDEN_PHRASES[parsed.data];
    byPhrase.set(phrase, (byPhrase.get(phrase) ?? 0) + count);
  }
  if (!total) return null;
  const phrases = [...byPhrase.entries()].sort((a, b) => b[1] - a[1]).map(([phrase]) => phrase);
  const shown = phrases.slice(0, 3);
  if (phrases.length > 3 || unknown > 0) shown.push("other files");
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
