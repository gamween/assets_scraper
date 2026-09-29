import type { AssetFormat } from "@/lib/contract";

/** Saves a blob under `filename` through a temporary object URL. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  link.style.display = "none";
  document.body.append(link);
  link.click();
  link.remove();
  // Revoking at once can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** "linear-hero.webp" with format "png" gives "linear-hero.png". */
export function replaceExtension(filename: string, extension: string): string {
  const dot = filename.lastIndexOf(".");
  return `${dot > 0 ? filename.slice(0, dot) : filename}.${extension}`;
}

/**
 * The name bytes of `format` save under: `linear-hero.webp` saved as PNG is `linear-hero.png`. A known format is its
 * own extension. A file of format `other` (a PDF or a TIFF scanned as the page itself) keeps the extension the server
 * gave it from its URL, the only name its type has here, rather than turning into `.bin`.
 */
export function filenameForFormat(filename: string, format: AssetFormat): string {
  return format === "other" ? filename : replaceExtension(filename, format);
}
