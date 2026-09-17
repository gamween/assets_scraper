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
/**
 * An encoded body (gzip, br) declared over this fraction of the per-body cap is skipped unread: the text formats the
 * capture reads (SVG, CSS) decode to 4 to 10 times their compressed size, so it would almost always be over the cap.
 */
const ENCODED_EXPANSION = 4;
/**
 * Font parsing budgets. Parsing is synchronous on the event loop (a 5 MB WOFF2 takes about 200 ms), and any response
 * whose URL ends in a font extension counts as a font, so a page controls how many there are and how large. Past a cap
 * a font is still hashed, but has no metadata.
 */
const FONT_PARSE_MAX_BYTES = 5 * 1024 * 1024;
const FONT_PARSE_BUDGET_MS = 1_500;
const FONT_PARSE_MAX_FILES = 40;
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
 * caps (size, time, concurrency, total bytes), then hashed, measured, toned or parsed within budgets and dropped. Only
 * SVG text, CSS text and `blob:` bytes are kept.
 *
 * Playwright hands over a body only whole, so the total cap works by reservation: a read starts only when its declared
 * length, or the per-body cap when no length is declared, still fits next to the bytes already read and the reads in
 * flight. A read that does not fit waits for those to finish.
 *
 * `content-length` counts the bytes on the wire, but Playwright hands over the decoded body. So an encoded body
 * (`content-encoding` other than identity) reserves the per-body cap like a body with no declared length, and one
 * declared over a quarter of the cap is skipped unread (see ENCODED_EXPANSION). Limit: the real size of a body is only
 * known once Playwright has read it whole into Node memory. The caps apply to that size, so a body with no declared
 * length, or one that decodes to far more than its declared length, is bounded by what the browser holds (and the
 * memory watchdog), not by the per-body cap.
 *
 * A read that times out is given up, but Playwright cannot cancel it: once the response ends, the whole body still
 * crosses into Node. So a given-up read keeps its concurrency slot and its reservation until Playwright is done with the
 * body, and that body counts toward the total when it lands. The concurrency and total caps hold for those bodies too;
 * the price is that a response that never ends holds its slot until the browser closes.
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
  let parsedFonts = 0;
  let fontParseMs = 0;
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
    const headers = response.headers();
    // Undefined gives NaN: no declared length. With an encoding, the declared length is only a lower bound of the body.
    const declared = Number(headers["content-length"]);
    const known = Number.isFinite(declared);
    const encoding = headers["content-encoding"]?.trim().toLowerCase();
    const encoded = Boolean(encoding) && encoding !== "identity";
    const maxDeclared = encoded ? limits.bodyMaxBytes / ENCODED_EXPANSION : limits.bodyMaxBytes;
    if (known && (declared > maxDeclared || bytesRead + declared > limits.bodyTotalBytes)) {
      skippedBodies += 1;
      return;
    }
    const reservation = known && !encoded ? declared : limits.bodyMaxBytes;
    const job = new Promise<void>((resolve) => {
      queue.push({
        reserve: reservation,
        drop: resolve,
        start: () => {
          // Started alone because it did not fit: what is left of the total still has to hold a declared length.
          const left = limits.bodyTotalBytes - bytesRead;
          if (left <= 0 || (known && declared > left)) {
            skippedBodies += 1;
            return resolve();
          }
          const reserve = Math.min(reservation, left);
          reading += 1;
          reserved += reserve;
          const pending = response.body();
          let givenUp = false;
          // Settles once Playwright is done with the body, even for a read that was given up (see above).
          const landed = pending.then(
            (body) => {
              if (givenUp) bytesRead += body.length;
            },
            () => {},
          );
          const done = readBody(pending, () => (givenUp = true))
            .then((body) => body && read(body))
            .catch(() => {});
          // The job ends when the read does, so settle never waits for a given-up read; its slot is freed once both end.
          void done.finally(resolve);
          void Promise.all([done, landed]).finally(() => {
            reading -= 1;
            reserved -= reserve;
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
   * body (it counts encoded bytes), so the caps are checked again on the real size, once the body is in memory.
   */
  const readBody = async (pending: Promise<Buffer>, onGiveUp: () => void): Promise<Buffer | undefined> => {
    let body: Buffer;
    try {
      body = await timeoutAfter(pending, readMs);
    } catch (error) {
      if (error instanceof BodyTimeout) {
        bodyTimeouts += 1;
        onGiveUp();
      }
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
    if (body.length > FONT_PARSE_MAX_BYTES || parsedFonts >= FONT_PARSE_MAX_FILES || fontParseMs >= FONT_PARSE_BUDGET_MS) return;
    parsedFonts += 1;
    const started = performance.now();
    try {
      record.meta = parseFont(body);
    } catch {
      record.meta = null;
    } finally {
      fontParseMs += performance.now() - started;
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
