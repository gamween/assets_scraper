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
  toneFromBytes?: (buffer: Buffer, contentType: string) => Promise<Tone>;
  parseFontBinary?: (buffer: Buffer) => FontBinaryMeta | null;
}

const FONT_TYPE = /font|woff|opentype|truetype|sfnt/i;
const FONT_EXTENSION = /\.(woff2?|ttf|otf|eot)(?:[?#]|$)/i;
const SVG = (url: string, contentType: string) => /image\/svg/i.test(contentType) || /\.svgz?(?:[?#]|$)/i.test(url);

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
 * Network capture (spec 7.4), attached before navigation. Images, fonts and stylesheets are recorded once per URL;
 * 3xx responses are skipped. Bodies are read with caps (size, time, concurrency, total bytes), then hashed, measured,
 * toned or parsed and dropped. Only SVG text, CSS text and `blob:` bytes are kept.
 */
export function startCapture(page: Page, options: CaptureOptions): CaptureHandle {
  const tone = options.toneFromBytes ?? toneFromBytes;
  const parseFont = options.parseFontBinary ?? parseFontBinary;
  const readMs = options.bodyReadMs ?? limits.bodyReadMs;

  const images = new Map<string, CapturedImage>();
  const fonts = new Map<string, CapturedFont>();
  const sheets = new Map<string, CapturedSheet>();
  const jobs = new Set<Promise<void>>();
  const queue: (() => void)[] = [];
  let reading = 0;
  let bytesRead = 0;
  let blobBytes = 0;
  let toned = 0;
  let toneMs = 0;
  let bodyTimeouts = 0;
  let skippedBodies = 0;
  let stopped = false;

  const isStopped = () => stopped || options.signal.aborted;

  /** Runs `read` when a body slot is free. Reads still queued when capture stops never start. */
  const schedule = (read: () => Promise<void>) => {
    const job = new Promise<void>((resolve) => {
      queue.push(() => {
        if (isStopped()) return resolve();
        reading += 1;
        read()
          .catch(() => {})
          .finally(() => {
            reading -= 1;
            resolve();
            next();
          });
      });
    });
    jobs.add(job);
    void job.finally(() => jobs.delete(job));
    next();
  };
  const next = () => {
    while (reading < limits.bodyConcurrency && queue.length) queue.shift()?.();
    if (isStopped()) while (queue.length) queue.shift()?.();
  };

  /** The body within every cap, or undefined (counted as a timeout or a skip). */
  const readBody = async (response: Response, read: () => Promise<Buffer>): Promise<Buffer | undefined> => {
    const declared = Number(response.headers()["content-length"]);
    if ((Number.isFinite(declared) && declared > limits.bodyMaxBytes) || bytesRead + (declared || 0) > limits.bodyTotalBytes) {
      skippedBodies += 1;
      return undefined;
    }
    let body: Buffer;
    try {
      body = await timeoutAfter(read(), readMs);
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

  const toneOf = async (body: Buffer, contentType: string): Promise<Tone> => {
    if (toned >= limits.toneMaxRasters || body.length > limits.toneMaxBytes || toneMs >= limits.toneBudgetMs) return "unknown";
    toned += 1;
    const started = performance.now();
    try {
      return await tone(body, contentType);
    } catch {
      return "unknown";
    } finally {
      toneMs += performance.now() - started;
    }
  };

  const captureImage = async (record: CapturedImage, response: Response) => {
    const body = await readBody(response, () => response.body());
    if (!body) return;
    record.bytes = body.length;
    record.sha1 = createHash("sha1").update(body).digest("hex");
    const svg = SVG(record.url, record.contentType);
    if (!svg) {
      try {
        const { width, height } = await sharp(body).metadata();
        if (width && height) Object.assign(record, { width, height });
      } catch {
        // Not a format sharp reads (ico, broken bytes): no dimensions.
      }
    }
    record.tone = await toneOf(body, record.contentType);
    if (svg && body.length <= limits.svgMaxBytes) record.svgText = body.toString("utf8");
    if (record.url.startsWith("blob:") && body.length <= limits.blobMaxBytes && blobBytes + body.length <= limits.blobTotalBytes) {
      blobBytes += body.length;
      record.blobBase64 = body.toString("base64");
    }
  };

  const captureFont = async (record: CapturedFont, response: Response) => {
    const body = await readBody(response, () => response.body());
    if (!body) return;
    record.bytes = body.length;
    record.sha1 = createHash("sha1").update(body).digest("hex");
    try {
      record.meta = parseFont(body);
    } catch {
      record.meta = null;
    }
  };

  const captureSheet = async (record: CapturedSheet, response: Response) => {
    const body = await readBody(response, () => response.body());
    if (body) record.cssText = body.toString("utf8");
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

    if (resourceType === "font" || FONT_TYPE.test(contentType) || FONT_EXTENSION.test(url)) {
      if (fonts.has(url)) return;
      const record: CapturedFont = { url, status, contentType, meta: null };
      fonts.set(url, record);
      if (readable) schedule(() => captureFont(record, response));
    } else if (resourceType === "image" || /^image\//i.test(contentType)) {
      if (images.has(url)) return;
      const record: CapturedImage = { url, status, contentType, tone: "unknown" };
      if (headers.server) record.server = headers.server;
      images.set(url, record);
      if (readable) schedule(() => captureImage(record, response));
    } else if (resourceType === "stylesheet" || /^text\/css/i.test(contentType)) {
      if (sheets.has(url)) return;
      const record: CapturedSheet = { url, status, cssText: "" };
      sheets.set(url, record);
      if (readable) schedule(() => captureSheet(record, response));
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
