import http from "node:http";
import { NotImplementedError } from "@/server/errors";
import { safeFetch } from "@/server/net/safe-fetch";
import type { SafeFetch, SafeFetchOptions, SafeResponse } from "@/server/scan/types";
import { serveFixture, type FixtureServer } from "../../fixtures/serve";

/**
 * Test helpers for Track C. Tracks A and B (safeFetch, runInPage, capture) are stubs on this branch, so these helpers
 * stand in for them with the same contracts.
 */

/** Serves the fixture site plus extra routes, and allows its host for `safeFetch` in tests (spec 11.1). */
export async function serveAssetsFixture(routes: Record<string, http.RequestListener> = {}): Promise<FixtureServer> {
  const server = await serveFixture(routes);
  const allowed = new Set((process.env.SCAN_TEST_ALLOW_HOSTS ?? "").split(",").filter(Boolean));
  allowed.add(server.host);
  process.env.SCAN_TEST_ALLOW_HOSTS = [...allowed].join(",");
  return server;
}

/** Plain `fetch` with the `SafeFetch` shape, for as long as the real one is a stub. No address checks: tests only. */
const localFetch: SafeFetch = async (url: string, options: SafeFetchOptions = {}): Promise<SafeResponse> => {
  const controller = new AbortController();
  const timer = options.timeoutMs ? setTimeout(() => controller.abort(), options.timeoutMs) : undefined;
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const cleanup = () => {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  };
  let response: Response;
  try {
    response = await fetch(url, { method: options.method ?? "GET", headers: options.headers, signal: controller.signal, redirect: "follow" });
  } catch (error) {
    cleanup();
    throw error;
  }
  const empty = () => new ReadableStream<Uint8Array>({ start: (c) => c.close() });
  return {
    url: response.url,
    status: response.status,
    headers: response.headers,
    redirected: response.redirected,
    stream: () => response.body ?? empty(),
    buffer: async () => Buffer.from(await response.arrayBuffer()).subarray(0, options.maxBytes),
    text: () => response.text(),
    json: <T>() => response.json() as Promise<T>,
    cancel: async () => {
      cleanup();
      await response.body?.cancel().catch(() => {});
    },
  };
};

/** The real `safeFetch` once Track A lands, the local adapter until then. */
export const testFetch: SafeFetch = async (url, options) => {
  try {
    return await safeFetch(url, options);
  } catch (error) {
    if (!(error instanceof NotImplementedError)) throw error;
    return localFetch(url, options);
  }
};
