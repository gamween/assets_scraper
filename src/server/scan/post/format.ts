import type { AssetFormat } from "@/lib/contract";
import { sniffContentType } from "@/server/security/sniff";

const BY_MIME: Record<string, AssetFormat> = {
  "image/svg+xml": "svg",
  "image/png": "png",
  "image/apng": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/pjpeg": "jpg",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/gif": "gif",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
  "image/ico": "ico",
  "image/bmp": "bmp",
  "image/x-ms-bmp": "bmp",
};

const BY_EXTENSION: Record<string, AssetFormat> = {
  svg: "svg", png: "png", apng: "png", jpg: "jpg", jpeg: "jpg", jfif: "jpg", webp: "webp", avif: "avif",
  gif: "gif", ico: "ico", cur: "ico", bmp: "bmp",
};

/** Format from a URL: the media type of a data URI, else the extension of the path. */
export function formatFromUrl(url: string): AssetFormat {
  if (/^data:/i.test(url)) return BY_MIME[url.slice(5).split(/[;,]/)[0].trim().toLowerCase()] ?? "other";
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return "other";
  }
  const extension = /\.([a-z0-9]+)$/i.exec(pathname)?.[1]?.toLowerCase();
  return (extension && BY_EXTENSION[extension]) || "other";
}

/** Format from a response content type, falling back to the URL extension for generic types. */
export function formatFromContentType(contentType: string, url: string): AssetFormat {
  const mime = contentType.split(";")[0].trim().toLowerCase();
  return BY_MIME[mime] ?? formatFromUrl(url);
}

const startsWith = (buffer: Uint8Array, offset: number, text: string) => {
  if (buffer.length < offset + text.length) return false;
  for (let i = 0; i < text.length; i++) if (buffer[offset + i] !== text.charCodeAt(i)) return false;
  return true;
};

/**
 * Format from magic bytes, for `application/octet-stream` responses. SVG is recognized as text. The magic bytes are
 * the asset proxy's sniffer, so the two cannot drift: a hand-maintained second copy read an Illustrator SVG, whose
 * DOCTYPE carries an internal subset, as `other` and dropped the original the CDN served.
 */
export function sniffFormat(buffer: Uint8Array): AssetFormat {
  // BMP is not a type the asset proxy serves, so `sniffContentType` does not know it.
  if (buffer.length >= 10 && startsWith(buffer, 0, "BM")) return "bmp";
  // An ICO that declares no image is not an ICO; the proxy does not care, an asset does.
  if (startsWith(buffer, 0, "\x00\x00\x01\x00") && !(buffer.length >= 6 && buffer[4] + buffer[5] * 256 > 0)) return "other";
  const mime = sniffContentType(buffer);
  return (mime === null ? undefined : BY_MIME[mime]) ?? "other";
}

/** File extension for a format. */
export function extensionFor(format: AssetFormat): string {
  return format === "other" ? "bin" : format;
}
