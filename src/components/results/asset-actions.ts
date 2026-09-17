"use client";

import { toast } from "@/components/ui/toast";
import type { Asset } from "@/lib/contract";
import { getAssetBlob } from "@/lib/client/asset-bytes";
import { copyText, copyTextFrom } from "@/lib/client/clipboard";
import { replaceExtension, saveBlob } from "@/lib/client/download";

const EXTENSIONS: Record<Asset["format"], string> = { svg: "svg", png: "png", jpg: "jpg", webp: "webp", avif: "avif", gif: "gif", ico: "ico", bmp: "bmp", other: "bin" };

export function notify(title: string, options: { error?: boolean; description?: string } = {}) {
  toast.add({ title, description: options.description, timeout: options.error ? 4000 : 2000, priority: options.error ? "high" : "low" });
}

/** Copies text from inside the click or key handler (Safari needs that) and confirms with a toast. */
export function copyWithToast(text: string, message: string) {
  void copyText(text).then((ok) => notify(ok ? message : "Copy failed. Try again.", { error: !ok }));
}

export function svgMarkup(asset: Asset): Promise<string> {
  if (asset.inline && "text" in asset.inline) return Promise.resolve(asset.inline.text);
  return getAssetBlob(asset, "original").then((blob) => blob.text());
}

/** Spec 12.2: `Copy SVG code` (C). The markup goes to the clipboard as text, never into the page. */
export function copySvgCode(asset: Asset) {
  if (asset.kind !== "svg") return;
  void copyTextFrom(svgMarkup(asset)).then((ok) => notify(ok ? "SVG code copied" : "Copy failed. Use Download instead.", { error: !ok }));
}

export function displayFilename(asset: Asset): string {
  const format = asset.display?.format ?? asset.format;
  const base = asset.filename.replace(/\.[^.]+$/, "");
  return `${base}-as-displayed.${EXTENSIONS[format]}`;
}

/** Spec 12.2: `Download` (D) saves the original; `Download as displayed` saves the version shown on the page. */
export function downloadAsset(asset: Asset, which: "original" | "display" = "original") {
  const filename = which === "display" ? displayFilename(asset) : replaceExtension(asset.filename, EXTENSIONS[asset.original?.format ?? asset.format]);
  void getAssetBlob(asset, which)
    .then((blob) => saveBlob(blob, filename))
    .catch(() => notify("This file couldn't be downloaded", { error: true, description: asset.filename }));
}

/** Remote http(s) source, if any. Inline and blob assets have none (spec 11.4: blob URLs are never opened). */
export function sourceUrl(asset: Asset): string | null {
  if (asset.inline) return null;
  const url = asset.original?.url ?? asset.display?.url ?? "";
  return /^https?:\/\//i.test(url) ? url : null;
}

export function openSource(asset: Asset) {
  const url = sourceUrl(asset);
  if (url) window.open(url, "_blank", "noopener,noreferrer");
}
