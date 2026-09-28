import * as z from "zod";
import { Asset, Diagnostics, FontFamily, Palette, ScanStats } from "@/lib/contract";
import { limits } from "@/server/config/limits";
import { safeFetch } from "@/server/net/safe-fetch";
import type { SafeFetch } from "@/server/scan/types";
import { assertDeclaredType, assertSupportedBytes, declaredType } from "./bytes";
import { scanIdFor } from "./source-local";
import type { ScanSource, ScanSourceOptions } from "./types";

/**
 * The remote scan source (spec 2, 8): the scan runs on the hosted app and this process only reads the answer. One POST
 * to `/api/v1/scan` with `view: "full"`, and asset bytes fetched from the CDN directly, through the hosted asset proxy
 * when that cannot work.
 *
 * Bytes of a URL the hosted scan reported go through `safeFetch` like every other URL that came from a scraped page
 * (spec 10): the CLI runs on a developer machine, and a page can name `127.0.0.1`. The two calls to the hosted app
 * itself are plain fetches: that origin is the user's own configuration, not scraped, and `safeFetch` refuses the
 * private addresses a self-hosted app may legitimately live on.
 */

export type RemoteErrorCode =
  /** No token, or the hosted app refused the one it was given. */
  | "unauthorized"
  /** The WAF rate limit or the scan budget. */
  | "rate-limited"
  /** The hosted app failed. */
  | "server"
  /** The hosted app refused the request itself (an invalid URL, a blocked address). */
  | "request"
  /** The answer was not a scan. */
  | "response";

export class RemoteScanError extends Error {
  constructor(
    readonly code: RemoteErrorCode,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "RemoteScanError";
  }
}

/** The scan itself, nested under `scan` in the answer: the `AgentScan` shape minus `scanId` and `source`. */
const RemoteScanBody = z.object({
  scannedAt: z.string().optional(),
  page: z.object({
    url: z.string(),
    finalUrl: z.string(),
    host: z.string(),
    title: z.string(),
    siteName: z.string().optional(),
  }),
  assets: z.array(Asset),
  fonts: z.array(FontFamily),
  palette: Palette.nullable().optional(),
  stats: ScanStats,
  warnings: z.array(z.string()).optional(),
  diagnostics: Diagnostics.optional(),
});

/**
 * The whole document `POST /api/v1/scan` answers `view: "full"` with: `{ view, scanId, summary, scan }`, the scan fields
 * nested under `scan` (`src/app/api/v1/scan/route.ts`). The envelope is parsed rather than the scan alone, so the two
 * sides stay one shape; `tests/integration/agent/remote-source.test.ts` points this source at the real route.
 */
const RemoteAnswer = z.object({
  scanId: z.string().optional(),
  scan: RemoteScanBody,
});

/**
 * A scan id becomes a cache file name (`cache.ts`), so an id the hosted app made up is only taken when it reads as one.
 * Anything else gets a local id, which costs nothing: the id only has to name this scan on this machine.
 */
const SCAN_ID = /^[A-Za-z0-9._-]{1,120}$/;

/** Margin over the hosted scan deadline, so the request fails on the app's own error rather than on this timeout. */
const RESPONSE_MARGIN_MS = 30_000;

export interface RemoteScanSourceDeps {
  /** Fetches the asset URLs the hosted scan reported. Overridden by the tests. */
  fetch?: SafeFetch;
}

const codeFor = (status: number): RemoteErrorCode => {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 429) return "rate-limited";
  if (status >= 500) return "server";
  return "request";
};

/** The hosted app's own error line, when the body carries one, so the CLI can print what the app said. */
function apiMessage(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    const error = (parsed as { error?: { code?: unknown; message?: unknown } }).error;
    if (typeof error?.code !== "string") return null;
    return typeof error.message === "string" ? `${error.code}: ${error.message}` : error.code;
  } catch {
    return null;
  }
}

/** Both signals as one, so a caller's abort and the deadline both stop the request. */
const withTimeout = (timeoutMs: number, signal?: AbortSignal): AbortSignal =>
  signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);

