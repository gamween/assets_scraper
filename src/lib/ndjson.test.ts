import { describe, expect, it } from "vitest";
import { chunkByBytes, decodeNdjson, encodeEvent } from "./ndjson";

function streamOf(parts: string[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(new TextEncoder().encode(part));
      controller.close();
    },
  });
}

describe("ndjson", () => {
  it("encodes one event per line", () => {
    expect(encodeEvent({ type: "step", step: "open", state: "start" })).toBe('{"type":"step","step":"open","state":"start"}\n');
  });

  it("decodes lines split across chunks and a trailing line without newline", async () => {
    const out: unknown[] = [];
    for await (const value of decodeNdjson(streamOf(['{"a":', '1}\n{"b"', ':2}\n\n{"c":3}']))) out.push(value);
    expect(out).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  it("chunks items by serialized size", () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ i, pad: "x".repeat(100) }));
    const chunks = chunkByBytes(items, 350);
    expect(chunks.flat()).toEqual(items);
    expect(chunks.every((c) => c.length <= 3)).toBe(true);
  });
});
