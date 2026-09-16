import type { FontFamily, FontFormat, InlineBytes } from "@/lib/contract";
import type { CapturedFont, FontBinaryMeta } from "../types";
import { parseFontBinary, sniffFontFormat } from "./binary";

export type FontSource = FontFamily["source"];

/** One font file: a remote URL, captured during the scan or only declared, or the bytes of a `data:` URI. */
export interface FileRecord {
  url: string; // "" for a data: URI
  format: FontFormat;
  bytes?: number;
  inline?: InlineBytes;
  meta: FontBinaryMeta | null;
  captured: boolean;
  source: FontSource;
  host?: string;
}

const FORMAT_HINTS: Record<string, FontFormat> = {
  woff2: "woff2", "woff2-variations": "woff2",
  woff: "woff", "woff-variations": "woff",
  truetype: "ttf", "truetype-variations": "ttf",
  opentype: "otf", "opentype-variations": "otf",
  "embedded-opentype": "eot",
};
const EXTENSION_FORMATS: Record<string, FontFormat> = { woff2: "woff2", woff: "woff", ttf: "ttf", otf: "otf", eot: "eot" };
const FORMAT_MIME: Partial<Record<FontFormat, string>> = {
  woff2: "font/woff2", woff: "font/woff", ttf: "font/ttf", otf: "font/otf", eot: "application/vnd.ms-fontobject",
};
const GOOGLE_HOSTS = new Set(["fonts.gstatic.com", "fonts.googleapis.com"]);
const ADOBE_HOSTS = new Set(["use.typekit.net", "p.typekit.net"]);
const SECOND_LEVEL_LABELS = /^(?:ac|co|com|edu|go|gov|ne|net|or|org)$/;

export const isDataUri = (url: string): boolean => /^data:/i.test(url);

/** Absolute http(s) URL without its fragment, or null. */
export function remoteUrl(url: string, base?: string): string | null {
  try {
    const parsed = new URL(url, base);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    parsed.hash = "";
    return parsed.href;
  } catch {
    return null;
  }
}

/** Bytes of a `data:` URI, base64 or percent-encoded. Null when it has no payload. */
export function decodeDataUri(uri: string): { mime: string; bytes: Buffer } | null {
  const comma = uri.indexOf(",");
  if (!isDataUri(uri) || comma < 0) return null;
  const [mime = "", ...params] = uri.slice("data:".length, comma).split(";").map((part) => part.trim().toLowerCase());
  const payload = uri.slice(comma + 1);
  const raw = payload.includes("%") ? percentDecode(payload) : Buffer.from(payload, "latin1");
  const bytes = params.includes("base64") ? Buffer.from(raw.toString("latin1").replace(/\s+/g, ""), "base64") : raw;
  return bytes.length ? { mime, bytes } : null;
}

function percentDecode(value: string): Buffer {
  const input = Buffer.from(value, "utf8");
  const output = Buffer.alloc(input.length);
  let length = 0;
  for (let i = 0; i < input.length; i += 1) {
    const hex = input[i] === 0x25 ? input.toString("latin1", i + 1, i + 3) : "";
    if (/^[0-9a-f]{2}$/i.test(hex)) {
      output[length++] = parseInt(hex, 16);
      i += 2;
    } else {
      output[length++] = input[i];
    }
  }
  return output.subarray(0, length);
}

/** Registrable domain approximation: the last two labels, or three under `co.uk`-like suffixes. IPs stay whole. */
function siteOf(host: string): string {
  if (host.includes(":") || /^\d+(?:\.\d+){3}$/.test(host)) return host;
  const labels = host.split(".");
  const take = labels.length > 2 && labels[labels.length - 1].length === 2 && SECOND_LEVEL_LABELS.test(labels[labels.length - 2]) ? 3 : 2;
  return labels.slice(-take).join(".");
}

/** Spec section 9: Google Fonts and Adobe Fonts hosts, self-hosted on the page's site, third-party otherwise. */
export function classifySource(url: string, pageHost: string): { source: FontSource; host: string } {
  const host = new URL(url).hostname;
  if (GOOGLE_HOSTS.has(host)) return { source: "google-fonts", host };
  if (ADOBE_HOSTS.has(host)) return { source: "adobe-fonts", host };
  return { source: siteOf(host) === siteOf(pageHost) ? "self-hosted" : "third-party", host };
}

/**
 * Returns a lookup that builds each file once, by URL: a `data:` URI is decoded and parsed, a remote file takes the
 * bytes count and metadata of its capture when it loaded. Null for a `data:` URI without bytes.
 */
export function createFileLookup(captured: Map<string, CapturedFont>, pageHost: string) {
  const files = new Map<string, FileRecord | null>();
  return (url: string, formatHint?: string): FileRecord | null => {
    if (files.has(url)) return files.get(url)!;
    const hinted = formatHint ? FORMAT_HINTS[formatHint.toLowerCase()] : undefined;
    let record: FileRecord | null = null;
    if (isDataUri(url)) {
      const decoded = decodeDataUri(url);
      if (decoded) {
        const meta = parseFontBinary(decoded.bytes);
        const sniffed = sniffFontFormat(decoded.bytes);
        const format = sniffed !== "other" ? sniffed : (hinted ?? "other");
        const mime = FORMAT_MIME[format] ?? (decoded.mime || "application/octet-stream");
        const inline = { mime, base64: decoded.bytes.toString("base64") };
        record = { url: "", format, bytes: decoded.bytes.length, inline, meta, captured: false, source: "data-uri" };
      }
    } else {
      const font = captured.get(url);
      const extension = /\.(woff2|woff|ttf|otf|eot)$/i.exec(new URL(url).pathname)?.[1].toLowerCase();
      const format = font?.meta?.format ?? hinted ?? (extension ? EXTENSION_FORMATS[extension] : "other");
      record = { url, format, bytes: font?.bytes, meta: font?.meta ?? null, captured: !!font, ...classifySource(url, pageHost) };
    }
    files.set(url, record);
    return record;
  };
}
