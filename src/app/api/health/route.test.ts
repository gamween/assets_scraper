import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

describe("GET /api/health", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("reports the build and flags without caching", async () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "");
    vi.stubEnv("SCAN_DISABLED", "");
    vi.stubEnv("ACCESS_CODE", "");
    const response = GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, version: "dev", disabled: false, accessCode: false });
  });

  it("never exposes the access code itself", async () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "abc123");
    vi.stubEnv("SCAN_DISABLED", "1");
    vi.stubEnv("ACCESS_CODE", "secret-code");
    const text = await GET().text();
    expect(JSON.parse(text)).toEqual({ ok: true, version: "abc123", disabled: true, accessCode: true });
    expect(text).not.toContain("secret-code");
  });
});
