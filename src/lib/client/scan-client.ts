import { ApiError, ScanEvent, type Asset, type Diagnostics, type ErrorCode } from "@/lib/contract";
import { decodeNdjson } from "@/lib/ndjson";
import { readString, writeString } from "./storage";

export const ACCESS_CODE_KEY = "assets-scraper:access-code";

export const readAccessCode = () => readString(ACCESS_CODE_KEY);
export const storeAccessCode = (code: string | null) => writeString(ACCESS_CODE_KEY, code);

/** A failed scan, from the gate (JSON, before streaming) or from the stream (`error` event, always the last line). */
export interface ScanErrorInfo {
  code: ErrorCode;
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
      fail({ code: "internal", message: error instanceof Error ? error.message : "Network error" });
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
      fail({ code: "internal", message: error instanceof Error ? error.message : "The scan stream failed." });
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

/**
 * Production stays lenient: a deploy that changes an event shape would otherwise turn every stale tab into an error
 * panel. The env is read inline so tests can reach both halves; Next replaces it statically in the client build.
 */
function parseEvent(raw: unknown): ScanEvent | null {
  if (process.env.NODE_ENV === "production") return raw as ScanEvent;
  const result = ScanEvent.safeParse(raw);
  if (result.success) return result.data;
  console.error("Invalid scan event", result.error.issues, raw);
  return null;
}

function errorFromEvent(event: Extract<ScanEvent, { type: "error" }>): ScanErrorInfo {
  return { code: event.code, message: event.message, httpStatus: event.httpStatus, fallback: event.fallback, diagnostics: event.diagnostics };
}

async function gateError(response: Response): Promise<ScanErrorInfo> {
  const httpStatus = response.status;
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const parsed = ApiError.safeParse(body);
  if (parsed.success) return { ...parsed.data.error, httpStatus };
  // A platform response without our JSON body: the firewall rate limit, or a crash before the handler answered.
  if (httpStatus === 429) return { code: "rate-limited", message: "Too many scans", httpStatus };
  return { code: "internal", message: `Unexpected response (${httpStatus})`, httpStatus };
}
