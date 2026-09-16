import type { Asset, AssetSource, FontFile, InlineBytes, InlineSvg } from "@/lib/contract";

/** Every way to get an asset's bytes failed: no inline bytes, direct fetch and proxy both failed or were missing. */
export class AssetUnavailableError extends Error {
  constructor(
    readonly id: string,
    readonly status?: number,
  ) {
    super(`Asset ${id} is unavailable${status ? ` (${status})` : ""}`);
    this.name = "AssetUnavailableError";
  }
}

export interface BytesOptions {
  signal?: AbortSignal;
}

export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function inlineToBlob(inline: InlineSvg | InlineBytes): Blob {
  if ("text" in inline) return new Blob([inline.text], { type: "image/svg+xml" });
  return new Blob([base64ToBytes(inline.base64)], { type: inline.mime });
}

/** `http:` sources always load through the same-origin proxy (mixed content), `https:` sources directly. */
export function previewSrc(source: Pick<AssetSource, "url" | "proxy">): string {
  return source.url.startsWith("https:") || !source.proxy ? source.url : source.proxy;
}

const isAbort = (error: unknown, signal?: AbortSignal) =>
  signal?.aborted || (error instanceof DOMException && error.name === "AbortError");

/**
 * Critic G3: direct CORS fetch first (no cookies, no referrer), then the signed proxy. Many CDNs allow any origin,
 * which saves proxy bytes; the rest (Sanity-style 403 on a foreign Origin, no CORS headers) fall back.
 */
export async function fetchSourceBlob(source: Pick<AssetSource, "url" | "proxy">, id: string, options: BytesOptions = {}): Promise<Blob> {
  const { signal } = options;
  if (source.url.startsWith("https:")) {
    try {
      const response = await fetch(source.url, { mode: "cors", credentials: "omit", referrerPolicy: "no-referrer", signal });
      if (response.ok) return await response.blob();
    } catch (error) {
      if (isAbort(error, signal)) throw error;
    }
  }
  if (!source.proxy) throw new AssetUnavailableError(id);
  let response: Response;
  try {
    response = await fetch(source.proxy, { signal });
  } catch (error) {
    if (isAbort(error, signal)) throw error;
    throw new AssetUnavailableError(id);
  }
  if (!response.ok) throw new AssetUnavailableError(id, response.status);
  return response.blob();
}

/** Tiles use `display`, detail, downloads and ZIP use `original`. Either falls back to the other when missing. */
export async function getAssetBlob(asset: Asset, which: "display" | "original", options: BytesOptions = {}): Promise<Blob> {
  if (asset.inline) return inlineToBlob(asset.inline);
  const source = which === "display" ? (asset.display ?? asset.original) : (asset.original ?? asset.display);
  if (!source) throw new AssetUnavailableError(asset.id);
  return fetchSourceBlob(source, asset.id, options);
}

/** Inline (data URI) font files carry their bytes; remote ones load like assets. */
export async function getFontFileBlob(file: FontFile, options: BytesOptions = {}): Promise<Blob> {
  if (file.inline) return inlineToBlob(file.inline);
  return fetchSourceBlob(file, file.url || "font", options);
}
