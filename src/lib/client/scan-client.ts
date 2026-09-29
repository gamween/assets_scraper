// Types only: a value import of the contract would bring zod into the page bundle, for two checks a table does (see
// `ERROR_CODES`), and the development check of the stream loads it on demand (see `eventCheck`).
import type { ApiError, Asset, Diagnostics, ErrorCode, ScanEvent } from "@/lib/contract";
import { decodeNdjson } from "@/lib/ndjson";
import { readString, writeString } from "./storage";

export const ACCESS_CODE_KEY = "assets-scraper:access-code";

export const readAccessCode = () => readString(ACCESS_CODE_KEY);
export const storeAccessCode = (code: string | null) => writeString(ACCESS_CODE_KEY, code);

/**
 * Every contract error code, for the two places the client checks one at runtime: a gate body, and a stream error sent
 * by a deploy newer than this tab. `satisfies` makes the compiler reject a code missing here or one the contract does
 * not have, so the table cannot drift from `ErrorCode`.
 */
const ERROR_CODES = {
  "invalid-url": true,
  "blocked-address": true,
  "unsupported-port": true,
  "own-host": true,
  "rate-limited": true,
  budget: true,
  disabled: true,
  "access-code": true,
  bot: true,
  busy: true,
  dns: true,
  connect: true,
  http: true,
  blocked: true,
  "not-html": true,
  timeout: true,
  internal: true,
} satisfies Record<ErrorCode, true>;

export const isErrorCode = (value: unknown): value is ErrorCode => typeof value === "string" && Object.hasOwn(ERROR_CODES, value);

/**
 * `offline` is the client's own code, never sent by the server: a request that failed in the browser while it had no
 * connection, which is the user's network and not the service.
 */
type ScanErrorCode = ErrorCode | "offline";

/** A failed scan, from the gate (JSON, before streaming) or from the stream (`error` event, always the last line). */
export interface ScanErrorInfo {
  code: ScanErrorCode;
  message: string;
  httpStatus?: number;
  fallback?: Asset[];
  diagnostics?: Diagnostics;
}

export type StreamEvent = Exclude<ScanEvent, { type: "error" }>;

export interface ScanHandlers {
  onEvent(event: StreamEvent): void;
  onError(error: ScanErrorInfo): void;
  /** Called before the single automatic retry after a `busy` error, so the UI can reset its progress. */
  onRetry?(): void;
}

export interface ScanHandle {
  abort(): void;
  /** Settles when the scan finished, failed or was aborted. Never rejects. */
  done: Promise<void>;
}

/** 1 to 3 seconds, so two clients that hit the same busy instance do not retry together. */
const retryDelay = () => 1000 + Math.random() * 2000;

type Attempt = { kind: "finished" } | { kind: "busy"; error: ScanErrorInfo } | { kind: "aborted" };

