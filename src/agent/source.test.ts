import { afterEach, describe, expect, it, vi } from "vitest";
import { createScanSource, NotImplementedError, remoteBaseUrl } from "./source";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("createScanSource", () => {
  it("runs locally by default", () => {
    vi.stubEnv("ASSETS_SCRAPER_REMOTE", undefined);
    expect(createScanSource().kind).toBe("local");
    expect(createScanSource({ remote: "" }).kind).toBe("local");
  });

  it("reads the remote from the options or the environment, without a trailing slash", () => {
    expect(remoteBaseUrl({ remote: "https://assets-scraper.vercel.app/" })).toBe("https://assets-scraper.vercel.app");
    vi.stubEnv("ASSETS_SCRAPER_REMOTE", "https://example.test//");
    expect(remoteBaseUrl()).toBe("https://example.test");
    expect(remoteBaseUrl({ remote: "  " })).toBeUndefined();
  });

  it("says the remote source is not in this build yet", () => {
    expect(() => createScanSource({ remote: "https://example.test" })).toThrow(NotImplementedError);
  });
});
