import type { Asset } from "@/lib/contract";
import { inlineToBlob } from "./asset-bytes";

/**
 * Object URLs for inline previews (spec 11.4: scraped SVG markup only ever reaches the page as `<img src="blob:...">`).
 * One URL per asset object, created on first use and revoked together when a new scan replaces the results.
 */
const urls = new WeakMap<Asset, string>();
let created: string[] = [];

export function inlinePreviewUrl(asset: Asset): string | null {
  if (!asset.inline || typeof URL.createObjectURL !== "function") return null;
  let url = urls.get(asset);
  if (!url) {
    url = URL.createObjectURL(inlineToBlob(asset.inline));
    urls.set(asset, url);
    created.push(url);
  }
  return url;
}

export function revokePreviewUrls(): void {
  for (const url of created) URL.revokeObjectURL(url);
  created = [];
}
