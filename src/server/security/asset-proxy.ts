import { limits } from "@/server/config/limits";
import { HttpError } from "@/server/errors";
import { safeFetch, SafeFetchError, type SafeFetchErrorCode } from "@/server/net/safe-fetch";
import { isConvertibleFont, parseFontBinary } from "@/server/scan/fonts/index";
import type { FontBinaryMeta, SafeResponse } from "@/server/scan/types";
import { countProxyBytes, takeProxyBytes } from "./budget";
import { contentDisposition } from "./download-name";
import { verifyAssetParams } from "./sign";
import { SNIFF_BYTES, sniffContentType } from "./sniff";

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

const RESPONSE_HEADERS = {
  ...SAFETY_HEADERS,
  "cache-control": "private, max-age=3600",
  "vercel-cdn-cache-control": "public, s-maxage=86400",
} as const;

const MEDIA_TYPE = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/;
const UNTYPED = new Set(["", "application/octet-stream", "binary/octet-stream"]);
const WOFF2_SIGNATURE_BYTES = 4;
/**
 * `fmt=ttf` buffers the source and decompresses it on the main thread into a WebAssembly heap that never shrinks, so
 * sources are capped well below the proxy cap (web fonts are rarely over a few MB) and at most this many conversions,
 * download included, run at once per instance.
 */
const CONVERT_MAX_BYTES = 10 * 1024 * 1024;
const CONVERT_SLOTS = 2;
const FETCH_STATUS: Record<SafeFetchErrorCode, number> = {
  "invalid-url": 403, "blocked-address": 403, "own-host": 403, "unsupported-port": 403,
  dns: 502, connect: 502, "too-many-redirects": 502, aborted: 502, timeout: 504, "too-large": 413,
};

/**
 * `error.code` values in asset proxy JSON errors. They are not the scan `ErrorCode` enum of the contract: clients
 * handle proxy failures by HTTP status (403, 400, 413, 415, 429, 5xx) and must not parse these bodies with `ApiError`.
 */
export type AssetProxyErrorCode =
  | "method" | "cross-site" | "invalid-params" | "bad-signature" | "expired" | "budget" | "upstream-status" | "too-large"
  | "unsupported-type" | "not-convertible" | "license" | "busy" | "internal" | SafeFetchErrorCode;

function errorResponse(status: number, code: AssetProxyErrorCode, message: string, headers: Record<string, string> = {}): Response {
  return Response.json({ error: { code, message } }, { status, headers: { ...SAFETY_HEADERS, "cache-control": "no-store", ...headers } });
}

let conversions = 0;
const conversionQueue: (() => void)[] = [];

/**
 * Takes one of the `CONVERT_SLOTS` conversion slots, waiting in order for a free one. Resolves with the slot's
 * idempotent release, or null when `signal` aborts first.
 */
function takeConversionSlot(signal: AbortSignal): Promise<(() => void) | null> {
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const next = conversionQueue.shift();
    if (next) next();
    else conversions -= 1;
  };
  return new Promise((resolve) => {
    if (conversions < CONVERT_SLOTS) {
      conversions += 1;
      resolve(release);
      return;
    }
    if (signal.aborted) {
      resolve(null);
      return;
    }
    const grant = () => {
      signal.removeEventListener("abort", giveUp);
      resolve(release);
    };
    const giveUp = () => {
      const index = conversionQueue.indexOf(grant);
      if (index !== -1) conversionQueue.splice(index, 1);
      resolve(null);
    };
    conversionQueue.push(grant);
    signal.addEventListener("abort", giveUp, { once: true });
  });
}

/** The upstream response, or the error response for a status outside 2xx. */
async function fetchAsset(url: string, signal: AbortSignal, maxBytes: number, timeoutMs: number): Promise<SafeResponse | Response> {
  const upstream = await safeFetch(url, {
    headers: { referer: `${new URL(url).origin}/` },
    maxBytes,
    timeoutMs,
    maxRedirects: limits.proxyMaxRedirects,
    signal,
  });
  if (upstream.status >= 200 && upstream.status <= 299) return upstream;
  await upstream.cancel();
  return errorResponse(502, "upstream-status", `The asset host answered ${upstream.status}.`);
}

function allowedDeclaredType(mediaType: string): boolean {
  return MEDIA_TYPE.test(mediaType) && /^(?:image\/|font\/|application\/font-|application\/x-font-)/.test(mediaType);
}

/** Reads at least `minBytes` (or the whole body when shorter) and returns them with the rest of the stream. */
async function peek(
  stream: ReadableStream<Uint8Array>,
  minBytes: number,
): Promise<{ head: Uint8Array; rest: ReadableStreamDefaultReader<Uint8Array> }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < minBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  return { head: Buffer.concat(chunks), rest: reader };
}

async function readAll(reader: ReadableStreamDefaultReader<Uint8Array>, head: Uint8Array): Promise<Buffer> {
  const chunks = [head];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks);
    chunks.push(value);
  }
}

/**
 * `fmt=ttf`: an open-licence WOFF2 of at most `CONVERT_MAX_BYTES`, buffered whole, decompressed to the sfnt it wraps.
 * That is `font/ttf` for TrueType outlines and `font/otf` for CFF outlines (`OTTO`), which cannot become TrueType
 * without re-drawing the glyphs, so callers name the file from the content type. Other sources get 415 from their first
 * bytes, before the rest is downloaded: TTF and OTF files are served as they are without `fmt`. The whole exchange,
 * waiting for a conversion slot included, stays within `timeoutMs`; no free slot in time gives 503.
 */
