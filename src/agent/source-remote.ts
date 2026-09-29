import * as z from "zod";
import { Asset, Diagnostics, FontFamily, Palette, ScanStats } from "@/lib/contract";
import { limits } from "@/server/config/limits";
import { safeFetch } from "@/server/net/safe-fetch";
import type { SafeFetch } from "@/server/scan/types";
import { assertDeclaredType, assertSupportedBytes, declaredType, inlineFileBytes } from "./bytes";
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
 * private addresses a self-hosted app may legitimately live on. They carry the agent token, so that origin has to be
 * https (plain http only on this machine), and a redirect is reported rather than followed: fetch drops the token on a
 * cross-origin hop, which made a moved deployment read as a refused token.
 */

export type RemoteErrorCode =
  /** No token, or the hosted app refused the one it was given. */
  | "unauthorized"
  /** The WAF rate limit or the scan budget. */
  | "rate-limited"
  /** The hosted app's firewall stopped the client (a challenge page, which a program cannot pass). */
  | "challenged"
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

/** Margin over the hosted scan deadline, so the request fails on the app's own error rather than on this timeout. */
const RESPONSE_MARGIN_MS = 30_000;

export interface RemoteScanSourceDeps {
  /** Fetches the asset URLs the hosted scan reported. Overridden by the tests. */
  fetch?: SafeFetch;
}

/**
 * The hosted app a remote scan runs against, with no trailing slash, or undefined for a local scan: `remote`, then
 * `ASSETS_SCRAPER_REMOTE`. The one reading of that setting, for the source and for the cache lookup (`source.ts`).
 */
export function remoteBaseUrl(options: ScanSourceOptions = {}): string | undefined {
  const remote = (options.remote ?? process.env.ASSETS_SCRAPER_REMOTE ?? "").trim();
  return remote === "" ? undefined : remote.replace(/\/+$/, "");
}

/** Hosts a remote may be reached on over plain http: this machine, where a self-hosted app runs in development. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Refuses a hosted app the token would reach in clear text. `http://assets-scraper.vercel.app`, one letter short, sent
 * `Authorization: Bearer` across whatever network the user was on before Vercel's redirect to https, and the call then
 * failed with a 401 that said nothing about why.
 */
function assertSecureRemote(remote: string): void {
  let url: URL;
  try {
    url = new URL(remote);
  } catch {
    throw new RemoteScanError("request", 0, `${remote} is not a URL: set ASSETS_SCRAPER_REMOTE to the hosted app, like https://assets-scraper.vercel.app`);
  }
  if (url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))) return;
  throw new RemoteScanError("request", 0, `refusing to send the agent token to ${remote}: the hosted app has to be an https URL (http only for localhost)`);
}

/**
 * Vercel's firewall answers a client it challenges with 403 and an HTML page (`x-vercel-mitigated: challenge`), on every
 * path of the deployment, and nothing but a browser can pass it. The app itself only ever answers JSON, so a 403 that is
 * not JSON is that page too. It used to read as "answered HTTP 403", which sent the user after a token that was fine.
 */
function firewallVerdict(response: Response, body: string): string | null {
  const mitigated = response.headers.get("x-vercel-mitigated");
  if (mitigated !== null) return mitigated || "challenge";
  return response.status === 403 && apiMessage(body) === null ? "challenge" : null;
}

const firewallError = (remote: string, status: number, verdict: string): RemoteScanError =>
  new RemoteScanError(
    "challenged",
    status,
    `the firewall of ${remote} stopped this client (HTTP ${status}, ${verdict}), which only a browser can get past. The token is not the problem: ` +
      "wait a few minutes before the next call, or scan locally by leaving ASSETS_SCRAPER_REMOTE unset",
  );

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
  const remote = remoteBaseUrl(options);
  const token = (options.token ?? process.env.ASSETS_SCRAPER_TOKEN ?? "").trim();
  if (remote === undefined) throw new RemoteScanError("request", 0, "a remote scan needs the hosted app URL: set ASSETS_SCRAPER_REMOTE");
  assertSecureRemote(remote);
  if (token === "") {
    throw new RemoteScanError("unauthorized", 0, `a remote scan of ${remote} needs an agent token: set ASSETS_SCRAPER_TOKEN or pass --token`);
  }
  // A deployment behind ACCESS_CODE asks every scan for it, a token holder's included (spec section 8: a token skips
  // BotID and nothing else), so the code travels next to the token whenever the user configured one.
  const accessCode = (options.accessCode ?? process.env.ASSETS_SCRAPER_ACCESS_CODE ?? "").trim();
  const credentials: Record<string, string> = { authorization: `Bearer ${token}`, ...(accessCode === "" ? {} : { "x-access-code": accessCode }) };
  const fetchBytesDirect = deps.fetch ?? safeFetch;

  /**
   * Reads the hosted app, which is the user's own configured origin, so this is a plain fetch. A redirect is an answer
   * of its own rather than a hop to follow: the token must never be the thing a moved deployment quietly loses.
   */
  const fromHost = async (path: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<Response> => {
    let response: Response;
    try {
      response = await fetch(`${remote}${path}`, { ...init, headers: { ...init.headers, ...credentials }, redirect: "manual", signal: withTimeout(timeoutMs, signal) });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new RemoteScanError("server", 0, `could not reach ${remote}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      const location = response.headers.get("location") ?? "somewhere else";
      throw new RemoteScanError("request", response.status, `${remote} redirects to ${location}: set ASSETS_SCRAPER_REMOTE to the address the hosted app answers on`);
    }
    return response;
  };

  return {
    kind: "remote",
    // Which hosted app this is, so the scan cache can tell two of them apart (`cache.ts`).
    remote,

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
        const verdict = firewallVerdict(response, body);
        if (verdict !== null) throw firewallError(remote, response.status, verdict);
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
        // Always minted here. The id names a cache file on this machine (`cache.ts`), and one the hosted app chose could
        // be `..`, which the cache refuses, or the id of a local scan already on disk, which the save would replace.
        scanId: scanIdFor(page.host),
        scannedAt: answer.data.scan.scannedAt ?? new Date().toISOString(),
        source: "remote",
        remote,
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
      const inline = inlineFileBytes(target);
      if (inline) return inline;

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
      if (!response.ok) {
        const body = await response.text();
        const verdict = firewallVerdict(response, body);
        if (verdict !== null) throw firewallError(remote, response.status, verdict);
        const said = apiMessage(body);
        throw new Error(`HTTP ${response.status} from the hosted proxy for ${target.url || target.proxy}${said === null ? "" : `: ${said}`}`);
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > limits.proxyMaxBytes) throw new Error(`the hosted proxy answered with more than ${limits.proxyMaxBytes} bytes`);
      assertSupportedBytes(bytes, target.format, target.url || target.proxy);
      return bytes;
    },
  };
}
