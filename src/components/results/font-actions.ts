"use client";

import { showZipFailures } from "@/components/selection/zip-actions";
import type { FontFamily } from "@/lib/contract";
import { formatBytes } from "@/lib/format";
import { saveBlob } from "@/lib/client/download";
import { fontFileEntries } from "@/lib/client/font-files";
import { planFontFamily, zipToBlob, type PlannedEntry, type ZipFailure } from "@/lib/client/zip";
import { notify } from "./asset-actions";

const WEIGHT_NAMES: Record<number, string> = {
  100: "Thin",
  200: "ExtraLight",
  300: "Light",
  400: "Regular",
  500: "Medium",
  600: "SemiBold",
  700: "Bold",
  800: "ExtraBold",
  900: "Black",
};

const numericWeight = (value: string) => (value === "normal" ? 400 : value === "bold" ? 700 : Number(value));

/** `Regular 400, Medium 500, Bold 700` or `Variable 100 to 900`, with `, italic` when italic faces exist. */
export function weightsSummary(family: FontFamily): string {
  const statics = new Set<number>();
  const ranges = new Set<string>();
  let italic = false;
  for (const face of family.faces) {
    if (face.style.trim() !== "normal") italic = true;
    const [min, max] = face.weight.trim().split(/\s+/).map(numericWeight);
    if (max !== undefined && Number.isFinite(max) && max !== min) ranges.add(`Variable ${min} to ${max}`);
    else if (Number.isFinite(min)) statics.add(min);
  }
  const parts = [
    ...ranges,
    ...[...statics].sort((a, b) => a - b).map((weight) => (WEIGHT_NAMES[weight] ? `${WEIGHT_NAMES[weight]} ${weight}` : String(weight))),
  ];
  return `${parts.join(", ") || "Regular 400"}${italic ? ", italic" : ""}`;
}

export function fontMeta(family: FontFamily): string {
  const files = family.faces.flatMap((face) => face.files);
  const formats = [...new Set(files.map((file) => (file.format === "other" ? "Font" : file.format.toUpperCase())))];
  const bytes = files.reduce((sum, file) => sum + (file.bytes ?? 0), 0);
  return [formats.join(", "), files.length === 1 ? "1 file" : `${files.length} files`, bytes ? formatBytes(bytes) : null].filter(Boolean).join(" · ");
}

export const SOURCE_LABELS: Record<FontFamily["source"], string> = {
  "google-fonts": "Google Fonts",
  "adobe-fonts": "Adobe Fonts",
  "self-hosted": "Self-hosted",
  "third-party": "Third-party",
  "data-uri": "Embedded",
};

export const LICENCE_LABELS: Record<FontFamily["license"]["kind"], string> = {
  open: "Open licence",
  commercial: "Commercial licence",
  unknown: "Licence unknown",
};

export const googleFontsUrl = (family: string) => `https://fonts.google.com/specimen/${encodeURIComponent(family.trim()).replace(/%20/g, "+")}`;
export const adobeFontsUrl = (family: string) => `https://fonts.adobe.com/search?query=${encodeURIComponent(family)}`;

/**
 * One file saves as it is. Several go through the loader of the page ZIP (six at a time, a file that fails skipped and
 * listed) instead of all at once, where a single 404 among the unicode-range subsets of a family threw every file
 * away. The archive is saved unless no file loaded at all.
 */
async function saveFamily(entries: PlannedEntry[], zipName: string): Promise<ZipFailure[]> {
  if (entries.length === 1) {
    saveBlob(await entries[0].load(), entries[0].path);
    return [];
  }
  const { blob, failed } = await zipToBlob(entries);
  if (failed.length === entries.length) throw new Error("No file of the family could be downloaded");
  saveBlob(blob, zipName);
  return failed;
}

/** Downloads already loading, by kind and family: a second click waits for the first instead of fetching it all again. */
const inFlight = new Set<string>();

function downloadFamily(family: FontFamily, kind: "files" | "ttf", failure: string) {
  const { zipName, entries } = planFontFamily(family, kind);
  const key = `${kind} ${family.id}`;
  if (!entries.length || inFlight.has(key)) return;
  inFlight.add(key);
  void saveFamily(entries, zipName)
    .then((failed) => {
      if (failed.length) showZipFailures(failed);
    })
    .catch(() => notify(failure, { error: true, description: family.name }))
    .finally(() => inFlight.delete(key));
}

/** Spec 12.2 font `Download`: the files as served, one file directly or a small ZIP for several. */
export function downloadFontFiles(family: FontFamily) {
  if (family.downloadable) downloadFamily(family, "files", "This font couldn't be downloaded");
}

/** `Download TTF`: converted on the server through the proxy (`fmt=ttf`), offered only for convertible families. */
export function downloadFontTtf(family: FontFamily) {
  downloadFamily(family, "ttf", "The TTF couldn't be created");
}

export const canDownloadTtf = (family: FontFamily) => fontFileEntries(family).some((entry) => entry.ttfName);
