import type { AssetFormat } from "@/lib/contract";

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

/** Format from magic bytes, for `application/octet-stream` responses. SVG is recognized as text. */
export function sniffFormat(buffer: Uint8Array): AssetFormat {
  const b = buffer;
  if (b.length >= 8 && b[0] === 0x89 && startsWith(b, 1, "PNG\r\n") && b[6] === 0x1a && b[7] === 0x0a) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (startsWith(b, 0, "GIF87a") || startsWith(b, 0, "GIF89a")) return "gif";
  if (startsWith(b, 0, "RIFF") && startsWith(b, 8, "WEBP")) return "webp";
  if (startsWith(b, 4, "ftypavif") || startsWith(b, 4, "ftypavis")) return "avif";
  if (b.length >= 6 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0 && b[4] + b[5] * 256 > 0) return "ico";
  if (b.length >= 10 && startsWith(b, 0, "BM")) return "bmp";
  const head = Buffer.from(b.subarray(0, 1024)).toString("utf8").replace(/^\uFEFF/, "");
  const rest = head.replace(/^(?:\s|<\?xml[^>]*>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>)*/i, "");
  return /^<svg[\s>/]/i.test(rest) ? "svg" : "other";
}

/** File extension for a format. */
export function extensionFor(format: AssetFormat): string {
  return format === "other" ? "bin" : format;
}
