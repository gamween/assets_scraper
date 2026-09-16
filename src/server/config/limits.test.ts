import { afterEach, describe, expect, it } from "vitest";
import { limitEnvName, limits } from "./limits";

describe("limits", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("maps keys to env names", () => {
    expect(limitEnvName("queueWaitMs")).toBe("QUEUE_WAIT_MS");
    expect(limitEnvName("maxConcurrentScans")).toBe("MAX_CONCURRENT_SCANS");
    expect(limitEnvName("proxyBytesPerDay")).toBe("PROXY_BYTES_PER_DAY");
  });

  it("reads overrides on every access and ignores invalid ones", () => {
    expect(limits.queueWaitMs).toBe(15_000);
    process.env.QUEUE_WAIT_MS = "200";
    expect(limits.queueWaitMs).toBe(200);
    for (const bad of ["", "0", "-5", "soon", "Infinity"]) {
      process.env.QUEUE_WAIT_MS = bad;
      expect(limits.queueWaitMs).toBe(15_000);
    }
    process.env.SCANS_PER_DAY = "2";
    expect(limits.scansPerDay).toBe(2);
  });

  it("lists every limit and cannot be mutated", () => {
    expect(Object.keys(limits)).toContain("scanDeadlineMs");
    expect(Object.values(limits).every((value) => typeof value === "number" && value > 0)).toBe(true);
    expect(Object.isFrozen(limits)).toBe(true);
  });

  it("types values as number, so callers can use them as defaults and override them", () => {
    const wait = (timeoutMs = limits.preflightMs) => timeoutMs;
    let deadline = limits.scanDeadlineMs;
    deadline = 15_000;
    const options = { maxBytes: limits.proxyMaxBytes };
    options.maxBytes = 1_024;
    expect([wait(5_000), deadline, options.maxBytes]).toEqual([5_000, 15_000, 1_024]);
  });
});
