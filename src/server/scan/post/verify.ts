import sharp from "sharp";
import type { AssetFormat } from "@/lib/contract";
import type { SafeFetch } from "../types";
import { formatFromContentType, sniffFormat } from "./format";

/**
 * Verification of CDN originals and probes of URLs the browser never requested (spec 8.4): a ranged GET that reads at
 * most the first 256 KB, accepts images only, and reads the full size and the dimensions from what it got.
 */

export const VERIFY_RANGE_BYTES = 262_144;
export const VERIFY_ACCEPT = "image/png,image/jpeg,image/gif,image/svg+xml,*/*;q=0.5";
/** A normal desktop Chrome user agent, never "HeadlessChrome". */
export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";

export type VerifySkipped = { ok: false; reason: "verify-skipped" };
const SKIPPED: VerifySkipped = Object.freeze({ ok: false, reason: "verify-skipped" });

export type VerifyResult =
  | {
      ok: true;
      url: string;             // final URL after redirects
      contentType: string;
      format: AssetFormat;
      bytes?: number;          // full size of the file
      width?: number;
      height?: number;
      complete: boolean;       // the whole file was read
      body?: Buffer;           // the bytes, only when complete
    }
  | { ok: false; reason: "http" | "not-image" | "network"; status?: number }
  | VerifySkipped;

export interface VerifyOptions {
  fetch: SafeFetch;
  pageUrl: string;
  signal: AbortSignal;
  deadline: number;            // epoch ms
}

const readPrefix = async (stream: ReadableStream<Uint8Array>, max: number) => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let complete = false;
  try {
    while (length < max) {
      const { done, value } = await reader.read();
      if (done) {
        complete = true;
        break;
      }
      chunks.push(value);
      length += value.length;
    }
  } finally {
    if (!complete) await reader.cancel().catch(() => {});
  }
  const body = Buffer.concat(chunks);
  return { body: body.subarray(0, max), complete: complete && body.length <= max };
};

const totalBytes = (headers: Headers, status: number, body: Buffer, complete: boolean): number | undefined => {
  const range = /\/(\d+)\s*$/.exec(headers.get("content-range") ?? "");
  if (range) return Number(range[1]);
  const length = Number(headers.get("content-length"));
  if (status === 200 && !headers.get("content-encoding") && Number.isSafeInteger(length) && length > 0) return length;
  return complete ? body.length : undefined;
};

/** Dimensions from image headers, for partial bodies sharp cannot open. */
const headerDimensions = (b: Buffer, format: AssetFormat): { width: number; height: number } | undefined => {
  if (format === "gif" && b.length >= 10) return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  if (format === "bmp" && b.length >= 26) return { width: b.readInt32LE(18), height: Math.abs(b.readInt32LE(22)) };
  if (format === "ico" && b.length >= 6) {
    let best: { width: number; height: number } | undefined;
    for (let i = 0, count = b.readUInt16LE(4); i < count && 6 + 16 * (i + 1) <= b.length; i++) {
      const width = b[6 + 16 * i] || 256;
      const height = b[7 + 16 * i] || 256;
      if (!best || width * height > best.width * best.height) best = { width, height };
    }
    return best;
  }
  if (format === "webp" && b.length >= 30) {
    const chunk = b.toString("latin1", 12, 16);
    if (chunk === "VP8X") return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    if (chunk === "VP8 ") return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    if (chunk === "VP8L") {
      const bits = b.readUInt32LE(21);
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
    }
  }
  return undefined;
};

/** Image dimensions from the first bytes of a file, when they can be read. */
export async function imageDimensions(body: Buffer, format: AssetFormat, complete: boolean): Promise<{ width?: number; height?: number }> {
  if (format === "svg" && !complete) return {};
  try {
    const { width, height } = await sharp(body, { failOn: "none", limitInputPixels: false }).metadata();
    if (width && height) return { width, height };
  } catch {
    // partial or unsupported: fall back to the header
  }
  const size = headerDimensions(body, format);
  return size && size.width > 0 && size.height > 0 ? size : {};
}

/** A request that never produced a response. Kept apart from a refusal, which is an answer and is not retried. */
const TRANSPORT_FAILURE = Symbol("transport-failure");

