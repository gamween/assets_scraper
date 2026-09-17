import { describe, expect, it } from "vitest";
import type { ScanEvent } from "@/lib/contract";
import { decodeNdjson } from "@/lib/ndjson";
import { eventsToResponse } from "./stream";

const accepted: ScanEvent = { type: "accepted", scanId: "scan-1", url: "https://example.com/" };
const openStart: ScanEvent = { type: "step", step: "open", state: "start" };
const failed: ScanEvent = { type: "error", code: "dns", message: "The host could not be resolved" };

async function* generate(events: ScanEvent[], failAfter?: number) {
  let index = 0;
  for (const event of events) {
    if (index++ === failAfter) throw new Error("engine exploded");
    yield event;
  }
}

async function lines(response: Response) {
  const out: unknown[] = [];
  for await (const value of decodeNdjson(response.body as ReadableStream<Uint8Array>)) out.push(value);
  return out;
}

/** An iterator that hands out events on demand and never ends by itself, recording return() calls. */
function endless() {
  const state = { returned: 0, pulls: 0 };
  const iterable: AsyncIterable<ScanEvent> = {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        state.pulls += 1;
        if (state.pulls > 1) await new Promise(() => {});
        return { value: openStart, done: false };
      },
      return: async () => {
        state.returned += 1;
        return { value: undefined, done: true };
      },
    }),
  };
  return { iterable, state };
}

describe("eventsToResponse", () => {
  it("streams one NDJSON line per event with streaming headers", async () => {
    const response = eventsToResponse(generate([accepted, openStart, failed]), new AbortController().signal);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/x-ndjson; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(await lines(response)).toEqual([accepted, openStart, failed]);
  });

  it("ends with an internal error line when the events throw", async () => {
    const response = eventsToResponse(generate([accepted, openStart, failed], 2), new AbortController().signal);
    expect(await lines(response)).toEqual([accepted, openStart, { type: "error", code: "internal", message: "Something went wrong on our side" }]);
  });

  it("stops after a terminal event", async () => {
    const response = eventsToResponse(generate([accepted, failed, openStart]), new AbortController().signal);
    expect(await lines(response)).toEqual([accepted, failed]);
  });

  it("closes the events when the body is cancelled", async () => {
    const { iterable, state } = endless();
    const response = eventsToResponse(iterable, new AbortController().signal);
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(`${JSON.stringify(openStart)}\n`);
    await reader.cancel();
    expect(state.returned).toBe(1);
  });

  it("closes the events and the stream when the request aborts", async () => {
    const { iterable, state } = endless();
    const controller = new AbortController();
    const response = eventsToResponse(iterable, controller.signal);
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    controller.abort();
    expect(await reader.read()).toEqual({ value: undefined, done: true });
    expect(state.returned).toBe(1);
  });
});
