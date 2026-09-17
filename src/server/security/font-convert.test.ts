import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fonts = vi.hoisted(() => ({
  parseFontBinary: vi.fn((buffer: Buffer) => ({ format: ({ wOF2: "woff2", OTTO: "otf", "\0\x01\0\0": "ttf" } as Record<string, string>)[buffer.subarray(0, 4).toString("latin1")] ?? "other" })),
  isConvertibleFont: vi.fn<(meta: unknown, options: { signal: AbortSignal }) => Promise<boolean>>(async () => true),
}));
vi.mock("@/server/scan/fonts/index", () => fonts);

import { convertWoff2, createSlots, WOFF2_MAX_OUTPUT_BYTES } from "./font-convert";

const ASSETS = path.join(import.meta.dirname, "../../../tests/fixtures/site/assets");
const inter = readFileSync(path.join(ASSETS, "__inter.woff2"));
const ss3 = readFileSync(path.join(ASSETS, "ss3.woff2"));

/** Resolves on the next macrotask, once every pending grant and abort has been handled. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("createSlots", () => {
  it("grants free slots at once, then queues callers in order", async () => {
    const take = createSlots(2);
    const never = new AbortController().signal;
    const first = await take(never);
    const second = await take(never);
    expect(first).toBeTypeOf("function");
    expect(second).toBeTypeOf("function");

    const granted: string[] = [];
    const third = take(never).then((release) => { granted.push("third"); return release; });
    const fourth = take(never).then((release) => { granted.push("fourth"); return release; });
    await settle();
    expect(granted).toEqual([]);
    first!();
    await settle();
    expect(granted).toEqual(["third"]);
    second!();
    await settle();
    expect(granted).toEqual(["third", "fourth"]);
    (await third)!();
    (await fourth)!();
    // every slot is free again
    const again = await Promise.all([take(never), take(never)]);
    expect(again.every((release) => typeof release === "function")).toBe(true);
  });

  it("drops a waiter whose signal aborts, and refuses an aborted signal when no slot is free", async () => {
    const take = createSlots(1);
    const held = await take(new AbortController().signal);
    const leaving = new AbortController();
    const waiting = take(leaving.signal);
    const staying = take(new AbortController().signal);
    leaving.abort();
    expect(await waiting).toBeNull();
    const aborted = new AbortController();
    aborted.abort();
    expect(await take(aborted.signal)).toBeNull();
    // the slot goes to the waiter that stayed, not to the one that left
    held!();
    const next = await staying;
    expect(next).toBeTypeOf("function");
    next!();
  });

  it("releases a slot once however often release is called", async () => {
    const take = createSlots(1);
    const never = new AbortController().signal;
    const release = await take(never);
    const waiters = [take(never), take(never)];
    release!();
    release!();
    await settle();
    let second = false;
    void waiters[1].then(() => { second = true; });
    await settle();
    // a second release of the same slot must not hand out a slot that is still held
    expect(second).toBe(false);
    (await waiters[0])!();
    (await waiters[1])!();
  });
});

describe("convertWoff2", () => {
  beforeEach(() => {
    fonts.parseFontBinary.mockClear();
    fonts.isConvertibleFont.mockReset();
    fonts.isConvertibleFont.mockResolvedValue(true);
  });

  it("decompresses to TrueType or CFF sfnt, labelled by outline format", async () => {
    const ttf = await convertWoff2(inter, new AbortController().signal);
    expect(ttf).toMatchObject({ ok: true, contentType: "font/ttf" });
    expect(ttf.ok && ttf.bytes.subarray(0, 4).toString("hex")).toBe("00010000");
    const otf = await convertWoff2(ss3, new AbortController().signal);
    expect(otf).toMatchObject({ ok: true, contentType: "font/otf" });
    expect(otf.ok && otf.bytes.subarray(0, 4).toString("latin1")).toBe("OTTO");
    // the licence is read from the sfnt woff2 produced, so fontkit never decodes untrusted brotli streams in JavaScript
    expect(fonts.parseFontBinary.mock.calls.map(([buffer]) => buffer.subarray(0, 4).toString("latin1"))).toEqual(["\0\x01\0\0", "OTTO"]);
    expect(fonts.isConvertibleFont.mock.calls.map(([meta]) => meta)).toEqual([{ format: "ttf" }, { format: "otf" }]);
    expect(fonts.isConvertibleFont).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ fetch: expect.any(Function), signal: expect.any(AbortSignal) }));
  });

  it("keeps each output intact when conversions run at the same time", async () => {
    const signal = new AbortController().signal;
    const sequential = [await convertWoff2(inter, signal), await convertWoff2(ss3, signal)];
    // wawoff2 answers with a view of its heap, which the next decompression reuses before an awaiting caller copies it
    const concurrent = await Promise.all([convertWoff2(inter, signal), convertWoff2(ss3, signal), convertWoff2(inter, signal)]);
    const bytes = (result: Awaited<ReturnType<typeof convertWoff2>>) => (result.ok ? Buffer.from(result.bytes) : null);
    expect(concurrent.map(bytes)).toEqual([bytes(sequential[0]), bytes(sequential[1]), bytes(sequential[0])]);
  });

  it("never returns more than WOFF2_MAX_OUTPUT_BYTES, whatever size the header declares", async () => {
    const signal = new AbortController().signal;
    const declaring = (totalSfntSize: number) => {
      const copy = Buffer.from(inter);
      copy.writeUInt32BE(totalSfntSize, 16);
      return copy;
    };
    const real = await convertWoff2(inter, signal);
    expect(real.ok && real.bytes.length).toBe(inter.readUInt32BE(16));
    // a smaller declared size does not shrink the output, a larger one pads it: the header bounds nothing
    const small = await convertWoff2(declaring(1), signal);
    expect(small.ok && small.bytes.length).toBe(inter.readUInt32BE(16));
    const huge = await convertWoff2(declaring(0xffffffff), signal);
    expect(huge.ok ? huge.bytes.length : 0).toBeGreaterThan(20 * 1024 * 1024);
    expect(huge.ok ? huge.bytes.length : 0).toBeLessThanOrEqual(WOFF2_MAX_OUTPUT_BYTES);
  });

  it("refuses a font whose licence does not allow conversion, and bytes that are not WOFF2", async () => {
    fonts.isConvertibleFont.mockResolvedValue(false);
    expect(await convertWoff2(inter, new AbortController().signal)).toEqual({ ok: false, reason: "license" });
    fonts.isConvertibleFont.mockResolvedValue(true);
    fonts.parseFontBinary.mockClear();
    fonts.isConvertibleFont.mockClear();
    // woff2 validates the table directory first: bytes it refuses never reach fontkit or the Google Fonts check
    const truncated = Buffer.from(inter.subarray(0, 64));
    expect(await convertWoff2(truncated, new AbortController().signal)).toEqual({ ok: false, reason: "not-convertible" });
    expect(fonts.parseFontBinary).not.toHaveBeenCalled();
    expect(fonts.isConvertibleFont).not.toHaveBeenCalled();
  });
});
