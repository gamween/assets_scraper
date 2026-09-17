import { createHash } from "node:crypto";
import type { Page, Response } from "playwright-core";
import sharp from "sharp";
import type { Tone } from "@/lib/contract";
import { limits } from "@/server/config/limits";
import { parseFontBinary } from "./fonts";
import { toneFromBytes } from "./post/tone";
import type { CapturedFont, CapturedImage, CapturedNetwork, CapturedSheet, FontBinaryMeta } from "./types";

export interface CaptureHandle {
  /** Stops recording, gives pending body reads up to `timeoutMs`, then returns what was captured. */
  settle(timeoutMs: number): Promise<CapturedNetwork>;
}

export interface CaptureOptions {
  signal: AbortSignal;
  /** Per-read timeout, `limits.bodyReadMs` by default. */
  bodyReadMs?: number;
  /** Most URLs recorded, images, fonts and stylesheets together; `MAX_RECORDS` by default. */
  maxRecords?: number;
  toneFromBytes?: (buffer: Buffer, contentType: string) => Promise<Tone>;
  parseFontBinary?: (buffer: Buffer) => FontBinaryMeta | null;
}

/**
 * Far more URLs than a real page loads (post-processing keeps at most `limits.maxAssets` assets). A page that requests
 * endless distinct URLs would otherwise grow the records and the queue of pending reads without limit.
 */