async function attempt(url: string, options: VerifyOptions, ranged: boolean): Promise<VerifyResult | typeof TRANSPORT_FAILURE> {
  const remaining = options.deadline - Date.now();
  if (options.signal.aborted || remaining <= 0) return SKIPPED;
  try {
    const response = await options.fetch(url, {
      method: "GET",
      headers: {
        ...(ranged ? { range: `bytes=0-${VERIFY_RANGE_BYTES - 1}` } : {}),
        accept: VERIFY_ACCEPT,
        "user-agent": BROWSER_USER_AGENT,
        referer: options.pageUrl,
      },
      timeoutMs: remaining,
      signal: options.signal,
    });
    if (response.status < 200 || response.status > 299) {
      await response.cancel().catch(() => {});
      return { ok: false, reason: "http", status: response.status };
    }
    const contentType = (response.headers.get("content-type") ?? "").trim();
    const mime = contentType.split(";")[0].trim().toLowerCase();
    const generic = !mime || /^(?:application|binary)\/octet-stream$/.test(mime);
    if (!generic && !mime.startsWith("image/")) {
      await response.cancel().catch(() => {});
      return { ok: false, reason: "not-image", status: response.status };
    }
    const { body, complete } = await readPrefix(response.stream(), VERIFY_RANGE_BYTES);
    const format = generic ? sniffFormat(body) : formatFromContentType(contentType, response.url || url);
    if (generic && format === "other") return { ok: false, reason: "not-image", status: response.status };
    return {
      ok: true,
      url: response.url || url,
      contentType,
      format,
      bytes: totalBytes(response.headers, response.status, body, complete),
      ...(await imageDimensions(body, format, complete)),
      complete,
      ...(complete ? { body } : {}),
    };
  } catch {
    return options.signal.aborted || Date.now() >= options.deadline ? SKIPPED : TRANSPORT_FAILURE;
  }
}

/**
 * Reads enough of `url` to say whether it is an image, and how big (spec 8.4).
 *
 * The request asks for a range, so a large file costs a prefix instead of the whole body. Some HTTP/2 CDN edges answer
 * a ranged request by resetting the stream mid-body (NGHTTP2_INTERNAL_ERROR), which used to end the check: the caller
 * saw a network failure and kept the transformed URL the page served, on hosts whose original was perfectly reachable.
 * A transport failure on the ranged request is therefore retried once without the range. It costs one extra request,
 * only on a URL that already failed, and `readPrefix` still stops reading at the same prefix.
 */
export async function verifyUrl(url: string, options: VerifyOptions): Promise<VerifyResult> {
  const ranged = await attempt(url, options, true);
  if (ranged !== TRANSPORT_FAILURE) return ranged;
  const plain = await attempt(url, options, false);
  return plain === TRANSPORT_FAILURE ? { ok: false, reason: "network" } : plain;
}

export interface Limiter {
  /** Runs `task` when a slot is free, or resolves `verify-skipped` when the deadline passes first. */
  run<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T | VerifySkipped>;
  readonly skipped: number;
  /** Stops the deadline timer. */
  close(): void;
}

/**
 * A concurrency limiter with a deadline: queued tasks start in order while slots are free and time remains. At the
 * deadline, or when `signal` aborts, queued tasks resolve `verify-skipped` and running tasks get an aborted signal.
 */
export function createLimiter(options: { concurrency: number; deadline: number; signal?: AbortSignal }): Limiter {
  const controller = new AbortController();
  const queue: (() => void)[] = [];
  let active = 0;
  let skipped = 0;
  const stop = () => {
    if (!controller.signal.aborted) controller.abort();
    for (const start of queue.splice(0)) start();
  };
  const timer = setTimeout(stop, Math.max(0, options.deadline - Date.now()));
  if (options.signal?.aborted) stop();
  else options.signal?.addEventListener("abort", stop, { once: true });

  const next = () => {
    while (active < options.concurrency && queue.length) queue.shift()!();
  };

  return {
    run<T>(task: (signal: AbortSignal) => Promise<T>) {
      return new Promise<T | VerifySkipped>((resolve, reject) => {
        queue.push(() => {
          if (controller.signal.aborted || Date.now() >= options.deadline) {
            skipped++;
            resolve(SKIPPED);
            return;
          }
          active++;
          task(controller.signal)
            .then(resolve, reject)
            .finally(() => {
              active--;
              next();
            });
        });
        next();
      });
    },
    get skipped() {
      return skipped;
    },
    close() {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", stop);
    },
  };
}

/** Runs tasks with `concurrency` slots until `deadline`; tasks that could not start give `verify-skipped`. */
export async function runVerifications<T>(
  tasks: ((signal: AbortSignal) => Promise<T>)[],
  options: { concurrency: number; deadline: number; signal?: AbortSignal },
): Promise<(T | VerifySkipped)[]> {
  const limiter = createLimiter(options);
  try {
    return await Promise.all(tasks.map((task) => limiter.run(task)));
  } finally {
    limiter.close();
  }
}
