import { describe, expect, it } from "vitest";
import { chunkByBytes, decodeNdjson, encodeEvent } from "./ndjson";

function streamOf(parts: (string | Uint8Array)[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(typeof part === "string" ? new TextEncoder().encode(part) : part);
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>) {
  const out: unknown[] = [];
  for await (const value of decodeNdjson(stream)) out.push(value);
  return out;
}

const lineBytes = (items: unknown[]) => new TextEncoder().encode(`${JSON.stringify({ type: "assets", items })}\n`).length;

describe("ndjson", () => {
  it("encodes one event per line", () => {
    expect(encodeEvent({ type: "step", step: "open", state: "start" })).toBe('{"type":"step","step":"open","state":"start"}\n');
  });

  it("decodes lines split across chunks and a trailing line without newline", async () => {
    expect(await collect(streamOf(['{"a":', '1}\n{"b"', ':2}\n\n{"c":3}']))).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  it("decodes multi-byte characters split across chunks", async () => {
    const bytes = new TextEncoder().encode('{"name":"Söhne 日本"}\n');
    const cuts = [11, 12, 20, 21];
    const parts = [0, ...cuts].map((start, i) => bytes.slice(start, [...cuts, bytes.length][i]));
    expect(await collect(streamOf(parts))).toEqual([{ name: "Söhne 日本" }]);
  });

  it("chunks items by serialized size", () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ i, pad: "x".repeat(100) }));
    const chunks = chunkByBytes(items, 350);
    expect(chunks.flat()).toEqual(items);
    expect(chunks.every((c) => c.length <= 3)).toBe(true);
  });

  it("keeps every encoded line, envelope included, within the byte limit", () => {
    const items = Array.from({ length: 40 }, (_, i) => ({ i, name: "é".repeat(i % 7), pad: "x".repeat(20 + i) }));
    for (const maxBytes of [160, 256, 1_000]) {
      const chunks = chunkByBytes(items, maxBytes);
      expect(chunks.flat()).toEqual(items);
      for (const chunk of chunks) expect(lineBytes(chunk)).toBeLessThanOrEqual(maxBytes);
    }
  });

  it("puts an item that cannot fit on its own line", () => {
    const big = { pad: "x".repeat(500) };
    const chunks = chunkByBytes([{ a: 1 }, big, { b: 2 }], 200);
    expect(chunks).toEqual([[{ a: 1 }], [big], [{ b: 2 }]]);
  });
});
