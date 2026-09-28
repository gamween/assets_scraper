import { afterEach, describe, expect, it, vi } from "vitest";
import { RemoteScanError } from "./source-remote";
import { createScanSource, remoteBaseUrl } from "./source";

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

  it("runs against the hosted app when one is named, with the token it was given", () => {
    vi.stubEnv("ASSETS_SCRAPER_TOKEN", undefined);
    expect(createScanSource({ remote: "https://example.test", token: "agent-token" }).kind).toBe("remote");
  });

  it("refuses a remote scan with no token, in words the caller can print", () => {
    vi.stubEnv("ASSETS_SCRAPER_TOKEN", undefined);
    const error = (() => {
      try {
        createScanSource({ remote: "https://example.test" });
      } catch (thrown) {
        return thrown;
      }
      throw new Error("expected a refusal");
    })();
    expect(error).toBeInstanceOf(RemoteScanError);
    expect((error as RemoteScanError).code).toBe("unauthorized");
    expect((error as RemoteScanError).message).toContain("ASSETS_SCRAPER_TOKEN");
  });
});
