import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { limitEnvName, limits } from "./limits";

describe("limits", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("maps keys to env names", () => {
    expect(limitEnvName("queueWaitMs")).toBe("QUEUE_WAIT_MS");
    expect(limitEnvName("maxConcurrentScans")).toBe("MAX_CONCURRENT_SCANS");
    expect(limitEnvName("proxyBytesPerDay")).toBe("PROXY_BYTES_PER_DAY");
  });

  it("reads overrides on every access and ignores invalid ones", () => {
    expect(limits.queueWaitMs).toBe(15_000);
    vi.stubEnv("QUEUE_WAIT_MS", "200");
    expect(limits.queueWaitMs).toBe(200);
    for (const bad of ["", "0", "-5", "soon", "Infinity", "1.5", "9007199254740993"]) {
      vi.stubEnv("QUEUE_WAIT_MS", bad);
      expect(limits.queueWaitMs).toBe(15_000);
    }
    vi.stubEnv("SCANS_PER_DAY", "2");
    expect(limits.scansPerDay).toBe(2);
  });

  it("only accepts whole numbers", () => {
    vi.stubEnv("MAX_CONCURRENT_SCANS", "1.5");
    expect(limits.maxConcurrentScans).toBe(1);
    vi.stubEnv("MAX_CONCURRENT_SCANS", "2");
    expect(limits.maxConcurrentScans).toBe(2);
    vi.stubEnv("PROXY_BYTES_PER_DAY", "1e6");
    expect(limits.proxyBytesPerDay).toBe(1_000_000);
  });

  it("goes back to defaults once the overrides are removed", () => {
    expect(limits.queueWaitMs).toBe(15_000);
    expect(limits.scansPerDay).toBe(80);
    expect(process.env.QUEUE_WAIT_MS).toBeUndefined();
  });

  it("lists every limit and cannot be mutated", () => {
    expect(Object.keys(limits)).toContain("scanDeadlineMs");
    expect(Object.values(limits).every((value) => typeof value === "number" && value > 0)).toBe(true);
    expect(Object.isFrozen(limits)).toBe(true);
  });

  it("types values as number, not literals, so callers can use them as defaults and override them", () => {
    // Checked by tsc in `pnpm typecheck`: expectTypeOf does nothing at runtime.
    expectTypeOf(limits.preflightMs).toEqualTypeOf<number>();
    expectTypeOf(limits.proxyMaxBytes).toEqualTypeOf<number>();
    expectTypeOf(limits.scansPerDay).toEqualTypeOf<number>();
  });
});
