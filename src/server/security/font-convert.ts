import { safeFetch } from "@/server/net/safe-fetch";
import { isConvertibleFont, parseFontBinary } from "@/server/scan/fonts/index";
import type { FontBinaryMeta } from "@/server/scan/types";
import { sniffContentType } from "./sniff";

/**
 * `fmt=ttf` buffers the source and decompresses it on the main thread into a WebAssembly heap that never shrinks, so
 * sources are capped well below the proxy cap (web fonts are rarely over a few MB) and at most `CONVERSION_SLOTS`
 * conversions, download included, run at once per instance.
 */
export const WOFF2_MAX_SOURCE_BYTES = 10 * 1024 * 1024;
/**
 * The most woff2 returns for any input (its `kDefaultMaxSize`). The size a WOFF2 header declares is no bound: woff2
 * ignores a smaller one and pads the output up to a larger one, so a tiny file can come back as this many bytes.
 */
export const WOFF2_MAX_OUTPUT_BYTES = 30 * 1024 * 1024;
const CONVERSION_SLOTS = 2;

/** Takes a slot, waiting in order for a free one. Resolves with its idempotent release, or null when `signal` aborts first. */
export type TakeSlot = (signal: AbortSignal) => Promise<(() => void) | null>;

/** A counting semaphore of `size` slots, granted first come, first served. */
export function createSlots(size: number): TakeSlot {
  let taken = 0;
  const queue: (() => void)[] = [];
  return (signal) => {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const next = queue.shift();
      if (next) next();
      else taken -= 1;
    };
    return new Promise((resolve) => {
      if (taken < size) {
        taken += 1;
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
        const index = queue.indexOf(grant);
        if (index !== -1) queue.splice(index, 1);
        resolve(null);
      };
      queue.push(grant);
      signal.addEventListener("abort", giveUp, { once: true });
    });
  };
}

/** The conversion slots of this instance. */
export const takeConversionSlot = createSlots(CONVERSION_SLOTS);

/** The last decompression queued; see `decompressWoff2`. */
let decompressing: Promise<unknown> = Promise.resolve();

/**
 * The sfnt bytes of a WOFF2 file, or null when woff2 refuses them. wawoff2 answers with a view of its WebAssembly heap,
 * which the next decompression overwrites (or detaches when the heap grows), and hands it over through an `await`, so two
 * conversions that reach it in the same turn corrupt each other before either copies. Decompressions therefore run one
 * at a time, each copied out before the next starts; they block the main thread anyway, so this costs no throughput.
 */
function decompressWoff2(source: Uint8Array): Promise<Buffer | null> {
  const run = decompressing.then(async () => {
    const { decompress } = await import("wawoff2");
    return Buffer.from(await decompress(source));
  }).catch(() => null);
  decompressing = run;
  return run;
}

export type Woff2Conversion =
  | { ok: true; bytes: Buffer; contentType: "font/ttf" | "font/otf" }
  | { ok: false; reason: "license" | "not-convertible" };

/**
 * A whole WOFF2 file to the sfnt it wraps, when its licence allows conversion: `font/ttf` for TrueType outlines,
 * `font/otf` for CFF outlines (`OTTO`), which cannot become TrueType without re-drawing the glyphs. woff2 runs first: it
 * validates the table directory and refuses implausible sizes in native code, so the licence is then read from a plain
 * sfnt, fontkit never decodes an untrusted brotli stream in JavaScript (sized from table lengths the file declares), and
 * bytes woff2 refuses never cost a Google Fonts check. The licence check gets `signal` and is abandoned as soon as it
 * aborts, even when it ignores the signal or answers the abort with a refusal: the call then rejects with `signal.reason`.
 */
export async function convertWoff2(source: Buffer, signal: AbortSignal): Promise<Woff2Conversion> {
  signal.throwIfAborted();
  const output = await decompressWoff2(source);
  const contentType = output && sniffContentType(output);
  if (!output || (contentType !== "font/ttf" && contentType !== "font/otf")) return { ok: false, reason: "not-convertible" };
  let meta: FontBinaryMeta | null = null;
  try {
    meta = parseFontBinary(output);
  } catch {}
  const convertible = await untilAborted(isConvertibleFont(meta, { fetch: safeFetch, signal }), signal);
  signal.throwIfAborted();
  return convertible ? { ok: true, bytes: output, contentType } : { ok: false, reason: "license" };
}

/** `promise`, or a rejection with `signal.reason` as soon as `signal` aborts, whichever comes first. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
