// Test helpers for the fonts module, shared by its unit tests and tests/integration/fonts, and the growth measures of
// every performance test of the scan engine (`opGrowth`). Not used at runtime.
import { it } from "vitest";
import type { SafeFetch, SafeFetchOptions, SafeResponse } from "../types";

export function fakeResponse(url: string, status: number, body = ""): SafeResponse {
  return {
    url,
    status,
    headers: new Headers({ "content-type": "text/css" }),
    redirected: false,
    stream: () => new Response(body).body!,
    buffer: async () => Buffer.from(body),
    text: async () => body,
    json: async () => JSON.parse(body),
    cancel: async () => {},
  };
}

export interface FakeGoogleFetch extends SafeFetch {
  calls: { url: string; options?: SafeFetchOptions }[];
}

/** A `SafeFetch` for the Google Fonts CSS API that answers 200 for `families` and 400 for any other family. */
export function fakeGoogleFetch(families: string[]): FakeGoogleFetch {
  const calls: FakeGoogleFetch["calls"] = [];
  const fetch = async (url: string, options?: SafeFetchOptions) => {
    calls.push({ url, options });
    const family = new URL(url).searchParams.get("family");
    return fakeResponse(url, family && families.includes(family) ? 200 : 400);
  };
  return Object.assign(fetch, { calls });
}

/** Deterministic pseudo-random numbers in [0, 1) (mulberry32). */
export function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Whether this run is `pnpm bench`, the one run that measures wall time. */
export const BENCH = process.env.FONTS_BENCH === "1";

/**
 * A test that measures wall time, run by `pnpm bench` and skipped by the gating suite. CI runs the benchmarks in a job
 * that reports and does not block (`.github/workflows/ci.yml`), so a regression only wall time can read is still seen.
 */
export const benchmark = it.runIf(BENCH);

/**
 * `fastestMs` and `growthFactor` refuse to run outside `pnpm bench`: a ratio of two timings flakes on a loaded runner,
 * so the gating suite counts operations instead (`opGrowth`), and a wall-clock check written into it fails at once, on
 * every machine, rather than now and then in CI.
 */
function benchOnly(helper: string): void {
  if (!BENCH) throw new Error(`${helper} measures wall time, which only \`pnpm bench\` does: gate on opGrowth, or measure it in a benchmark`);
}

/** The fastest of `runs` runs of `task`, in milliseconds, so a GC pause or a JIT tier change in one run does not count. */
export async function fastestMs(task: () => unknown, runs = 3): Promise<number> {
  benchOnly("fastestMs");
  let fastest = Infinity;
  for (let run = 0; run < runs; run += 1) {
    const started = performance.now();
    await task();
    fastest = Math.min(fastest, performance.now() - started);
  }
  return fastest;
}

/** How many times `growthFactor` and `opGrowth` grow the input. */
export const GROWTH = 8;

/**
 * The bound tests set on `growthFactor`: linear work gives about 8, quadratic work about 64, so a GC pause or a busy
 * machine can push a linear run well past 8 without reaching it, and a quadratic regression stays far above it.
 */
export const LINEAR_GROWTH_BOUND = 20;

/** The shortest round `msPerRun` times: shorter runs repeat, so that timer resolution does not decide the result. */
const MIN_ROUND_MS = 20;

/** Milliseconds per run of `task`: the fastest of 3 rounds, each running it again until it took `MIN_ROUND_MS`. */
async function msPerRun(task: () => unknown): Promise<number> {
  let fastest = Infinity;
  for (let round = 0; round < 3; round += 1) {
    const started = performance.now();
    let runs = 0;
    let elapsed = 0;
    while (elapsed < MIN_ROUND_MS) {
      await task();
      runs += 1;
      elapsed = performance.now() - started;
    }
    fastest = Math.min(fastest, elapsed / runs);
  }
  return fastest;
}

/**
 * How many times slower `task` gets when its input grows from `size` to `GROWTH` times `size`: about 8 for linear work
 * and 64 for quadratic work, whatever the speed of the machine. Warms up first, and repeats runs shorter than
 * `MIN_ROUND_MS`, so a fast task is measured as precisely as a slow one. Pick a `size` where the work under test costs
 * more than the setup of the task, and where `GROWTH` times `size` stays under the caps of the code under test.
 */
export async function growthFactor(task: (size: number) => unknown, size: number): Promise<number> {
  benchOnly("growthFactor");
  await task(size);
  const small = await msPerRun(() => task(size));
  const large = await msPerRun(() => task(size * GROWTH));
  return large / small;
}

/** A counter a test raises from its module mocks, one per call to the code it wants to measure. */
export interface OpCounter {
  count: number;
}

/**
 * The bound tests set on `opGrowth`: linear work gives at most `GROWTH`, quadratic work `GROWTH` squared. The margin
 * is only there for the fixed work a run does whatever its size, which makes the small run relatively more expensive
 * and the ratio smaller, never larger.
 */
export const LINEAR_OP_GROWTH_BOUND = 12;

/**
 * How many times more work `task` does when its input grows from `size` to `GROWTH` times `size`, counted in calls
 * rather than in milliseconds: about `GROWTH` for linear work and `GROWTH` squared for quadratic work, on every
 * machine and on every run.
 *
 * `growthFactor` measures the same thing in wall time, which compares two runs on the same machine at the same moment
 * and still flakes when one of them meets a GC pause or a loaded CI runner. A count is the same number every time, so
 * a suite can gate on it.
 */
export async function opGrowth(task: (size: number) => unknown, size: number, ops: OpCounter): Promise<{ small: number; large: number; factor: number }> {
  ops.count = 0;
  await task(size);
  const small = ops.count;
  ops.count = 0;
  await task(size * GROWTH);
  const large = ops.count;
  return { small, large, factor: small === 0 ? Infinity : large / small };
}
