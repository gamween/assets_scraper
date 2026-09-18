import { createHash } from "node:crypto";
import type { FontFamily, FontFormat, InlineBytes } from "@/lib/contract";
import { percentDecode } from "../percent";
import type { CapturedFont, FontBinaryMeta } from "../types";
import { parseFontBinary, sniffFontFormat } from "./binary";

export type FontSource = FontFamily["source"];

/** One font file: a remote URL, captured during the scan or only declared, or the bytes of a `data:` URI. */
export interface FileRecord {
  url: string; // "" for a data: URI
  format: FontFormat;
  /** For a `data:` URI, set once `FileLookup.take` accepts it, like `inline`. */
  bytes?: number;
  inline?: InlineBytes;
  /** For a `data:` URI, parsed on first read after `take`, so sources a rule does not pick are never parsed. */
  readonly meta: FontBinaryMeta | null;
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
const FORMAT_MIME: Record<Exclude<FontFormat, "other">, string> = {
  woff2: "font/woff2", woff: "font/woff", ttf: "font/ttf", otf: "font/otf", eot: "application/vnd.ms-fontobject",
};
const GOOGLE_HOSTS = new Set(["fonts.gstatic.com", "fonts.googleapis.com"]);
const ADOBE_HOSTS = new Set(["use.typekit.net", "p.typekit.net"]);
const SECOND_LEVEL_LABELS = /^(?:ac|co|com|edu|go|gov|ne|net|or|org)$/;

const KIB = 1024;
const MIB = 1024 * KIB;
/**
 * The most characters of a font file URL other than a `data:` URI, as written and once resolved, and of the base URL it
 * resolves against. Real font URLs have a few hundred, and servers refuse longer request lines (8 KB for nginx and
 * Apache). A file sends its URL twice in the `fonts` line, as `url` and in `proxy`: one 15 MB `url()` gave a 31.5 MB
 * line. And each URL resolved reads its base URL again: the 80,000 sources of a stylesheet served at a 1 MB URL took 88
 * seconds.
 */
export const MAX_URL_CHARS = 8 * KIB;
/**
 * Bounds on the `data:` URI fonts one scan lists: each is decoded, parsed by fontkit synchronously (where the scan
 * deadline cannot stop it) and sent as base64 in the one `fonts` line. Pages that inline fonts use a few small ones.
 */
export const MAX_INLINE_FONTS = 32;
export const MAX_INLINE_BYTES = 4 * MIB;
/** Payload characters decoded to sniff the format of a `data:` URI: enough for the 36 bytes an EOT signature needs. */
const SNIFF_CHARS = 512;
/** Payload characters decoded when the first `SNIFF_CHARS` give fewer than `SNIFF_BYTES`, for whitespace or escapes. */
const SLOW_SNIFF_CHARS = 4 * KIB;
const SNIFF_BYTES = 36;

export const isDataUri = (url: string): boolean => /^data:/i.test(url);

/**
 * `URL.parse` within `MAX_URL_CHARS`: null for a URL over it, as written or resolved. A base URL over it is not read, so
 * only an absolute URL resolves then. Not `new URL`: pages can list a million invalid URLs, and a throw costs 10 times a
 * parse.
 */
export function parseFileUrl(url: string, base?: string): URL | null {
  if (url.length > MAX_URL_CHARS) return null;
  const parsed = URL.parse(url, base !== undefined && base.length <= MAX_URL_CHARS ? base : undefined);
  return parsed && parsed.href.length <= MAX_URL_CHARS ? parsed : null;
}

/** Absolute http(s) URL without its fragment, from `parseFileUrl`, or null. */
export function remoteUrl(url: string, base?: string): string | null {
  const parsed = parseFileUrl(url, base);
  if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) return null;
  parsed.hash = "";
  return parsed.href;
}

/** A `base64` parameter in the header of a `data:` URI, whitespace around it ignored. */
const BASE64_PARAM = /;\s*base64\s*(?=;|$)/i;