const MAX_RECORDS = 4_000;
const FONT_TYPE = /font|woff|opentype|truetype|sfnt/i;
const FONT_EXTENSION = /\.(woff2?|ttf|otf|eot)(?:[?#]|$)/i;
const SVG = (url: string, contentType: string) => /image\/svg/i.test(contentType) || /\.svgz?(?:[?#]|$)/i.test(url);

const isJpeg = (body: Buffer) => body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff;

class BodyTimeout extends Error {}

const timeoutAfter = <T>(promise: Promise<T>, ms: number): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new BodyTimeout()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

/**
 * Network capture (spec 7.4), attached before navigation. Images, fonts and stylesheets are recorded once per URL, up
 * to `maxRecords` URLs (responses past that count as skipped bodies); 3xx responses are skipped. Bodies are read with
 * caps (size, time, concurrency, total bytes), then hashed, measured, toned or parsed and dropped. Only SVG text, CSS
 * text and `blob:` bytes are kept.
 *
 * Playwright hands over a body only whole, so the total cap works by reservation: a read starts only when its declared
 * length, or the per-body cap when no length is declared, still fits next to the bytes already read and the reads in
 * flight. A read that does not fit waits for those to finish.
 */
export function startCapture(page: Page, options: CaptureOptions): CaptureHandle {
  const tone = options.toneFromBytes ?? toneFromBytes;
  const parseFont = options.parseFontBinary ?? parseFontBinary;
  const readMs = options.bodyReadMs ?? limits.bodyReadMs;
  const maxRecords = options.maxRecords ?? MAX_RECORDS;

  const images = new Map<string, CapturedImage>();
  const fonts = new Map<string, CapturedFont>();
  const sheets = new Map<string, CapturedSheet>();
  const jobs = new Set<Promise<void>>();
  const queue: { reserve: number; start: () => void; drop: () => void }[] = [];
  let reading = 0;
  let reserved = 0;
  let bytesRead = 0;
  let blobBytes = 0;
  let tonedRasters = 0;
  let tonedSvgs = 0;
  let toneMs = 0;
  let bodyTimeouts = 0;
  let skippedBodies = 0;
  let stopped = false;

  const isStopped = () => stopped || options.signal.aborted;

  /**
   * Runs `read` once a body slot is free and its reservation fits in the total cap (see above). A body declared over
   * the per-body cap, or over what is left of the total, is skipped without a read. Reads still queued when capture
   * stops never start.
   */
  const schedule = (response: Response, read: (body: Buffer) => Promise<void> | void) => {
    // Undefined gives NaN: no declared length.
    const declared = Number(response.headers()["content-length"]);
    const known = Number.isFinite(declared);
    if (known && (declared > limits.bodyMaxBytes || bytesRead + declared > limits.bodyTotalBytes)) {
      skippedBodies += 1;
      return;
    }
    const job = new Promise<void>((resolve) => {
      queue.push({
        reserve: known ? declared : limits.bodyMaxBytes,
        drop: resolve,
        start: () => {
          // Started alone because it did not fit: what is left of the total still has to hold a declared length.
          const left = limits.bodyTotalBytes - bytesRead;
          if (left <= 0 || (known && declared > left)) {
            skippedBodies += 1;
            return resolve();
          }
          const reserve = Math.min(known ? declared : limits.bodyMaxBytes, left);
          reading += 1;
          reserved += reserve;
          readBody(response)
            .then((body) => body && read(body))
            .catch(() => {})
            .finally(() => {
              reading -= 1;
              reserved -= reserve;
              resolve();
              next();
            });
        },
      });
    });
    jobs.add(job);
    void job.finally(() => jobs.delete(job));
    next();
  };
  const next = () => {
    if (isStopped()) {
      for (const job of queue.splice(0)) job.drop();
      return;
    }
    // Read once: each limit parses the environment, and this loop can walk thousands of queued reads per completion.
    const concurrency = limits.bodyConcurrency;
    const totalBytes = limits.bodyTotalBytes;
    for (let i = 0; i < queue.length && reading < concurrency; ) {
      if (reading > 0 && bytesRead + reserved + queue[i].reserve > totalBytes) {
        i += 1;
        continue;
      }
      queue.splice(i, 1)[0].start();
    }
  };

  /**
   * The body within the caps, or undefined (counted as a timeout or a skip). A declared length can be smaller than the
   * body (it counts compressed bytes), so the caps are checked again on the real size.
   */
  const readBody = async (response: Response): Promise<Buffer | undefined> => {
    let body: Buffer;
    try {
      body = await timeoutAfter(response.body(), readMs);
    } catch (error) {
      if (error instanceof BodyTimeout) bodyTimeouts += 1;
      return undefined;
    }
    bytesRead += body.length;
    if (body.length > limits.bodyMaxBytes || bytesRead > limits.bodyTotalBytes) {
      skippedBodies += 1;
      return undefined;
    }
    return body;
  };

  const toneOf = async (body: Buffer, contentType: string, svg: boolean): Promise<Tone> => {
    if (body.length > limits.toneMaxBytes || toneMs >= limits.toneBudgetMs) return "unknown";
    // A JPEG is opaque without decoding (spec 8.8), so it uses none of the raster budget.
    if (svg ? tonedSvgs >= limits.toneMaxSvgs : !isJpeg(body) && tonedRasters >= limits.toneMaxRasters) return "unknown";
    if (svg) tonedSvgs += 1;
    else if (!isJpeg(body)) tonedRasters += 1;
    const started = performance.now();
    try {
      return await tone(body, contentType);
    } catch {
      return "unknown";
    } finally {
      toneMs += performance.now() - started;
    }
  };

  const captureImage = async (record: CapturedImage, body: Buffer) => {
    record.bytes = body.length;
    record.sha1 = createHash("sha1").update(body).digest("hex");
    const svg = SVG(record.url, record.contentType);
    // An SVG over the markup cap is dropped as noise (spec 8.2), so its size is never used: no need to parse it.
    if (!svg || body.length <= limits.svgMaxBytes) {
      try {
        const { width, height } = await sharp(body).metadata();
        if (width && height) Object.assign(record, { width, height });
      } catch {
        // Not a format sharp reads (ico, broken bytes): no dimensions.
      }
    }
    record.tone = await toneOf(body, record.contentType, svg);
    if (svg && body.length <= limits.svgMaxBytes) record.svgText = body.toString("utf8");
    if (record.url.startsWith("blob:") && body.length <= limits.blobMaxBytes && blobBytes + body.length <= limits.blobTotalBytes) {
      blobBytes += body.length;
      record.blobBase64 = body.toString("base64");
    }
  };

  const captureFont = (record: CapturedFont, body: Buffer) => {
    record.bytes = body.length;
    record.sha1 = createHash("sha1").update(body).digest("hex");
    try {
      record.meta = parseFont(body);
    } catch {
      record.meta = null;
    }
  };

  const captureSheet = (record: CapturedSheet, body: Buffer) => {
    record.cssText = body.toString("utf8");
  };

  const onResponse = (response: Response) => {
    if (isStopped()) return;
    const url = response.url();
    const status = response.status();
    if (url.startsWith("data:") || (status >= 300 && status < 400)) return;
    const headers = response.headers();
    const contentType = headers["content-type"] ?? "";
    const resourceType = response.request().resourceType();
    const readable = status < 400;
    const full = () => {
      if (images.size + fonts.size + sheets.size < maxRecords) return false;
      skippedBodies += 1;
      return true;
    };

    if (resourceType === "font" || FONT_TYPE.test(contentType) || FONT_EXTENSION.test(url)) {
      if (fonts.has(url) || full()) return;
      const record: CapturedFont = { url, status, contentType, meta: null };
      fonts.set(url, record);
      if (readable) schedule(response, (body) => captureFont(record, body));
    } else if (resourceType === "image" || /^image\//i.test(contentType)) {
      if (images.has(url) || full()) return;
      const record: CapturedImage = { url, status, contentType, tone: "unknown" };
      if (headers.server) record.server = headers.server;
      images.set(url, record);
      if (readable) schedule(response, (body) => captureImage(record, body));
    } else if (resourceType === "stylesheet" || /^text\/css/i.test(contentType)) {
      if (sheets.has(url) || full()) return;
      const record: CapturedSheet = { url, status, cssText: "" };
      sheets.set(url, record);
      if (readable) schedule(response, (body) => captureSheet(record, body));
    }
  };

  page.on("response", onResponse);

  return {
    async settle(timeoutMs) {
      if (!stopped) {
        stopped = true;
        page.off("response", onResponse);
        next();
      }
      if (jobs.size) await timeoutAfter(Promise.allSettled([...jobs]), timeoutMs).catch(() => {});
      return {
        images: [...images.values()].map((record) => ({ ...record })),
        fonts: [...fonts.values()].map((record) => ({ ...record })),
        sheets: [...sheets.values()].map((record) => ({ ...record })),
        bodyTimeouts,
        skippedBodies,
      };
    },
  };
}