async function convertFont(
  url: string,
  dl: string | undefined,
  signal: AbortSignal,
  { maxBytes, timeoutMs }: { maxBytes: number; timeoutMs: number },
): Promise<Response> {
  const busy = () => errorResponse(503, "busy", "Too many fonts are being converted. Try again in a moment.", { "retry-after": "5" });
  const started = Date.now();
  const release = await takeConversionSlot(AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]));
  if (!release) return busy();
  try {
    const remainingMs = timeoutMs - (Date.now() - started);
    if (remainingMs <= 0) return busy();
    const upstream = await fetchAsset(url, signal, Math.min(maxBytes, CONVERT_MAX_BYTES), remainingMs);
    if (upstream instanceof Response) return upstream;
    return await decompressFont(upstream, signal, dl);
  } finally {
    release();
  }
}

async function decompressFont(upstream: SafeResponse, signal: AbortSignal, dl: string | undefined): Promise<Response> {
  const { head, rest } = await peek(upstream.stream(), WOFF2_SIGNATURE_BYTES);
  if (sniffContentType(head) !== "font/woff2") {
    await rest.cancel().catch(() => {});
    return errorResponse(415, "not-convertible", "Only WOFF2 fonts can be converted.");
  }
  const source = await readAll(rest, head);
  let meta: FontBinaryMeta | null = null;
  try {
    meta = parseFontBinary(source);
  } catch {}
  if (!(await isConvertibleFont(meta, { fetch: safeFetch, signal }))) {
    return errorResponse(403, "license", "This font's licence does not allow conversion.");
  }
  let output: Buffer;
  try {
    const { decompress } = await import("wawoff2");
    output = Buffer.from(await decompress(source));
  } catch {
    return errorResponse(415, "not-convertible", "The font could not be converted.");
  }
  const contentType = sniffContentType(output);
  if (contentType !== "font/ttf" && contentType !== "font/otf") return errorResponse(415, "not-convertible", "The font could not be converted.");
  if (!(await takeProxyBytes(output.length))) return errorResponse(429, "budget", "Daily download limit reached.");
  return new Response(new Uint8Array(output), {
    headers: {
      ...RESPONSE_HEADERS,
      "content-type": contentType,
      "content-length": String(output.length),
      "content-disposition": contentDisposition(dl, contentType),
    },
  });
}

/**
 * Signed byte proxy behind `GET /api/asset` (spec 11.2): GET only, same-origin callers only, HMAC-checked URL, SSRF-safe
 * fetch with size and time caps, image and font types only (untyped bytes by magic number), sandboxed and not
 * sniffable, cached on the CDN, and counted against the daily proxied bytes budget. `fmt=ttf` decompresses an
 * open-licence WOFF2.
 */
export async function handleAssetRequest(request: Request, options: AssetProxyOptions = {}): Promise<Response> {
  const maxBytes = options.maxBytes ?? limits.proxyMaxBytes;
  const timeoutMs = options.timeoutMs ?? limits.proxyTimeoutMs;
  try {
    // A HEAD would fetch the upstream for headers alone and leave a body of unknown length unread and uncounted.
    if (request.method !== "GET") return errorResponse(405, "method", "Use GET.", { allow: "GET" });

    // Spec 11.2: only this app's pages (same-origin) or a link opened directly (none). A missing header is refused
    // too, so every browser with Fetch Metadata is covered; scripts can forge the header, the byte budget bounds them.
    const site = request.headers.get("sec-fetch-site");
    if (site !== "same-origin" && site !== "none") return errorResponse(403, "cross-site", "Only this app can load proxied assets.");

    const { url, dl, fmt } = verifyAssetParams(new URL(request.url).searchParams);
    if (!(await takeProxyBytes(0))) return errorResponse(429, "budget", "Daily download limit reached.");
    if (fmt === "ttf") return await convertFont(url, dl, request.signal, { maxBytes, timeoutMs });

    const upstream = await fetchAsset(url, request.signal, maxBytes, timeoutMs);
    if (upstream instanceof Response) return upstream;

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

    // Only untyped bodies wait for their first bytes; a declared image or font type streams from the first chunk.
    const untyped = UNTYPED.has(declared);
    const { head, rest } = untyped ? await peek(upstream.stream(), SNIFF_BYTES) : { head: new Uint8Array(0), rest: upstream.stream().getReader() };
    const contentType = untyped ? sniffContentType(head) : declared;
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
      countProxyBytes(served).catch(() => {});
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
      headers: {
        ...RESPONSE_HEADERS,
        "content-type": contentType,
        "content-disposition": contentDisposition(dl, contentType),
        ...(knownLength !== undefined && { "content-length": String(knownLength) }),
      },
    });
  } catch (error) {
    if (error instanceof HttpError) return errorResponse(error.status, error.code as AssetProxyErrorCode, error.message);
    if (error instanceof SafeFetchError) return errorResponse(FETCH_STATUS[error.code], error.code, "The asset could not be fetched.");
    console.error(`Asset proxy failed: ${error instanceof Error ? error.message : String(error)}`);
    return errorResponse(500, "internal", "Something went wrong.");
  }
}