/**
 * The media type of a `data:` URI, whether its payload is base64, and the payload. Null without a comma. The header is
 * not split into its parameters: splitting a 15 MB header of semicolons took 660 ms and 308 MB, each time it was read.
 */
function readDataUri(uri: string): { mime: string; base64: boolean; payload: string } | null {
  const comma = uri.indexOf(",");
  if (!isDataUri(uri) || comma < 0) return null;
  const header = uri.slice("data:".length, comma);
  const semicolon = header.indexOf(";");
  const mime = (semicolon < 0 ? header : header.slice(0, semicolon)).trim().toLowerCase();
  return { mime, base64: BASE64_PARAM.test(header), payload: uri.slice(comma + 1) };
}

/** Bytes of a `data:` URI, base64 or percent-encoded. Null when it has no payload. */
export function decodeDataUri(uri: string): { mime: string; bytes: Buffer } | null {
  const parts = readDataUri(uri);
  if (!parts) return null;
  const { mime, base64, payload } = parts;
  const raw = payload.includes("%") ? percentDecode(payload) : Buffer.from(payload, "latin1");
  const bytes = base64 ? Buffer.from(raw.toString("latin1").replace(/\s+/g, ""), "base64") : raw;
  return bytes.length ? { mime, bytes } : null;
}

const isHexDigit = (code: number) => (code >= 0x30 && code <= 0x39) || ((code | 0x20) >= 0x61 && (code | 0x20) <= 0x66);

/**
 * The bytes a `data:` URI decodes to, estimated from its length without decoding it: one per character less 2 per
 * escape, since an escape (`%41`) encodes one byte in 3 characters, then for base64 3 bytes per 4 characters less the
 * padding, which may be escaped too (`%3D`). Escapes are counted as `percentDecode` reads them: a `%` without 2 hex
 * digits after it is one character, which base64 skips. Line breaks and other characters base64 skips make the
 * estimate high. Otherwise it is never above the decoded size, whichever characters are escaped.
 */
function estimateDataUriBytes(uri: string): number {
  const parts = readDataUri(uri);
  if (!parts) return 0;
  const { base64, payload } = parts;
  let escapes = 0;
  for (let index = payload.indexOf("%"); index >= 0; index = payload.indexOf("%", index + 1)) {
    if (isHexDigit(payload.charCodeAt(index + 1)) && isHexDigit(payload.charCodeAt(index + 2))) {
      escapes += 1;
      index += 2;
    }
  }
  const chars = Math.max(0, payload.length - 2 * escapes);
  if (!base64) return chars;
  const tail = payload.slice(-6).replace(/%3d/gi, "=");
  const padding = tail.endsWith("==") ? 2 : tail.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((chars * 3) / 4) - padding);
}

/**
 * A `data:` URI as `URL.parse` serializes it, or null when no scan could list it: its estimated size is over
 * `MAX_INLINE_BYTES`, or it serializes longer than it is written. `URL.parse` writes each control or non-ASCII
 * character, which a font in a URI never has, as 3 to 12 characters: the sources of 16 captured stylesheets of 15 MB
 * took 720 MB. Stylesheets and the CSSOM read their `data:` URIs through it, so that rules never keep such URIs.
 */
