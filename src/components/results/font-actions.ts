"use client";

import { downloadZip } from "client-zip";
import type { FontFamily } from "@/lib/contract";
import { formatBytes } from "@/lib/format";
import { getFontFileBlob } from "@/lib/client/asset-bytes";
import { saveBlob } from "@/lib/client/download";
import { fontFileEntries, getFontTtfBlob, slugify } from "@/lib/client/font-files";
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

async function saveFiles(files: { name: string; load: () => Promise<Blob> }[], zipName: string) {
  if (files.length === 1) {
    saveBlob(await files[0].load(), files[0].name);
    return;
  }
  const loaded = await Promise.all(files.map(async (file) => ({ name: file.name, input: await file.load(), lastModified: new Date() })));
  saveBlob(await downloadZip(loaded).blob(), zipName);
}

/** Spec 12.2 font `Download`: the files as served, one file directly or a small ZIP for several. */
export function downloadFontFiles(family: FontFamily) {
  if (!family.downloadable) return;
  const entries = fontFileEntries(family);
  void saveFiles(
    entries.map((entry) => ({ name: entry.name, load: () => getFontFileBlob(entry.file) })),
    `${slugify(family.name) || "font"}.zip`,
  ).catch(() => notify("This font couldn't be downloaded", { error: true, description: family.name }));
}

/** `Download TTF`: converted on the server through the proxy (`fmt=ttf`), offered only for convertible families. */
export function downloadFontTtf(family: FontFamily) {
  const entries = fontFileEntries(family).filter((entry) => entry.ttfName);
  if (!entries.length) return;
  void saveFiles(
    entries.map((entry) => ({ name: entry.ttfName!, load: () => getFontTtfBlob(entry.file) })),
    `${slugify(family.name) || "font"}-ttf.zip`,
  ).catch(() => notify("The TTF couldn't be created", { error: true, description: family.name }));
}

export const canDownloadTtf = (family: FontFamily) => fontFileEntries(family).some((entry) => entry.ttfName);
