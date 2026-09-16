import { NotImplementedError } from "@/server/errors";
import type { FontBinaryMeta, FontsOutput, PostInput, RawFontFaceRule, SafeFetch } from "../types";

export function parseFontBinary(buffer: Buffer): FontBinaryMeta | null;
export function parseFontBinary(): FontBinaryMeta | null {
  throw new NotImplementedError("D: parseFontBinary");
}

export function parseFontFaceCss(cssText: string, baseUrl: string): RawFontFaceRule[];
export function parseFontFaceCss(): RawFontFaceRule[] {
  throw new NotImplementedError("D: parseFontFaceCss");
}

export function isConvertibleFont(meta: FontBinaryMeta | null, options: { fetch: SafeFetch; signal: AbortSignal }): Promise<boolean>;
export async function isConvertibleFont(): Promise<boolean> {
  throw new NotImplementedError("D: isConvertibleFont");
}

export function buildFontFamilies(input: PostInput): Promise<FontsOutput>;
export async function buildFontFamilies(): Promise<FontsOutput> {
  throw new NotImplementedError("D: buildFontFamilies");
}