export function fontDataUri(uri: string): string | null {
  const href = URL.parse(uri)?.href;
  return href !== undefined && href.length <= uri.length && isDataUri(href) && estimateDataUriBytes(href) <= MAX_INLINE_BYTES ? href : null;
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
 * The format of a `data:` URI from the signature of its first bytes, decoding at most `SLOW_SNIFF_CHARS` of its payload.
 * A payload that starts with more whitespace than that is not a font.
 */
function sniffDataUri(uri: string): FontFormat {
  const comma = uri.indexOf(",");
  if (comma < 0) return "other";
  const end = comma + 1 + SNIFF_CHARS;
  let head = decodeDataUri(uri.slice(0, end))?.bytes;
  // A payload that starts with whitespace or percent escapes can need more characters
  if ((!head || head.length < SNIFF_BYTES) && uri.length > end) head = decodeDataUri(uri.slice(0, comma + 1 + SLOW_SNIFF_CHARS))?.bytes;
  return head ? sniffFontFormat(head) : "other";
}

export interface FileLookup {
  /**
   * The file of a `src` URL, built once per URL: a remote file takes the bytes count and metadata of its capture when
   * it loaded. A `data:` URI whose bytes do not start with a font signature gives null, as does one without bytes.
   */
  file(url: string, formatHint?: string): FileRecord | null;
  /**
   * Whether a file can be listed. Remote files always can. A `data:` URI file is accepted while the scan has listed
   * fewer than `MAX_INLINE_FONTS` of them and its bytes fit in what is left of `MAX_INLINE_BYTES`, and decoded the first
   * time only when its estimated size fits; it then carries `bytes` and `inline`. The answer never changes for a file.
   */
  take(file: FileRecord): boolean;
}

/**
 * The key of a file URL in a `Map` or a `Set`: its SHA-256 digest when it is over `MAX_URL_CHARS`, which only a `data:`
 * URI can be. V8 hashes a string of 16,384 characters or more by its length alone, so distinct `data:` URIs of one
 * length collide and each insert compares them with every earlier one: grouping 7,552 of 16,400 characters took 54
 * seconds. Digests cost the time of reading each URI once.
 */
const fileKey = (url: string) => (url.length > MAX_URL_CHARS ? `sha256:${createHash("sha256").update(url).digest("base64")}` : url);

/** The files of one scan, with its budget of `data:` URI fonts. */
export function createFileLookup(captured: Map<string, CapturedFont>, pageHost: string): FileLookup {
  // By `fileKey`
  const files = new Map<string, FileRecord | null>();
  // How to accept each data: URI file, and the answers given
  const loaders = new Map<FileRecord, () => boolean>();
  const taken = new Map<FileRecord, boolean>();
  let inlineFonts = 0;
  let inlineBytes = 0;

  const dataFile = (uri: string, format: Exclude<FontFormat, "other">): FileRecord => {
    let bytes: Buffer | undefined;
    let meta: FontBinaryMeta | null | undefined;
    const record: FileRecord = {
      url: "",
      format,
      get meta() {
        if (meta === undefined && bytes) meta = parseFontBinary(bytes);
        return meta ?? null;
      },
      captured: false,
      source: "data-uri",
    };
    loaders.set(record, () => {
      if (inlineFonts >= MAX_INLINE_FONTS || estimateDataUriBytes(uri) > MAX_INLINE_BYTES - inlineBytes) return false;
      const decoded = decodeDataUri(uri);
      if (!decoded || inlineBytes + decoded.bytes.length > MAX_INLINE_BYTES) return false;
      inlineFonts += 1;
      inlineBytes += decoded.bytes.length;
      bytes = decoded.bytes;
      record.bytes = bytes.length;
      // The MIME type comes from the sniffed signature, never from the page
      record.inline = { mime: FORMAT_MIME[format], base64: bytes.toString("base64") };
      return true;
    });
    return record;
  };

  return {
    file(url, formatHint) {
      const key = fileKey(url);
      if (files.has(key)) return files.get(key)!;
      let record: FileRecord | null = null;
      if (isDataUri(url)) {
        const format = sniffDataUri(url);
        if (format !== "other") record = dataFile(url, format);
      } else {
        const hinted = formatHint ? FORMAT_HINTS[formatHint.toLowerCase()] : undefined;
        const font = captured.get(url);
        const extension = /\.(woff2|woff|ttf|otf|eot)$/i.exec(new URL(url).pathname)?.[1].toLowerCase();
        const format = font?.meta?.format ?? hinted ?? (extension ? EXTENSION_FORMATS[extension] : "other");
        record = { url, format, bytes: font?.bytes, meta: font?.meta ?? null, captured: !!font, ...classifySource(url, pageHost) };
      }
      files.set(key, record);
      return record;
    },
    take(file) {
      const load = loaders.get(file);
      if (!load) return true;
      let accepted = taken.get(file);
      if (accepted === undefined) taken.set(file, (accepted = load()));
      return accepted;
    },
  };
}
