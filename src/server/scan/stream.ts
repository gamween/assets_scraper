import type { ScanEvent } from "@/lib/contract";
import { encodeEvent } from "@/lib/ndjson";

const INTERNAL: ScanEvent = { type: "error", code: "internal", message: "Something went wrong on our side" };

/**
 * Writes scan events as an NDJSON response (spec 6): one event per line, pulled only as fast as the client reads.
 * A terminal event (`done` or `error`) is always the last line, and an iterable that throws ends with an `internal`
 * error. Cancelling the body or aborting the request closes the iterable, which stops the scan.
 */
export function eventsToResponse(events: AsyncIterable<ScanEvent>, signal: AbortSignal): Response {
  const encoder = new TextEncoder();
  const iterator = events[Symbol.asyncIterator]();
  let finished = false;
  let close = () => {};

  const finish = () => {
    if (finished) return;
    finished = true;
    signal.removeEventListener("abort", onAbort);
    void iterator.return?.()?.catch(() => {});
  };
  const onAbort = () => {
    finish();
    close();
  };

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      close = () => {
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    },
    async pull(controller) {
      let event: ScanEvent;
      try {
        const next = await iterator.next();
        if (finished) return;
        if (next.done) {
          finished = true;
          signal.removeEventListener("abort", onAbort);
          return close();
        }
        event = next.value;
      } catch {
        if (finished) return;
        event = INTERNAL;
      }
      controller.enqueue(encoder.encode(encodeEvent(event)));
      if (event.type === "done" || event.type === "error") {
        finish();
        close();
      }
    },
    cancel() {
      finish();
    },
  });

  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" },
  });
}
