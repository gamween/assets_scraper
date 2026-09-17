import net from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import { limits } from "@/server/config/limits";
import type { SafeFetch, SafeFetchOptions, SafeResponse } from "@/server/scan/types";
import { isOwnHost, isTestAllowed, pinnedLookup, privateHostReason, resolvePublicAddresses, SsrfError } from "./ip";

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
 * DNS for every hostname undici connects to goes through `resolvePublicAddresses`, and the socket connects only to the
 * addresses it returned (the next one when a connection fails), so a second resolution can never swap in a private
 * address. Node skips `lookup` for IP literals, which `checkTarget` checks before each request. The lookup gets no
 * port, so it takes one: port 0 never matches the test allowlist, and allowlisted test origins get an agent per port.
 */
function checkedLookup(port: number): net.LookupFunction {
  return (hostname, options, callback) => {
    resolvePublicAddresses(hostname, port).then(
      (addresses) => pinnedLookup(addresses)(hostname, options, callback),
      (error: NodeJS.ErrnoException) => callback(error, ""),
    );
  };
}

const checkedAgent = (port: number) =>
  new Agent({ connect: { lookup: checkedLookup(port), autoSelectFamily: true, timeout: CONNECT_TIMEOUT_MS } });

const publicAgent = checkedAgent(0);
const testAgents = new Map<number, Agent>();

/**
 * URL policy for one hop: scheme, own host, IP literal, port. Returns the agent to connect with; DNS names are checked
 * at connect time by its lookup.
 */
function checkTarget(url: URL): Agent {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new SafeFetchError("invalid-url", `Unsupported scheme: ${url.protocol}`);
  const hostname = url.hostname.replace(/^\[(.*)\]$/, "$1");
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (isOwnHost(hostname)) throw new SafeFetchError("own-host", `Own host: ${hostname}`);
  if (isTestAllowed(hostname, port)) {
    let agent = testAgents.get(port);
    if (!agent) testAgents.set(port, (agent = checkedAgent(port)));
    return agent;
  }
  if (privateHostReason(hostname)) throw new SafeFetchError("blocked-address", `Blocked address: ${hostname}`);
  if (port !== 80 && port !== 443) throw new SafeFetchError("unsupported-port", `Unsupported port: ${port}`);
  return publicAgent;
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
  /** Reader of the undici body once `stream()` took it, so `cancel()` can still release the connection. */
  let bodyReader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  const stream = (): ReadableStream<Uint8Array> => {
    if (used) throw new TypeError("Body already used");
    used = true;
    if (!body) return new ReadableStream<Uint8Array>({ start: (controller) => controller.close() });
    const reader = body.getReader();
    bodyReader = reader;
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
    /** Releases the connection, also after `stream()`: a stream taken from it then ends early. */
    cancel: async () => {
      if (bodyReader) {
        await bodyReader.cancel().catch(() => {});
        return;
      }
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
    const dispatcher = checkTarget(url);
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
