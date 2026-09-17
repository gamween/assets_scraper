import type { FontFamily, FontFormat, InlineBytes } from "@/lib/contract";
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
 * Bounds on the `data:` URI fonts one scan lists: each is decoded, parsed by fontkit synchronously (where the scan
 * deadline cannot stop it) and sent as base64 in the one `fonts` line. Pages that inline fonts use a few small ones.
 */
export const MAX_INLINE_FONTS = 32;
export const MAX_INLINE_BYTES = 4 * MIB;
/** Payload characters decoded to sniff the format of a `data:` URI: enough for the 36 bytes an EOT signature needs. */
const SNIFF_CHARS = 512;
const SNIFF_BYTES = 36;

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

/** The format of a `data:` URI from the signature of its first bytes, without decoding the whole payload. */
function sniffDataUri(uri: string): FontFormat {
  const comma = uri.indexOf(",");
  if (comma < 0) return "other";
  const end = comma + 1 + SNIFF_CHARS;
  let head = decodeDataUri(uri.slice(0, end))?.bytes;
  // A payload that starts with whitespace or percent escapes can need more characters
  if ((!head || head.length < SNIFF_BYTES) && uri.length > end) head = decodeDataUri(uri)?.bytes;
  return head ? sniffFontFormat(head) : "other";
}

export interface FileLookup {
  /**
   * The file of a `src` URL, built once per URL: a remote file takes the bytes count and metadata of its capture when
   * it loaded. A `data:` URI whose bytes do not start with a font signature gives null, as does one without bytes.
   */
  file(url: string, formatHint?: string): FileRecord | null;
  /**
   * Whether a file can be listed. Remote files always can. A `data:` URI file is decoded the first time, and accepted
   * while the scan has listed fewer than `MAX_INLINE_FONTS` of them and its bytes fit in what is left of
   * `MAX_INLINE_BYTES`; it then carries `bytes` and `inline`. The answer never changes for a file.
   */
  take(file: FileRecord): boolean;
}

/** The files of one scan, with its budget of `data:` URI fonts. */
export function createFileLookup(captured: Map<string, CapturedFont>, pageHost: string): FileLookup {
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
      const decoded = inlineFonts < MAX_INLINE_FONTS ? decodeDataUri(uri) : null;
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
      if (files.has(url)) return files.get(url)!;
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
      files.set(url, record);
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
