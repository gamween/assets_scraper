import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { capped, orAfter, sleep, timeoutAfter, untilAborted } from "./async";

const never = <T>() => new Promise<T>(() => {});
const later = <T>(ms: number, value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));
const failLater = (ms: number, error: Error) => new Promise<never>((_, reject) => setTimeout(() => reject(error), ms));

/** The outcome of a promise once it settled, or "pending". */
function track<T>(promise: Promise<T>) {
  let state: { value: T } | { error: unknown } | "pending" = "pending";
  promise.then(
    (value) => (state = { value }),
    (error: unknown) => (state = { error }),
  );
  return () => state;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("untilAborted", () => {
  it("settles like the promise while the signal stays quiet", async () => {
    const controller = new AbortController();
    await expect(untilAborted(Promise.resolve(1), controller.signal)).resolves.toBe(1);
    await expect(untilAborted(Promise.reject(new Error("boom")), controller.signal)).rejects.toThrow("boom");
  });

  it("rejects with the abort reason at once, and ignores a later rejection", async () => {
    const controller = new AbortController();
    const reason = new Error("stopped");
    const outcome = track(untilAborted(failLater(100, new Error("late")), controller.signal));
    controller.abort(reason);
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome()).toEqual({ error: reason });
    await vi.advanceTimersByTimeAsync(200);
    expect(outcome()).toEqual({ error: reason });
    await expect(untilAborted(never(), controller.signal)).rejects.toBe(reason);
  });

  it("removes its abort listener once the promise settles", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    await untilAborted(Promise.resolve(1), controller.signal);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});

describe("orAfter", () => {
  it("resolves with the fallback once the time is up, and with the value before", async () => {
    const slow = track(orAfter(later(200, "value"), 100, "fallback"));
    const fast = track(orAfter(later(50, "value"), 100, "fallback"));
    await vi.advanceTimersByTimeAsync(100);
    expect(slow()).toEqual({ value: "fallback" });
    expect(fast()).toEqual({ value: "value" });
    expect(vi.getTimerCount()).toBe(1);
  });

  it("passes a rejection through", async () => {
    const outcome = track(orAfter(failLater(10, new Error("boom")), 100, "fallback"));
    await vi.advanceTimersByTimeAsync(10);
    expect(outcome()).toEqual({ error: new Error("boom") });
  });

  it("resolves with the fallback when the signal aborts, before or during the wait", async () => {
    const controller = new AbortController();
    const outcome = track(orAfter(never(), 1_000, undefined, controller.signal));
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome()).toEqual({ value: undefined });
    expect(vi.getTimerCount()).toBe(0);
    await expect(orAfter(failLater(0, new Error("ignored")), 1_000, "fallback", controller.signal)).resolves.toBe("fallback");
  });
});

describe("capped", () => {
  it("gives the value, or the fallback on a rejection or once the time is up", async () => {
    const value = track(capped(later(10, 1), 100, 0));
    const failed = track(capped(failLater(10, new Error("boom")), 100, 0));
    const slow = track(capped(later(200, 1), 100, 0));
    await vi.advanceTimersByTimeAsync(10);
    expect(value()).toEqual({ value: 1 });
    expect(failed()).toEqual({ value: 0 });
    expect(slow()).toBe("pending");
    await vi.advanceTimersByTimeAsync(90);
    expect(slow()).toEqual({ value: 0 });
  });

  it("rejects with the abort reason and clears its timer", async () => {
    const controller = new AbortController();
    const outcome = track(capped(never<number>(), 1_000, 0, controller.signal));
    controller.abort(new Error("stopped"));
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome()).toEqual({ error: new Error("stopped") });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits at least zero milliseconds for a negative cap", async () => {
    const outcome = track(capped(never<number>(), -5, 7));
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome()).toEqual({ value: 7 });
  });
});

describe("timeoutAfter", () => {
  it("rejects with its error once the time is up, and settles like the promise before", async () => {
    const slow = track(timeoutAfter(later(200, 1), 100, () => new Error("too slow")));
    const fast = track(timeoutAfter(later(50, 1), 100, () => new Error("too slow")));
    await vi.advanceTimersByTimeAsync(100);
    expect(slow()).toEqual({ error: new Error("too slow") });
    expect(fast()).toEqual({ value: 1 });
  });
});

describe("sleep", () => {
  it("resolves after the time, or rejects as soon as the signal aborts", async () => {
    const done = track(sleep(100));
    await vi.advanceTimersByTimeAsync(99);
    expect(done()).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(done()).toEqual({ value: undefined });

    const controller = new AbortController();
    const stopped = track(sleep(1_000, controller.signal));
    controller.abort(new Error("stopped"));
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped()).toEqual({ error: new Error("stopped") });
  });
});
