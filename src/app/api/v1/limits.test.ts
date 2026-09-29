import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { limits } from "@/server/config/limits";
import { zipDeadlineMs, zipMaxBytes } from "./limits";

describe("agent API limits", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads AGENT_ZIP_MAX_BYTES for the per request cap", () => {
    vi.stubEnv("AGENT_ZIP_MAX_BYTES", "4096");
    expect(zipMaxBytes()).toBe(4_096);
    vi.stubEnv("AGENT_ZIP_MAX_BYTES", "not a number");
    expect(zipMaxBytes()).toBe(64 * 1024 * 1024);
  });

  /** `maxDuration` lives in `vercel.json`, the deadline in code: this is what keeps the two from drifting apart. */
  it("builds the archive after the scan's own deadline and well before the function's", () => {
    const vercel = JSON.parse(readFileSync(path.join(import.meta.dirname, "../../../../vercel.json"), "utf8"));
    const functionMs = vercel.functions["src/app/api/v1/assets.zip/route.ts"].maxDuration * 1000;
    expect(zipDeadlineMs()).toBeGreaterThan(limits.scanDeadlineMs);
    expect(functionMs - zipDeadlineMs()).toBeGreaterThanOrEqual(15_000);
    vi.stubEnv("AGENT_ZIP_DEADLINE_MS", "2500");
    expect(zipDeadlineMs()).toBe(2_500);
  });
});
