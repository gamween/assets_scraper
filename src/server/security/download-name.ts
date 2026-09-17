/**
 * Extensions a download may keep for each media type the asset proxy serves. The first one replaces any other, so a
 * saved file always opens as what it was served as.
 */
const EXTENSIONS: Record<string, readonly string[]> = {
  "image/png": ["png"],
  "image/x-png": ["png"],
  "image/apng": ["apng", "png"],
  "image/jpeg": ["jpg", "jpeg"],
  "image/jpg": ["jpg", "jpeg"],
  "image/pjpeg": ["jpg", "jpeg"],
  "image/gif": ["gif"],
  "image/webp": ["webp"],
  "image/avif": ["avif"],
  "image/svg+xml": ["svg"],
  "image/x-icon": ["ico"],
  "image/vnd.microsoft.icon": ["ico"],
  "image/bmp": ["bmp"],
  "image/x-ms-bmp": ["bmp"],
  "image/tiff": ["tif", "tiff"],
  "image/heic": ["heic"],
  "image/heif": ["heif"],
  "image/jxl": ["jxl"],
  "font/woff": ["woff"],
  "font/woff2": ["woff2"],
  "font/ttf": ["ttf"],
  "font/otf": ["otf"],
  "font/sfnt": ["ttf", "otf"],
  "font/collection": ["ttc", "otc"],
  "application/font-woff": ["woff"],
  "application/font-woff2": ["woff2"],
  "application/x-font-woff": ["woff"],
  "application/font-sfnt": ["ttf", "otf"],
  "application/x-font-ttf": ["ttf"],
  "application/x-font-truetype": ["ttf"],
  "application/x-font-otf": ["otf"],
  "application/x-font-opentype": ["otf"],
};
/** Any image or font extension above: kept for a media type missing from the table, which gets `.bin` otherwise. */
const KNOWN_EXTENSIONS = new Set(Object.values(EXTENSIONS).flat());
const UNKNOWN_TYPE_EXTENSION = "bin";
const EXTENSION = /^[a-z0-9]{1,10}$/i;
const MAX_STEM_CODE_POINTS = 200;
const UNSAFE_CHARACTERS = /[\u0000-\u001f\u007f\u061C\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069<>:"|?*]/g;

/**
 * File name for a download of `contentType`, from the unsigned `dl` param: the last path segment without control,
 * bidi or reserved characters and dot runs, at most 200 code points before the extension, and an extension that
 * matches the served type. `dl` is not signed, so without that last rule anyone could hand out an app link that
 * saves the bytes of any signed image URL as `Invoice.exe`.
 */
export function downloadName(dl: string, contentType: string): string {
  const cleaned = (dl.split(/[\\/]/).pop() ?? "")
    .toWellFormed()
    .replace(UNSAFE_CHARACTERS, "")
    .replace(/\.{2,}/g, ".")
    .replace(/^[.\s]+|[.\s]+$/g, "");
  const dot = cleaned.lastIndexOf(".");
  const hasExtension = dot > 0 && EXTENSION.test(cleaned.slice(dot + 1));
  let extension = hasExtension ? cleaned.slice(dot + 1) : "";
  const allowed = EXTENSIONS[contentType];
  if (!(allowed ? allowed.includes(extension.toLowerCase()) : KNOWN_EXTENSIONS.has(extension.toLowerCase()))) {
    extension = allowed?.[0] ?? UNKNOWN_TYPE_EXTENSION;
  }
  const stem = Array.from(hasExtension ? cleaned.slice(0, dot) : cleaned)
    .slice(0, MAX_STEM_CODE_POINTS)
    .join("")
    .replace(/[.\s]+$/, "");
  return `${stem || "download"}.${extension}`;
}

/** `attachment` with the download name when `dl` is given, else `inline`. */
export function contentDisposition(dl: string | undefined, contentType: string): string {
  if (dl === undefined) return "inline";
  const encoded = encodeURIComponent(downloadName(dl, contentType)).replace(
    /['()*!]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename*=UTF-8''${encoded}`;
}
