import { EventEmitter } from "node:events";
import type { Page, Response } from "playwright-core";
import { describe, expect, it } from "vitest";
import { startCapture } from "./capture";

/** A response the way the capture sees it, for an image served without a declared length. */
function imageResponse(url: string, onRead: () => void): Response {
  return {
    url: () => url,
    status: () => 200,
    headers: () => ({ "content-type": "image/png" }),
    request: () => ({ resourceType: () => "image" }),
    body: () => {
      onRead();
      return new Promise<Buffer>((resolve) => setImmediate(() => resolve(Buffer.alloc(8))));
    },
  } as unknown as Response;
}

describe("startCapture", () => {
  it("keeps scheduling cheap with thousands of reads waiting for the total cap", async () => {
    const page = new EventEmitter();
    const capture = startCapture(page as unknown as Page, { signal: new AbortController().signal, toneFromBytes: async () => "unknown", bodyReadMs: 60_000 });
    const count = 4_000;
    let reads = 0;
    let allStarted = () => {};
    const started = new Promise<void>((resolve) => (allStarted = resolve));
    const began = performance.now();
    // Without a declared length each read reserves the 15 MB body cap, so 16 fit in the 250 MB total: every completion
    // walks the rest of the queue.
    for (let i = 0; i < count; i += 1) page.emit("response", imageResponse(`https://example.com/${i}.png`, () => ++reads === count && setImmediate(allStarted)));
    await started;
    const network = await capture.settle(60_000);
    expect(network.images.filter((image) => image.sha1)).toHaveLength(count);
    // About 150 ms here; reading the limits on every step of the walk took about 10 s.
    expect(performance.now() - began).toBeLessThan(2_000);
  }, 60_000);
});
