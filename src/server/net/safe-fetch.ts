import net from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import { limits } from "@/server/config/limits";
import type { SafeFetch, SafeFetchOptions, SafeResponse } from "@/server/scan/types";
import { isOwnHost, isPublicIp, isTestAllowed, resolvePublicHost, SsrfError } from "./ip";

export type SafeFetchErrorCode = "invalid-url" | "blocked-address" | "own-host" | "unsupported-port" | "dns" | "connect" | "timeout" | "too-large" | "too-many-redirects" | "aborted";

export class SafeFetchError extends Error {
  constructor(readonly code: SafeFetchErrorCode, message: string) {
    super(message);
    this.name = "SafeFetchError";
  }
}

export const DEFAULT_USER_AGENT = "Mozilla/5.0 (compatible; AssetsScraper/1.0; +https://github.com/gamween/assets_scraper)";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DNS_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "EAI_NONAME", "EAI_NODATA", "EAI_FAIL"]);
const CONNECT_TIMEOUT_MS = 10_000;

/**
 * DNS for every hostname undici connects to goes through `resolvePublicHost`, and the socket connects to the address
 * it returned, so a second resolution can never swap in a private address. Node skips `lookup` for IP literals, which
 * `checkTarget` checks before each request. Port 0 never matches the test allowlist, so this agent always applies the
 * private checks: allowlisted test origins use `testAgent` instead.
 */
const checkedLookup: net.LookupFunction = (hostname, options, callback) => {
  resolvePublicHost(hostname, 0).then(
    (address) => {
      const family = net.isIP(address);
      if (options.all) callback(null, [{ address, family }]);
      else callback(null, address, family);
    },
    (error: NodeJS.ErrnoException) => callback(error, ""),
  );
};

const publicAgent = new Agent({ connect: { lookup: checkedLookup, timeout: CONNECT_TIMEOUT_MS } });
let testAgent: Agent | undefined;

type Target = "public" | "test";

/** URL policy for one hop: scheme, own host, IP literal, port. DNS names are checked at connect time. */
function checkTarget(url: URL): Target {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new SafeFetchError("invalid-url", `Unsupported scheme: ${url.protocol}`);
  const hostname = url.hostname.replace(/^\[(.*)\]$/, "$1");
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (isOwnHost(hostname)) throw new SafeFetchError("own-host", `Own host: ${hostname}`);
  if (isTestAllowed(hostname, port)) return "test";
  const localName = hostname === "localhost" || hostname.endsWith(".localhost");
  if ((net.isIP(hostname) && !isPublicIp(hostname)) || localName) throw new SafeFetchError("blocked-address", `Blocked address: ${hostname}`);
  if (port !== 80 && port !== 443) throw new SafeFetchError("unsupported-port", `Unsupported port: ${port}`);
  return "public";
}

function parseUrl(value: string | URL, base?: URL): URL {
  try {
    const url = new URL(value, base);
    url.username = "";
    url.password = "";
    url.hash = "";
    return url;
  } catch {
    throw new SafeFetchError("invalid-url", "Invalid URL");
  }
}

function mapError(error: unknown, signal: AbortSignal, callerSignal: AbortSignal | undefined): SafeFetchError {
  if (error instanceof SafeFetchError) return error;
  if (callerSignal?.aborted) return new SafeFetchError("aborted", "Request aborted");
  if (signal.aborted) return new SafeFetchError("timeout", "Request timed out");
  for (let current = error, depth = 0; current && depth < 8; current = (current as { cause?: unknown }).cause, depth++) {
    if (current instanceof SsrfError) {
      if (current.reason === "own-host") return new SafeFetchError("own-host", current.message);
      if (current.reason === "dns-failure") return new SafeFetchError("dns", current.message);
      if (current.reason === "invalid-host") return new SafeFetchError("invalid-url", current.message);
      return new SafeFetchError("blocked-address", current.message);
    }
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && DNS_CODES.has(code)) return new SafeFetchError("dns", code);
    if (code === "UND_ERR_CONNECT_TIMEOUT") return new SafeFetchError("timeout", code);
  }
  const message = error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : "Request failed";
  return new SafeFetchError("connect", message);
}

