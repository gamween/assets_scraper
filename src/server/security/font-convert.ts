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

export type Woff2Conversion =
  | { ok: true; bytes: Buffer; contentType: "font/ttf" | "font/otf" }
  | { ok: false; reason: "license" | "not-convertible" };

/**
 * A whole WOFF2 file to the sfnt it wraps, when its licence allows conversion: `font/ttf` for TrueType outlines,
 * `font/otf` for CFF outlines (`OTTO`), which cannot become TrueType without re-drawing the glyphs.
 */
export async function convertWoff2(source: Buffer, signal: AbortSignal): Promise<Woff2Conversion> {
  let meta: FontBinaryMeta | null = null;
  try {
    meta = parseFontBinary(source);
  } catch {}
  if (!(await isConvertibleFont(meta, { fetch: safeFetch, signal }))) return { ok: false, reason: "license" };
  let output: Buffer;
  try {
    const { decompress } = await import("wawoff2");
    output = Buffer.from(await decompress(source));
  } catch {
    return { ok: false, reason: "not-convertible" };
  }
  const contentType = sniffContentType(output);
  if (contentType !== "font/ttf" && contentType !== "font/otf") return { ok: false, reason: "not-convertible" };
  return { ok: true, bytes: output, contentType };
}
