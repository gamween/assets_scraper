import type { FontBinaryMeta, FontsOutput, PostInput, SafeFetch } from "../types";
import { NotImplementedError } from "@/server/errors";
import { matchGoogleFamilies } from "./google";
import { classifyLicense } from "./license";
import { resolveFamilyName } from "./names";

export { parseFontBinary } from "./binary";
export { parseFontFaceCss } from "./css";

/**
 * Whether a font file may be converted to TTF (the asset proxy `fmt=ttf`, spec 9 and 11.2): an open licence in its
 * name records, or no licence text at all and a family name that Google Fonts knows. A commercial licence or an
 * unreadable file never converts.
 */
export async function isConvertibleFont(meta: FontBinaryMeta | null, options: { fetch: SafeFetch; signal: AbortSignal }): Promise<boolean> {
  if (!meta) return false;
  const { kind } = classifyLicense(meta);
  if (kind !== "unknown") return kind === "open";
  const { name } = resolveFamilyName(meta, null);
  const matches = await matchGoogleFamilies([name], options);
  return matches.has(name);
}

export function buildFontFamilies(input: PostInput): Promise<FontsOutput>;
export async function buildFontFamilies(): Promise<FontsOutput> {
  throw new NotImplementedError("D: buildFontFamilies");
}