export function createRemoteScanSource(options: ScanSourceOptions = {}, deps: RemoteScanSourceDeps = {}): ScanSource {
  const remote = (options.remote ?? process.env.ASSETS_SCRAPER_REMOTE ?? "").trim().replace(/\/+$/, "");
  const token = (options.token ?? process.env.ASSETS_SCRAPER_TOKEN ?? "").trim();
  if (remote === "") throw new RemoteScanError("request", 0, "a remote scan needs the hosted app URL: set ASSETS_SCRAPER_REMOTE");
  if (token === "") {
    throw new RemoteScanError("unauthorized", 0, `a remote scan of ${remote} needs an agent token: set ASSETS_SCRAPER_TOKEN or pass --token`);
  }
  const fetchBytesDirect = deps.fetch ?? safeFetch;
  const authorization = `Bearer ${token}`;

  /** Reads the hosted app, which is the user's own configured origin, so this is a plain fetch. */
  const fromHost = async (path: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<Response> => {
    try {
      return await fetch(`${remote}${path}`, { ...init, headers: { ...init.headers, authorization }, signal: withTimeout(timeoutMs, signal) });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new RemoteScanError("server", 0, `could not reach ${remote}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return {
    kind: "remote",

    async scan(url, scanOptions) {
      scanOptions?.onStep?.("queue");
      const response = await fromHost(
        "/api/v1/scan",
        { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ url, view: "full" }) },
        limits.scanDeadlineMs + RESPONSE_MARGIN_MS,
        scanOptions?.signal,
      );
      const body = await response.text();
      if (!response.ok) {
        throw new RemoteScanError(codeFor(response.status), response.status, apiMessage(body) ?? `${remote} answered HTTP ${response.status}`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new RemoteScanError("response", response.status, `${remote} answered with something that is not JSON`);
      }
      const answer = RemoteAnswer.safeParse(parsed);
      if (!answer.success) {
        const issue = answer.error.issues[0];
        const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
        throw new RemoteScanError("response", response.status, `${remote} answered with something that is not a scan: ${where}${issue?.message ?? "unknown field"}`);
      }
      const { page, assets, fonts, stats } = answer.data.scan;
      return {
        scanId: answer.data.scanId && SCAN_ID.test(answer.data.scanId) ? answer.data.scanId : scanIdFor(page.host),
        scannedAt: answer.data.scan.scannedAt ?? new Date().toISOString(),
        source: "remote",
        page,
        assets,
        fonts,
        palette: answer.data.scan.palette ?? null,
        stats,
        warnings: answer.data.scan.warnings ?? [],
        ...(answer.data.scan.diagnostics === undefined ? {} : { diagnostics: answer.data.scan.diagnostics }),
      };
    },

    async fetchBytes(target, fetchOptions) {
      const inline = "inline" in target ? target.inline : undefined;
      if (inline) return Buffer.from(inline.base64, "base64");

      // An `http:` URL has no direct path worth trying: the hosted proxy is how the app itself reads those.
      if (target.url.startsWith("https:")) {
        try {
          const direct = await fetchBytesDirect(target.url, {
            maxBytes: limits.proxyMaxBytes,
            timeoutMs: limits.proxyTimeoutMs,
            maxRedirects: limits.proxyMaxRedirects,
            ...(fetchOptions?.signal ? { signal: fetchOptions.signal } : {}),
          });
          if (direct.status < 400) {
            // Same allowlist as the local source and the browser proxy (`bytes.ts`). A refusal here falls through to the
            // hosted proxy, which applies it again on its own answer, rather than ending the download.
            try {
              assertDeclaredType(declaredType(direct.headers.get("content-type")), target.url);
            } catch (declaredFailure) {
              await direct.cancel();
              throw declaredFailure;
            }
            const bytes = await direct.buffer();
            assertSupportedBytes(bytes, target.format, target.url);
            return bytes;
          }
          await direct.cancel();
        } catch (error) {
          if (fetchOptions?.signal?.aborted) throw error;
        }
      }

      // The proxy is a path on the hosted app (`/api/asset?...`), which is what makes it safe to read with a plain
      // fetch. Anything else is not a path this source knows how to call.
      if (!target.proxy.startsWith("/")) throw new Error(`no URL the hosted app can proxy for ${target.url || "this file"}`);
      const response = await fromHost(target.proxy, { method: "GET" }, limits.proxyTimeoutMs, fetchOptions?.signal);
      if (!response.ok) throw new Error(`HTTP ${response.status} from the hosted proxy for ${target.url || target.proxy}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > limits.proxyMaxBytes) throw new Error(`the hosted proxy answered with more than ${limits.proxyMaxBytes} bytes`);
      assertSupportedBytes(bytes, target.format, target.url || target.proxy);
      return bytes;
    },
  };
}
