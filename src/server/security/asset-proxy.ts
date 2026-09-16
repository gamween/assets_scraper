import { limits } from "@/server/config/limits";
import { HttpError } from "@/server/errors";
import { safeFetch, SafeFetchError, type SafeFetchErrorCode } from "@/server/net/safe-fetch";
import { isConvertibleFont, parseFontBinary } from "@/server/scan/fonts/index";
import type { FontBinaryMeta, SafeResponse } from "@/server/scan/types";
import { takeProxyBytes } from "./budget";
import { verifyAssetParams } from "./sign";

export interface AssetProxyOptions {
  maxBytes?: number;
  timeoutMs?: number;
}

const SAFETY_HEADERS = {
  "content-security-policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; sandbox",
  "x-content-type-options": "nosniff",
  "cross-origin-resource-policy": "same-origin",
  vary: "Sec-Fetch-Site",
} as const;

const CACHE_HEADERS = {
  "cache-control": "private, max-age=3600",
  "vercel-cdn-cache-control": "public, s-maxage=86400",
} as const;

const SNIFF_BYTES = 512;
const MEDIA_TYPE = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/;
const UNTYPED = new Set(["", "application/octet-stream", "binary/octet-stream"]);
const FETCH_STATUS: Record<SafeFetchErrorCode, number> = {
  "invalid-url": 403, "blocked-address": 403, "own-host": 403, "unsupported-port": 403,
  dns: 502, connect: 502, "too-many-redirects": 502, aborted: 502, timeout: 504, "too-large": 413,
};

function errorResponse(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status, headers: { ...SAFETY_HEADERS, "cache-control": "no-store" } });
}

const startsWith = (bytes: Uint8Array, text: string, offset = 0) =>
  bytes.length >= offset + text.length && Buffer.from(bytes.subarray(offset, offset + text.length)).toString("latin1") === text;