function wrapResponse(
  response: Awaited<ReturnType<typeof undiciFetch>>,
  url: URL,
  redirected: boolean,
  maxBytes: number,
  toSafeError: (error: unknown) => SafeFetchError,
): SafeResponse {
  const headers = new Headers();
  response.headers.forEach((value, key) => headers.append(key, value));
  const body = response.body;
  let used = false;

  const stream = (): ReadableStream<Uint8Array> => {
    if (used) throw new TypeError("Body already used");
    used = true;
    if (!body) return new ReadableStream<Uint8Array>({ start: (controller) => controller.close() });
    const reader = body.getReader();
    let total = 0;
    return new ReadableStream<Uint8Array>(
      {
        start(controller) {
          const declared = Number(headers.get("content-length"));
          if (!headers.has("content-encoding") && Number.isFinite(declared) && declared > maxBytes) {
            reader.cancel().catch(() => {});
            controller.error(new SafeFetchError("too-large", `Declared ${declared} bytes, over ${maxBytes}`));
          }
        },
        async pull(controller) {
          let chunk: ReadableStreamReadResult<Uint8Array>;
          try {
            chunk = (await reader.read()) as ReadableStreamReadResult<Uint8Array>;
          } catch (error) {
            controller.error(toSafeError(error));
            return;
          }
          if (chunk.done) {
            controller.close();
            return;
          }
          total += chunk.value.byteLength;
          if (total > maxBytes) {
            reader.cancel().catch(() => {});
            controller.error(new SafeFetchError("too-large", `Body over ${maxBytes} bytes`));
            return;
          }
          controller.enqueue(chunk.value);
        },
        cancel(reason) {
          return reader.cancel(reason);
        },
      },
      { highWaterMark: 0 },
    );
  };

  const buffer = async (): Promise<Buffer> => {
    const reader = stream().getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks);
      chunks.push(value);
    }
  };

  const text = async () => new TextDecoder().decode(await buffer());

  return {
    url: url.toString(),
    status: response.status,
    headers,
    redirected,
    stream,
    buffer,
    text,
    json: async <T = unknown>() => JSON.parse(await text()) as T,
    cancel: async () => {
      if (used || !body) return;
      used = true;
      await body.cancel().catch(() => {});
    },
  };
}

/**
 * SSRF-safe fetch for every server-side request to a URL that came from a user or a scraped page (spec 11.1).
 * Manual redirects, each hop re-validated; `timeoutMs` covers the whole exchange including the body; `maxBytes` caps
 * the decoded body. Non-2xx statuses resolve normally.
 */
export const safeFetch: SafeFetch = async (input: string, options: SafeFetchOptions = {}) => {
  const {
    method = "GET",
    maxBytes = limits.proxyMaxBytes,
    timeoutMs = limits.proxyTimeoutMs,
    maxRedirects = limits.proxyMaxRedirects,
    signal: callerSignal,
  } = options;
  const signal = callerSignal ? AbortSignal.any([callerSignal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  const toSafeError = (error: unknown) => mapError(error, signal, callerSignal);

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.headers ?? {})) headers[key.toLowerCase()] = value;
  headers["user-agent"] ??= DEFAULT_USER_AGENT;

  let url = parseUrl(input);
  for (let redirects = 0; ; redirects++) {
    if (callerSignal?.aborted) throw new SafeFetchError("aborted", "Request aborted");
    const target = checkTarget(url);
    const dispatcher = target === "test" ? (testAgent ??= new Agent({ connect: { timeout: CONNECT_TIMEOUT_MS } })) : publicAgent;
    let response: Awaited<ReturnType<typeof undiciFetch>>;
    try {
      response = await undiciFetch(url, { method, headers, redirect: "manual", signal, dispatcher });
    } catch (error) {
      throw toSafeError(error);
    }

    const location = response.headers.get("location");
    if (!REDIRECT_STATUSES.has(response.status) || location === null) {
      return wrapResponse(response, url, redirects > 0, maxBytes, toSafeError);
    }
    await response.body?.cancel().catch(() => {});
    if (redirects >= maxRedirects) throw new SafeFetchError("too-many-redirects", `More than ${maxRedirects} redirects`);
    const next = parseUrl(location, url);
    if (next.origin !== url.origin) {
      delete headers.authorization;
      delete headers.cookie;
    }
    url = next;
  }
};
