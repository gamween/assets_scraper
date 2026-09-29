import type { AssetKind, AssetRole, FoundIn } from "@/lib/contract";
import type { CandidateContext, Rect } from "../types";
import { searchFrom } from "./search";

/** Roles and relevance (spec 8.5). */

const ICON_MAX_SIDE = 48;
const LOGO_TOP_PX = 160;
/**
 * Area above which nothing but a JSON-LD declaration makes an asset a logo, site logo or customer logo alike.
 * `logoScore` reaches the promotion
 * threshold of 6 on a link to home in the header near the top of the page with nothing logo specific about it, which is
 * also what a hero picture under a nav looks like: apple.com ranked a 3008x692 iPhone photo above its own 14x44
 * wordmark. Past this a real logo would fill a third of a laptop viewport. The logo evidence of `hasLogoEvidence` does
 * not lift the limit: it is shared across a group, and on apple.com the hero carries it while still being a hero, and
 * stripe.com captions three 2460x1060 photographs with a sentence that mentions its own logo.
 */
const LOGO_MAX_AREA = 120_000;
/** Score at which position alone makes an asset the site logo. */
const LOGO_SCORE_PROMOTION = 6;
const DRAWABLE = /<(?:path|circle|rect|ellipse|line|polyline|polygon|text|image|use)\b/i;
const SYMBOL = { open: /<symbol\b/gi, close: /<\/symbol\s*>/gi };
const DEFS = { open: /<defs\b/gi, close: /<\/defs\s*>/gi };

/**
 * `markup` without its closed blocks of one element, each from its opening tag to the first closer after it. A block
 * left open stays, with the rest of the markup after it: no later one can be closed either. Each search starts where
 * the last one ended, where the lazy pattern this replaces (`<symbol\b[\s\S]*?</symbol>`) read from every unclosed
 * `<symbol` to the end, and one 1 MB SVG of them took 20 seconds.
 */
function withoutBlocks(markup: string, tag: { open: RegExp; close: RegExp }): string {
  const kept: string[] = [];
  let from = 0;
  for (;;) {
    const open = searchFrom(markup, tag.open, from);
    const close = open && searchFrom(markup, tag.close, open.index + open[0].length);
    if (!open || !close) break;
    kept.push(markup.slice(from, open.index));
    from = close.index + close[0].length;
  }
  kept.push(markup.slice(from));
  return kept.join("");
}

/** An SVG file that only holds `<symbol>` definitions (an external sprite sheet), so it draws nothing by itself. */
export function isSpriteSheet(markup: string): boolean {
  if (!searchFrom(markup, SYMBOL.open, 0)) return false;
  return !DRAWABLE.test(withoutBlocks(withoutBlocks(markup, SYMBOL), DEFS));
}

/** logo word 3 + link to home 3 + header or nav 2 + site word 2 + visible within the top 160 px 1 + footer 1. */
export function logoScore(context: CandidateContext, visible: boolean, rect?: Rect): number {
  let score = 0;
  if (context.logoWord) score += 3;
  if (context.homeLink) score += 3;
  if (context.header || context.nav) score += 2;
  if (context.siteWord) score += 2;
  if (visible && rect && rect.y < LOGO_TOP_PX) score += 1;
  if (context.footer) score += 1;
  return score;
}

export interface RoleInput {
  kind: AssetKind;
  foundIn: FoundIn[];
  logoScore: number;          // best score of all members
  logoWord: boolean;          // any member
  logoWall: boolean;          // any member
  label?: string;
  rendered?: { width: number; height: number };            // largest visible rendered size
  intrinsic?: { width?: number; height?: number };         // size of the file, when known
  spriteSymbol?: boolean;
}

const longestSide = (size?: { width?: number; height?: number }) => Math.max(size?.width ?? 0, size?.height ?? 0);
const area = (size?: { width?: number; height?: number }) => (size?.width ?? 0) * (size?.height ?? 0);

/**
 * How big the asset is where the logo limit is concerned: what it renders at, and for a raster that never rendered,
 * the size of the file. A vector scales, so its intrinsic box says nothing about the page and is not used here: a
 * customer logo wall often ships 1000 unit wide SVGs that render at 142x34, and a carousel keeps some of them hidden.
 *
 * The file is only read when nothing but a word says the asset is a logo, which is the case the limit was written for
 * (a photograph whose alt sentence mentions a logo). A page that treats the asset as a logo, by putting it on a logo
 * wall or by scoring it at the promotion threshold, is believed even when the asset never rendered: a mobile only
 * header logo, a dark theme variant behind `display:none` and a 2x raster are all real logos shipped oversized.
 */
const logoArea = (input: RoleInput): number => {
  const rendered = area(input.rendered);
  if (rendered > 0) return rendered;
  if (input.kind === "svg" || input.logoWall || input.logoScore >= LOGO_SCORE_PROMOTION) return 0;
  return area(input.intrinsic);
};

/**
 * Prose, not a name: stripe.com describes a 2460x1060 photograph as "Aerial view of a street intersection where the
 * crosswalks form a slanted parallelogram, imitating the Stripe logo." The word "logo" in a sentence that long is
 * about what the picture shows, not what the file is.
 */
const PROSE_LABEL_CHARS = 60;
const isProse = (label: string | undefined): boolean => (label ?? "").length > PROSE_LABEL_CHARS;

/**
 * Evidence that the asset is a logo whatever its place: the word, a logo wall, or "logo" in its label. A label long
 * enough to be a sentence is a description and proves nothing.
 */
const hasLogoEvidence = (input: RoleInput): boolean =>
  input.logoWord || input.logoWall || (/logo/i.test(input.label ?? "") && !isProse(input.label));

export function assignRole(input: RoleInput): AssetRole {
  const found = new Set(input.foundIn);
  const oversized = logoArea(input) > LOGO_MAX_AREA;
  if (found.has("json-ld") || (input.logoScore >= LOGO_SCORE_PROMOTION && !oversized)) return "site-logo";
  if (found.has("icon-link") || found.has("meta-icon") || found.has("manifest")) return "favicon";
  if (found.has("og-image") || found.has("twitter-image")) return "social";
  // A logo is small. Past the same limit the site logo answers to, a picture that carries a logo word is a picture.
  if (hasLogoEvidence(input) && !oversized) return "logo";
  if (input.spriteSymbol) return "sprite-symbol";
  // The single small-icon rule: the rendered size when the asset is on screen, else its intrinsic size.
  const side = input.rendered && longestSide(input.rendered) > 0 ? longestSide(input.rendered) : longestSide(input.intrinsic);
  if (side > 0 && side <= ICON_MAX_SIDE) return "icon";
  return input.kind === "svg" ? "illustration" : "image";
}

const ROLE_WEIGHT: Record<AssetRole, number> = {
  "site-logo": 1000,
  logo: 500,
  favicon: 300,
  social: 200,
  illustration: 100,
  image: 100,
  "sprite-symbol": 20,
  icon: 10,
};

export interface ScoreInput {
  role: AssetRole;
  visible: boolean;
  renderedWidth?: number;
  renderedHeight?: number;
  order: number;
}

/** Role weight + min(rendered area / 1000, 90) + 50 when visible, minus 0.01 per page-order step. */
export function relevanceScore(input: ScoreInput): number {
  const renderedArea = input.visible ? (input.renderedWidth ?? 0) * (input.renderedHeight ?? 0) : 0;
  return ROLE_WEIGHT[input.role] + Math.min(renderedArea / 1000, 90) + (input.visible ? 50 : 0) - 0.01 * input.order;
}