export function startScan(url: string, handlers: ScanHandlers): ScanHandle {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wakeRetry: (() => void) | undefined;

  const aborted = () => controller.signal.aborted;
  const emit = (event: StreamEvent) => {
    if (!aborted()) handlers.onEvent(event);
  };
  const fail = (error: ScanErrorInfo) => {
    if (!aborted()) handlers.onError(error);
  };

  async function attempt(): Promise<Attempt> {
    const headers = new Headers({ "content-type": "application/json" });
    const code = readAccessCode();
    if (code) headers.set("x-access-code", code);

    let response: Response;
    try {
      response = await fetch("/api/scan", { method: "POST", headers, body: JSON.stringify({ url }), signal: controller.signal });
    } catch (error) {
      if (aborted()) return { kind: "aborted" };
      fail(networkFailure(error, "Network error"));
      return { kind: "finished" };
    }

    if (!response.ok || !response.body) {
      const error = await gateError(response);
      if (aborted()) return { kind: "aborted" };
      if (error.code === "busy") return { kind: "busy", error };
      fail(error);
      return { kind: "finished" };
    }

    // Read through our own reader so abort() can end a pending read even when the body ignores the fetch signal.
    const source = response.body.getReader();
    controller.signal.addEventListener("abort", () => void source.cancel().catch(() => {}), { once: true });
    const stream = new ReadableStream<Uint8Array>({
      async pull(output) {
        try {
          const { value, done } = await source.read();
          if (done) output.close();
          else output.enqueue(value);
        } catch (error) {
          output.error(error);
        }
      },
      cancel: (reason) => source.cancel(reason),
    });

    try {
      const parseEvent = await eventCheck();
      for await (const raw of decodeNdjson(stream)) {
        if (aborted()) return { kind: "aborted" };
        const event = parseEvent(raw);
        if (!event) {
          fail({ code: "internal", message: "The scan returned an unexpected response." });
          return { kind: "finished" };
        }
        if (event.type === "error") {
          const error = errorFromEvent(event);
          if (error.code === "busy") return { kind: "busy", error };
          fail(error);
          return { kind: "finished" };
        }
        emit(event);
        if (event.type === "done") return { kind: "finished" };
      }
    } catch (error) {
      if (aborted()) return { kind: "aborted" };
      // Online, a stream cut short can as well be the function stopped on the server: that stays `internal`.
      fail(networkFailure(error, "The scan stream failed."));
      return { kind: "finished" };
    }
    if (aborted()) return { kind: "aborted" };
    fail({ code: "internal", message: "The scan ended before it finished." });
    return { kind: "finished" };
  }

  async function run(): Promise<void> {
    const first = await attempt();
    if (first.kind !== "busy") return;
    await new Promise<void>((resolve) => {
      wakeRetry = resolve;
      timer = setTimeout(resolve, retryDelay());
    });
    if (aborted()) return;
    handlers.onRetry?.();
    const second = await attempt();
    if (second.kind === "busy") fail(second.error);
  }

  const done = run().catch((error: unknown) => {
    fail({ code: "internal", message: error instanceof Error ? error.message : "Unknown error" });
  });

  return {
    abort() {
      if (aborted()) return;
      controller.abort();
      clearTimeout(timer);
      wakeRetry?.();
    },
    done,
  };
}

/** A request that failed in the browser. Offline, that is the connection and the panel says so; online, `internal`. */
function networkFailure(error: unknown, fallback: string): ScanErrorInfo {
  const message = error instanceof Error ? error.message : fallback;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return { code: "offline", message };
  return { code: "internal", message };
}

/**
 * How stream lines become events. Production stays lenient: a deploy that changes an event shape would otherwise turn
 * every stale tab into an error panel. Anywhere else each line is checked against the contract, loaded on demand so
 * zod never reaches the production bundle. The env is read inline so tests can reach both halves; Next replaces it
 * statically in the client build, which drops the import with its branch.
 */
async function eventCheck(): Promise<(raw: unknown) => ScanEvent | null> {
  if (process.env.NODE_ENV !== "production") {
    const contract = await import("@/lib/contract");
    return (raw) => {
      const result = contract.ScanEvent.safeParse(raw);
      if (result.success) return result.data;
      console.error("Invalid scan event", result.error.issues, raw);
      return null;
    };
  }
  return (raw) => raw as ScanEvent;
}

/**
 * Production passes events through unchecked (see `eventCheck`), so a code added by a later deploy reaches a stale tab
 * as is. It reads as `internal`, with the code it came with kept in the message for the debug copy, rather than as a
 * code the panel has no copy for.
 */
function errorFromEvent(event: Extract<ScanEvent, { type: "error" }>): ScanErrorInfo {
  const known = isErrorCode(event.code);
  const message = known ? event.message : `${String(event.code)}: ${event.message}`;
  return { code: known ? event.code : "internal", message, httpStatus: event.httpStatus, fallback: event.fallback, diagnostics: event.diagnostics };
}

/** The body of a gate refusal, when it is one: an `ApiError` with a code this client knows. */
function readApiError(body: unknown): ApiError["error"] | null {
  const error = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  return error && isErrorCode(error.code) && typeof error.message === "string" ? { code: error.code, message: error.message } : null;
}

async function gateError(response: Response): Promise<ScanErrorInfo> {
  const httpStatus = response.status;
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const refusal = readApiError(body);
  if (refusal) return { ...refusal, httpStatus };
  // A platform response without our JSON body: the firewall rate limit, or a crash before the handler answered.
  if (httpStatus === 429) return { code: "rate-limited", message: "Too many scans", httpStatus };
  return { code: "internal", message: `Unexpected response (${httpStatus})`, httpStatus };
}
