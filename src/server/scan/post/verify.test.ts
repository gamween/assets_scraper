import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLimiter } from "./verify";

/**
 * The limiter is pure scheduling, so it runs on fake timers: the deadline and the tasks' own sleeps move only when the
 * test says so, and no loaded runner can make a batch miss the deadline it was written to meet.
 */
describe("createLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("respects the concurrency and stops starting tasks at the deadline", async () => {
    const limiter = createLimiter({ concurrency: 16, deadline: Date.now() + 300 });
    let active = 0;
    let maxActive = 0;
    let started = 0;
    const task = async () => {
      started++;
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 200));
      active--;
      return { ok: true as const };
    };
    const results = Promise.all(Array.from({ length: 40 }, () => limiter.run(task)));

    expect(started).toBe(16);
    // The first batch ends before the deadline, so the second one starts in its slots
    await vi.advanceTimersByTimeAsync(200);
    expect(started).toBe(32);
    // The deadline passes while the second batch runs: the eight tasks still queued never start
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);
    const settled = await results;

    expect(maxActive).toBe(16);
    expect(started).toBe(32);
    expect(settled.filter((result) => result.ok)).toHaveLength(32);
    expect(settled.slice(32)).toEqual(Array.from({ length: 8 }, () => ({ ok: false, reason: "verify-skipped" })));
    expect(limiter.skipped).toBe(8);
    limiter.close();
  });

  it("aborts running tasks at the deadline", async () => {
    const limiter = createLimiter({ concurrency: 2, deadline: Date.now() + 50 });
    const result = limiter.run(
      (signal) => new Promise<{ ok: boolean; reason?: string }>((resolve) => signal.addEventListener("abort", () => resolve({ ok: false, reason: "aborted" }))),
    );
    await vi.advanceTimersByTimeAsync(50);
    expect(await result).toEqual({ ok: false, reason: "aborted" });
    limiter.close();
  });

  it("skips every queued task when the caller's signal aborts", async () => {
    const controller = new AbortController();
    const limiter = createLimiter({ concurrency: 1, deadline: Date.now() + 10_000, signal: controller.signal });
    const running = limiter.run((signal) => new Promise<string>((resolve) => signal.addEventListener("abort", () => resolve("aborted"))));
    const queued = limiter.run(async () => "ran");
    controller.abort();
    expect(await running).toBe("aborted");
    expect(await queued).toEqual({ ok: false, reason: "verify-skipped" });
    expect(limiter.skipped).toBe(1);
    limiter.close();
  });
});