/** Content type from magic bytes for the formats the proxy serves (spec 11.2), or null. */
export function sniffContentType(bytes: Uint8Array): string | null {
  if (startsWith(bytes, "\x89PNG\r\n\x1a\n")) return "image/png";
  if (startsWith(bytes, "\xff\xd8\xff")) return "image/jpeg";
  if (startsWith(bytes, "GIF87a") || startsWith(bytes, "GIF89a")) return "image/gif";
  if (startsWith(bytes, "RIFF") && startsWith(bytes, "WEBP", 8)) return "image/webp";
  if (startsWith(bytes, "ftyp", 4)) {
    const boxSize = Math.min(Buffer.from(bytes.subarray(0, 4)).readUInt32BE(0), bytes.length);
    for (let offset = 8; offset + 4 <= boxSize; offset += 4) {
      if (offset === 12) continue; // minor version
      if (startsWith(bytes, "avif", offset) || startsWith(bytes, "avis", offset)) return "image/avif";
    }
  }
  if (startsWith(bytes, "\x00\x00\x01\x00")) return "image/x-icon";
  if (startsWith(bytes, "wOFF")) return "font/woff";
  if (startsWith(bytes, "wOF2")) return "font/woff2";
  if (startsWith(bytes, "\x00\x01\x00\x00") || startsWith(bytes, "true")) return "font/ttf";
  if (startsWith(bytes, "OTTO")) return "font/otf";
  const text = Buffer.from(bytes).toString("utf8").replace(/^\uFEFF/, "");
  if (/^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!doctype\s+svg[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(text)) return "image/svg+xml";
  return null;
}

function allowedDeclaredType(mediaType: string): boolean {
  return MEDIA_TYPE.test(mediaType) && /^(?:image\/|font\/|application\/font-|application\/x-font-)/.test(mediaType);
}

/** `attachment` file name: last path segment, no control, bidi or reserved characters, no dot runs. */
function contentDisposition(dl: string | undefined): string {
  if (dl === undefined) return "inline";
  const name =
    (dl.split(/[\\/]/).pop() ?? "")
      .replace(/[\u0000-\u001f\u007f\u200E\u200F\u202A-\u202E\u2066-\u2069<>:"|?*]/g, "")
      .replace(/\.{2,}/g, ".")
      .replace(/^[.\s]+|[.\s]+$/g, "")
      .slice(0, 200) || "download";
  const encoded = encodeURIComponent(name).replace(/['()*!]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename*=UTF-8''${encoded}`;
}

/** Reads at least `SNIFF_BYTES` (or the whole body when shorter) and returns them with the rest of the stream. */
async function peek(stream: ReadableStream<Uint8Array>): Promise<{ head: Uint8Array; rest: ReadableStreamDefaultReader<Uint8Array> }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < SNIFF_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  return { head: Buffer.concat(chunks), rest: reader };
}

/** `fmt=ttf`: the whole font, licence-checked, WOFF2 decompressed to its sfnt (TrueType or CFF outlines). */
async function convertFont(upstream: SafeResponse, signal: AbortSignal, headers: Record<string, string>): Promise<Response> {
  const source = await upstream.buffer();
  const sourceType = sniffContentType(source);
  if (sourceType !== "font/woff2" && sourceType !== "font/ttf" && sourceType !== "font/otf") {
    return errorResponse(415, "not-convertible", "Only WOFF2, TTF and OTF fonts can be served as TTF.");
  }
  let meta: FontBinaryMeta | null = null;
  try {
    meta = parseFontBinary(source);
  } catch {}
  if (!(await isConvertibleFont(meta, { fetch: safeFetch, signal }))) {
    return errorResponse(403, "license", "This font's licence does not allow conversion.");
  }
  let output: Buffer = source;
  if (sourceType === "font/woff2") {
    try {
      const { decompress } = await import("wawoff2");
      output = Buffer.from(await decompress(source));
    } catch {
      return errorResponse(415, "not-convertible", "The font could not be converted.");
    }
  }
  if (!(await takeProxyBytes(output.length))) return errorResponse(429, "budget", "Daily download limit reached.");
  const contentType = sniffContentType(output) === "font/otf" ? "font/otf" : "font/ttf";
  return new Response(new Uint8Array(output), { headers: { ...headers, "content-type": contentType, "content-length": String(output.length) } });
}

/**
 * Signed byte proxy behind `GET /api/asset` (spec 11.2): same-origin callers only, HMAC-checked URL, SSRF-safe fetch
 * with size and time caps, image and font types only (untyped bytes by magic number), sandboxed and not sniffable,
 * cached on the CDN, and counted against the daily proxied bytes budget. `fmt=ttf` converts an open-licence WOFF2.
 */
export async function handleAssetRequest(request: Request, options: AssetProxyOptions = {}): Promise<Response> {
  const maxBytes = options.maxBytes ?? limits.proxyMaxBytes;
  const timeoutMs = options.timeoutMs ?? limits.proxyTimeoutMs;
  try {
    const site = request.headers.get("sec-fetch-site");
    if (site !== null && site !== "same-origin" && site !== "none") return errorResponse(403, "cross-site", "Cross-site requests are not allowed.");

    const { url, dl, fmt } = verifyAssetParams(new URL(request.url).searchParams);
    if (!(await takeProxyBytes(0))) return errorResponse(429, "budget", "Daily download limit reached.");

    const upstream = await safeFetch(url, {
      headers: { referer: `${new URL(url).origin}/` },
      maxBytes,
      timeoutMs,
      maxRedirects: limits.proxyMaxRedirects,
      signal: request.signal,
    });
    if (upstream.status < 200 || upstream.status > 299) {
      await upstream.cancel();
      return errorResponse(502, "upstream-status", `The asset host answered ${upstream.status}.`);
    }

    const headers: Record<string, string> = { ...SAFETY_HEADERS, ...CACHE_HEADERS, "content-disposition": contentDisposition(dl) };

    if (fmt === "ttf") return await convertFont(upstream, request.signal, headers);

    const declared = (upstream.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    const encoded = upstream.headers.has("content-encoding");
    const length = Number(upstream.headers.get("content-length") ?? Number.NaN);
    const knownLength = !encoded && Number.isSafeInteger(length) && length >= 0 ? length : undefined;
    if (knownLength !== undefined && knownLength > maxBytes) {
      await upstream.cancel();
      return errorResponse(413, "too-large", "The asset is too large.");
    }
    if (!allowedDeclaredType(declared) && !UNTYPED.has(declared)) {
      await upstream.cancel();
      return errorResponse(415, "unsupported-type", "Only images and fonts can be downloaded.");
    }

    const { head, rest } = await peek(upstream.stream());
    const contentType = UNTYPED.has(declared) ? sniffContentType(head) : declared;
    if (!contentType) {
      await rest.cancel().catch(() => {});
      return errorResponse(415, "unsupported-type", "Only images and fonts can be downloaded.");
    }
    if (knownLength !== undefined && !(await takeProxyBytes(knownLength))) {
      await rest.cancel().catch(() => {});
      return errorResponse(429, "budget", "Daily download limit reached.");
    }

    let served = head.byteLength;
    let accounted = knownLength !== undefined;
    const account = () => {
      if (accounted) return;
      accounted = true;
      takeProxyBytes(served).catch(() => {});
    };
    const body = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          if (head.byteLength > 0) controller.enqueue(head);
        },
        async pull(controller) {
          try {
            const { done, value } = await rest.read();
            if (done) {
              account();
              controller.close();
              return;
            }
            served += value.byteLength;
            controller.enqueue(value);
          } catch (error) {
            account();
            controller.error(error);
          }
        },
        cancel(reason) {
          account();
          return rest.cancel(reason);
        },
      },
      { highWaterMark: 0 },
    );
    return new Response(body, {
      headers: { ...headers, "content-type": contentType, ...(knownLength !== undefined && { "content-length": String(knownLength) }) },
    });
  } catch (error) {
    if (error instanceof HttpError) return errorResponse(error.status, error.code, error.message);
    if (error instanceof SafeFetchError) return errorResponse(FETCH_STATUS[error.code], error.code, "The asset could not be fetched.");
    console.error(`Asset proxy failed: ${error instanceof Error ? error.message : String(error)}`);
    return errorResponse(500, "internal", "Something went wrong.");
  }
}
