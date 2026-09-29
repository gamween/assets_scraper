import type { Asset, AssetFormat, AssetKind, AssetRole, AssetSource } from "@/lib/contract";
import { assertSupportedBytes } from "./bytes";
import type { SelectionProfile } from "./types";

/**
 * One file of a download, the same whether it goes to a disk (`download.ts`) or into the hosted archive
 * (`src/app/api/v1/zip.ts`): where its bytes come from and its row in `manifest.json`. Kept apart from `download.ts`
 * for the reason `names.ts` is: the hosted routes use these, and must not load a module that writes to disk.
 */

/** One row of `manifest.json`: what the file is, where it came from, and why the selection kept it. */
export interface ManifestFile {
  id: string;
  name: string;
  /** Path inside the destination directory, with forward slashes. */
  file: string;
  /** The URL the bytes came from, or "" for an asset the page carried inline. */
  url: string;
  kind: AssetKind;
  role: AssetRole;
  format: AssetFormat;
  width?: number;
  height?: number;
  bytes: number;
  keptBecause: string;
  /** Ids of the assets this file won a duplicate group against. */
  duplicatesDropped?: string[];
}

/**
 * The bytes an asset carries itself, or null when they have to be fetched. They are checked like the bytes a fetch
 * returns (`bytes.ts`): an asset the scan found as a `data:` URI, or one a remote answer shipped inline, is only as
 * trustworthy as whatever wrote it, and a PNG that is not a PNG must not be written as one.
 */
export function inlineAssetBytes(asset: Asset): Buffer | null {
  const inline = asset.inline;
  if (!inline) return null;
  const bytes = "text" in inline ? Buffer.from(inline.text, "utf8") : Buffer.from(inline.base64, "base64");
  // Markup the scan kept inline is an SVG document whatever the asset says, so it is held to being one.
  assertSupportedBytes(bytes, "text" in inline ? "svg" : asset.format, "this inline asset");
  return bytes;
}

/** The best source of an asset's bytes: the CDN original when the scan found one, the served file otherwise. */
export const bytesSource = (asset: Asset): AssetSource | null => asset.original ?? asset.display;

/** The URL the bytes came from, or "" for an asset the page carried inline. */
export const sourceUrl = (asset: Asset): string => bytesSource(asset)?.url ?? "";

/** Why a file is in the selection, and what it won against: the part of a manifest row the selection decides. */
export interface KeptFor {
  profile: SelectionProfile;
  /** True when the caller named the assets by id. */
  explicit: boolean;
  /** Ids of the assets this file won a duplicate group against. */
  duplicatesDropped?: string[];
}

/** One row of `manifest.json`, the same whether the file went to a disk or into the hosted archive. */
export function manifestRow(asset: Asset, file: string, bytes: number, kept: KeptFor): ManifestFile {
  return {
    id: asset.id,
    name: asset.name,
    file,
    url: sourceUrl(asset),
    kind: asset.kind,
    role: asset.role,
    format: asset.format,
    ...(asset.width === undefined ? {} : { width: asset.width }),
    ...(asset.height === undefined ? {} : { height: asset.height }),
    bytes,
    keptBecause: kept.explicit ? "explicit id" : `${kept.profile} profile (role ${asset.role})`,
    ...(kept.duplicatesDropped === undefined ? {} : { duplicatesDropped: kept.duplicatesDropped }),
  };
}
