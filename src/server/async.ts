/**
 * Promise helpers for deadlines and cancellation, shared by the browser launch, the engine and its phases.
 *
 * Every helper settles once, removes its timer and its abort listener as soon as it settles, and never leaves a
 * rejection of the promise it wraps unhandled: once a helper has settled another way, a later rejection is ignored.
 */

/**
 * Settles like `promise`, unless `ms` pass first (then like `onTimeout`) or `signal` aborts first (then like `onAbort`).
 * A handler settles by returning a value, or rejects by throwing.
 */
function settleFirst<T>(promise: Promise<T>, options: { ms?: number; signal?: AbortSignal; onTimeout?: () => T; onAbort?: () => T }): Promise<T> {
  const { ms, signal, onTimeout, onAbort } = options;
  promise.catch(() => {});
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (outcome: () => T) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      try {
        resolve(outcome());
      } catch (error) {
        reject(error);
      }
    };
    const aborted = () => settle(onAbort!);
    if (signal && onAbort) {
      if (signal.aborted) return aborted();
      signal.addEventListener("abort", aborted, { once: true });
    }
    if (ms !== undefined && onTimeout) timer = setTimeout(() => settle(onTimeout), Math.max(0, ms));
    promise.then(
      (value) => settle(() => value),
      (error: unknown) =>
        settle(() => {
          throw error;
        }),
    );
  });
}

/** Settles like `promise`, or rejects with the abort reason as soon as `signal` aborts. */
export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return settleFirst(promise, {
    signal,
    onAbort: () => {
      throw signal.reason;
    },
  });
}

/** Settles like `promise`, or resolves with `fallback` once `ms` have passed or `signal` aborts. */
export function orAfter<T, F>(promise: Promise<T>, ms: number, fallback: F, signal?: AbortSignal): Promise<T | F> {
  const late = () => fallback;
  return settleFirst<T | F>(promise, { ms, signal, onTimeout: late, onAbort: late });
}

/** Resolves with the value of `promise`, or with `fallback` when it rejects or once `ms` have passed. Rejects only with the abort reason of `signal`. */
export function capped<T>(promise: Promise<T>, ms: number, fallback: T, signal?: AbortSignal): Promise<T> {
  return settleFirst(
    promise.catch(() => fallback),
    {
      ms,
      signal,
      onTimeout: () => fallback,
      onAbort: () => {
        throw signal?.reason;
      },
    },
  );
}

/** Settles like `promise`, or rejects with `error()` once `ms` have passed. */
export function timeoutAfter<T>(promise: Promise<T>, ms: number, error: () => unknown): Promise<T> {
  return settleFirst(promise, {
    ms,
    onTimeout: () => {
      throw error();
    },
  });
}

/** Resolves after `ms`, or rejects with the abort reason as soon as `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return capped(new Promise<void>(() => {}), ms, undefined, signal);
}
