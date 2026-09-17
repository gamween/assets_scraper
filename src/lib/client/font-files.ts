import type { FontFaceInfo, FontFamily, FontFile } from "@/lib/contract";
import { AssetUnavailableError, type BytesOptions } from "./asset-bytes";

/** ASCII slug: "Söhne VF" gives "sohne-vf", "100 900" gives "100-900". */
export function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** One path segment safe for ZIP entries and downloads: no separators, no control characters, no dot-only names. */
export function safeSegment(value: string, fallback = "file"): string {
  const cleaned = value.replace(/[\x00-\x1f\x7f/\\:*?"<>|]+/g, "-").replace(/^[\s.]+|[\s.]+$/g, "").slice(0, 120);
  return cleaned || fallback;
}

const FONT_EXTENSIONS: Record<FontFile["format"], string> = { woff2: "woff2", woff: "woff", ttf: "ttf", otf: "otf", eot: "eot", other: "font" };

/**
 * File names come from the family, weight, style and stretch, never from the URL: inline (data URI) files have no URL,
 * and remote file names are often build hashes.
 */
export function fontFaceBaseName(family: Pick<FontFamily, "name">, face: Pick<FontFaceInfo, "weight" | "style" | "stretch">): string {
  const parts = [slugify(family.name) || "font", slugify(face.weight)];
  if (face.stretch && !["normal", "100%"].includes(face.stretch.trim())) parts.push(slugify(face.stretch));
  if (face.style && face.style.trim() !== "normal") parts.push(slugify(face.style));
  return parts.filter(Boolean).join("-");
}

export interface FontFileEntry {
  face: FontFaceInfo;
  file: FontFile;
  /** File name inside the family folder, unique within the family. */
  name: string;
  /** Name of the converted TTF next to it, when the family is convertible and the file is a remote WOFF2. */
  ttfName?: string;
}

export function withUniqueName(name: string, used: Set<string>): string {
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  let candidate = name;
  for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${base}-${n}${extension}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

export function fontFileEntries(family: FontFamily): FontFileEntry[] {
  const used = new Set<string>();
  const entries: FontFileEntry[] = [];
  for (const face of family.faces) {
    for (const file of face.files) {
      const base = fontFaceBaseName(family, face);
      const name = withUniqueName(`${base}.${FONT_EXTENSIONS[file.format]}`, used);
      const convertible = hasTtf(family, file);
      const ttfName = convertible ? withUniqueName(`${name.slice(0, name.lastIndexOf("."))}.ttf`, used) : undefined;
      entries.push({ face, file, name, ttfName });
    }
  }
  return entries;
}

/**
 * A TTF is offered for WOFF2 files of convertible (open licence) families that the proxy can fetch. The conversion
 * runs on the server (`fmt=ttf`, which checks the licence again), so a file needs a proxy path (spec 9): inline
 * data-URI files and remote files left unsigned by the signing cap get no TTF.
 */
export function hasTtf(family: Pick<FontFamily, "convertible">, file: FontFile): boolean {
  return family.convertible && file.format === "woff2" && !file.inline && file.proxy.length > 0;
}

export async function getFontTtfBlob(file: FontFile, options: BytesOptions = {}): Promise<Blob> {
  if (file.inline || !file.proxy) throw new AssetUnavailableError(file.url || "font");
  const response = await fetch(`${file.proxy}&fmt=ttf`, { signal: options.signal });
  if (!response.ok) throw new AssetUnavailableError(file.url, response.status);
  return response.blob();
}

/** The file most likely to render Latin text in a specimen: loaded, upright, near 400, Latin, smallest format first. */
export function specimenFile(family: FontFamily): FontFile | null {
  const formatRank: Record<FontFile["format"], number> = { woff2: 0, woff: 1, ttf: 2, otf: 3, eot: 9, other: 9 };
  const weightDistance = (weight: string) => {
    const [min, max = min] = weight.trim().split(/\s+/).map(Number);
    if (!Number.isFinite(min)) return 500;
    return 400 >= min && 400 <= max ? 0 : Math.min(Math.abs(400 - min), Math.abs(400 - max));
  };
  let best: { file: FontFile; rank: number } | null = null;
  for (const face of family.faces) {
    for (const file of face.files) {
      if (file.format === "eot") continue;
      const rank =
        (face.loaded ? 0 : 10_000) +
        (face.style.trim() === "normal" ? 0 : 5_000) +
        (file.coversLatin ? 0 : 2_000) +
        weightDistance(face.weight) * 2 +
        formatRank[file.format];
      if (!best || rank < best.rank) best = { file, rank };
    }
  }
  return best?.file ?? null;
}
