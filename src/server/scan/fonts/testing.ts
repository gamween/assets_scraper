// Test helpers for the fonts module, shared by its unit tests and tests/integration/fonts. Not used at runtime.
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

/** The fastest of `runs` runs of `task`, in milliseconds, so a GC pause or a JIT tier change in one run does not count. */
export async function fastestMs(task: () => unknown, runs = 3): Promise<number> {
  let fastest = Infinity;
  for (let run = 0; run < runs; run += 1) {
    const started = performance.now();
    await task();
    fastest = Math.min(fastest, performance.now() - started);
  }
  return fastest;
}

/**
 * How many times slower `task` gets when its input grows from `size` to 4 times `size`: about 4 for linear work and
 * 16 for quadratic work, whatever the speed of the machine. Warms up first and keeps the fastest of 3 runs per size.
 * Pick a `size` where one run takes a few milliseconds at least.
 */
export async function growthFactor(task: (size: number) => unknown, size: number): Promise<number> {
  await task(size);
  const small = await fastestMs(() => task(size));
  const large = await fastestMs(() => task(size * 4));
  return large / Math.max(small, 1);
}
