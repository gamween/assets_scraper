/**
 * The process-wide gate on sharp, and the pixel cap every decode is opened with. It lives on its own because more than
 * one place decodes images: preview tone (`tone.ts`) during a scan, and the perceptual fingerprints of a download
 * (`src/agent/hash.ts`). Both run in the same process as the scan engine, so both belong behind the same gate.
 *
 * sharp runs its work on the libuv thread pool (4 threads by default), which `dns.lookup` in `safeFetch` and the egress
 * proxy share, so unbounded decodes stall name resolution for every concurrent scan. Neither sharp nor a timeout can
 * stop a librsvg render, and a page chooses how slow its SVGs are, so a render keeps its slot until it really ends, even
 * once its budget gave up on it: the other threads stay free.
 */

/** Pixels one decode may produce, against sharp's own 268 MP default: v1 refuses anything larger. */
export const MAX_INPUT_PIXELS = 8192 * 8192;

/** sharp calls in flight at once across the process, capture, post-processing, fingerprints and every scan together. */
const RENDER_CONCURRENCY = 2;

let renders = 0;
let rendersStarted = 0;
const waiting: (() => void)[] = [];

/** sharp calls in flight, and started since the process began. For tests. */
export const renderStats = () => ({ active: renders, started: rendersStarted });

/** Waits for a render slot. Resolves false, without a slot, when `signal` aborts first. */
export function acquireRender(signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  if (renders < RENDER_CONCURRENCY) {
    renders++;
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const onAbort = () => {
      const index = waiting.indexOf(start);
      if (index >= 0) waiting.splice(index, 1);
      resolve(false);
    };
    const start = () => {
      signal?.removeEventListener("abort", onAbort);
      renders++;
      resolve(true);
    };
    waiting.push(start);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Gives the slot back and starts whoever was next in line. */
export function releaseRender(): void {
  renders--;
  waiting.shift()?.();
}

/**
 * Runs `work` in a render slot. `onAbort` is what the caller gets when `signal` aborts before a slot came free, so a
 * scan can answer `unknown` and a download can answer "no fingerprint" from the same gate.
 */
export async function withRenderSlot<T>(work: () => Promise<T>, onAbort: T, signal?: AbortSignal): Promise<T> {
  if (!(await acquireRender(signal))) return onAbort;
  try {
    if (signal?.aborted) return onAbort;
    rendersStarted++;
    return await work();
  } finally {
    releaseRender();
  }
}
