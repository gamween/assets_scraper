import type { AssetKind, AssetRole, FoundIn } from "@/lib/contract";
import type { CandidateContext, Rect } from "../types";

/** Roles and relevance (spec 8.5). */

const ICON_MAX_SIDE = 48;
const LOGO_TOP_PX = 160;
/**
 * Rendered area above which nothing but a JSON-LD declaration makes the site logo. `logoScore` reaches the promotion
 * threshold of 6 on a link to home in the header near the top of the page with nothing logo specific about it, which is
 * also what a hero picture under a nav looks like: apple.com ranked a 3008x692 iPhone photo above its own 14x44
 * wordmark. Past this a real logo would fill a third of a laptop viewport. The logo evidence of `hasLogoEvidence` does
 * not lift the limit: it is shared across a group, and on apple.com the hero carries it while still being a hero.
 */
const LOGO_MAX_AREA = 120_000;
const DRAWABLE = /<(?:path|circle|rect|ellipse|line|polyline|polygon|text|image|use)\b/i;

/** An SVG file that only holds `<symbol>` definitions (an external sprite sheet), so it draws nothing by itself. */
export function isSpriteSheet(markup: string): boolean {
  if (!/<symbol\b/i.test(markup)) return false;
  const outside = markup.replace(/<symbol\b[\s\S]*?<\/symbol\s*>/gi, "").replace(/<defs\b[\s\S]*?<\/defs\s*>/gi, "");
  return !DRAWABLE.test(outside);
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

/** Evidence that the asset is a logo whatever its size or place: the word, a logo wall, or "logo" in its label. */
const hasLogoEvidence = (input: RoleInput): boolean => input.logoWord || input.logoWall || /logo/i.test(input.label ?? "");

export function assignRole(input: RoleInput): AssetRole {
  const found = new Set(input.foundIn);
  const oversized = (input.rendered?.width ?? 0) * (input.rendered?.height ?? 0) > LOGO_MAX_AREA;
  if (found.has("json-ld") || (input.logoScore >= 6 && !oversized)) return "site-logo";
  if (found.has("icon-link") || found.has("meta-icon") || found.has("manifest")) return "favicon";
  if (found.has("og-image") || found.has("twitter-image")) return "social";
  if (hasLogoEvidence(input)) return "logo";
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
