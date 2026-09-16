import type { FontFamily, FontLicense } from "@/lib/contract";
import type { FontBinaryMeta } from "../types";
import { CONTROL_CHARS } from "./names";

const OPEN_LICENSE = /SIL Open Font License|\bOFL\b|openfontlicense|scripts\.sil\.org\/OFL|Apache License|Ubuntu Font Licen[cs]e/i;
const MAX_TEXT = 1_000;

export type LicenseMeta = Pick<FontBinaryMeta, "copyright" | "licenseDescription" | "licenseUrl">;

const clean = (value: string | undefined) => value?.replace(CONTROL_CHARS, "").trim() || undefined;

const httpUrl = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Licence from name records 0 (copyright), 13 (description) and 14 (URL), spec section 9: `open` when a record names
 * an open licence or the font comes from Google Fonts, `commercial` for Adobe Fonts or any other text, `unknown`
 * without text. `url` is kept only when it is an http(s) URL, since the UI may link it.
 */
export function classifyLicense(meta: LicenseMeta | null | undefined, source: FontFamily["source"]): FontLicense {
  const copyright = clean(meta?.copyright);
  const description = clean(meta?.licenseDescription);
  const rawUrl = clean(meta?.licenseUrl);
  const texts = [copyright, description, rawUrl].filter((text): text is string => !!text);
  const kind: FontLicense["kind"] =
    source === "google-fonts" ? "open"
    : source === "adobe-fonts" ? "commercial"
    : texts.some((text) => OPEN_LICENSE.test(text)) ? "open"
    : texts.length ? "commercial"
    : "unknown";
  const license: FontLicense = { kind };
  const text = (description ?? copyright)?.slice(0, MAX_TEXT);
  if (text) license.text = text;
  const url = httpUrl(rawUrl);
  if (url) license.url = url;
  return license;
}
