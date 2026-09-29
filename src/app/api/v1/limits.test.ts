import { afterEach, describe, expect, it, vi } from "vitest";
import { zipMaxBytes } from "./limits";

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
});
