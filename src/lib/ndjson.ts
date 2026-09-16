import type { ScanEvent } from "./contract";

export const encodeEvent = (event: ScanEvent): string => `${JSON.stringify(event)}\n`;

/** Room left in each line for the event around the items, such as `{"type":"assets","items":[...]}` and the newline. */
const EVENT_ENVELOPE_BYTES = 64;

/**
 * Splits items into batches whose encoded event line (items plus an envelope of up to 64 bytes) fits in `maxBytes`.
 * Best effort: an item too large to fit in a line by itself still gets its own batch, and its own line.
 */
export function chunkByBytes<T>(items: T[], maxBytes: number): T[][] {
  const encoder = new TextEncoder();
  const budget = maxBytes - EVENT_ENVELOPE_BYTES;
  const chunks: T[][] = [];
  let current: T[] = [];
  let size = 0;
  for (const item of items) {
    const itemSize = encoder.encode(JSON.stringify(item)).length + 1; // + 1 for the separating comma
    if (current.length && size + itemSize > budget) {
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

/**
 * Yields one parsed value per line. When iteration stops before the end of the stream (the consumer breaks out of
 * the loop, or a line is not valid JSON and the generator throws), the stream is cancelled so a fetch body stops downloading.
 */
export async function* decodeNdjson(stream: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  // TextDecoder in streaming mode instead of pipeThrough(new TextDecoderStream()): same multi-byte handling,
  // and TypeScript 6's DOM lib types TextDecoderStream's writable side as BufferSource, which does not accept a Uint8Array stream.
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let ended = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        ended = true;
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
    // Not awaited: cancelling closes the stream at once, and a slow source cancel must not block the consumer.
    if (!ended) reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
