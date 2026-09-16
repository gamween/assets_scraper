import type { ScanEvent } from "./contract";

export const encodeEvent = (event: ScanEvent): string => `${JSON.stringify(event)}\n`;

export function chunkByBytes<T>(items: T[], maxBytes: number): T[][] {
  const encoder = new TextEncoder();
  const chunks: T[][] = [];
  let current: T[] = [];
  let size = 0;
  for (const item of items) {
    const itemSize = encoder.encode(JSON.stringify(item)).length + 1;
    if (current.length && size + itemSize > maxBytes) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(item);
    size += itemSize;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

export async function* decodeNdjson(stream: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  // TextDecoder in streaming mode instead of pipeThrough(new TextDecoderStream()): same multi-byte handling,
  // and TypeScript 6's DOM lib types TextDecoderStream's writable side as BufferSource, which does not accept a Uint8Array stream.
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) yield JSON.parse(line);
        index = buffer.indexOf("\n");
      }
    }
    const tail = buffer.trim();
    if (tail) yield JSON.parse(tail);
  } finally {
    reader.releaseLock();
  }
}
