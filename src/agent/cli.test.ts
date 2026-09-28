import { describe, expect, it } from "vitest";
import { DEFAULT_REMOTE, USAGE, UsageError, formatDownload, formatDropped, formatSummary, openSource, selectionFrom } from "./cli";
import { summarize } from "./summary";
import { testScan } from "./testing";
import type { DownloadResult } from "./types";

/**
 * The pieces of the CLI a test can read without a browser: what it makes of the options, and what its report says. The
 * commands themselves run against the fixture site in `tests/integration/agent/cli.test.ts`.
 */

const fails = (run: () => unknown): UsageError => {
  try {
    run();
  } catch (error) {
    if (error instanceof UsageError) return error;
    throw error;
  }
  throw new Error("expected a usage error");
};

describe("selectionFrom", () => {
  it("reads the filters the spec documents", () => {
    expect(
      selectionFrom({
        profile: "all",
        kind: "svg,image",
        role: "logo, site-logo",
        "min-long-side": "400",
        max: "12",
        "name-contains": "hero",
        "include-icons": true,
      }),
    ).toEqual({
      profile: "all",
      kinds: ["svg", "image"],
      roles: ["logo", "site-logo"],
      minLongSide: 400,
      max: 12,
      nameContains: "hero",
      includeIcons: true,
    });
  });

  it("leaves out what was not asked for, so the defaults hold", () => {
    expect(selectionFrom({})).toEqual({});
  });

  it("refuses a value that would silently select nothing", () => {
    expect(fails(() => selectionFrom({ profile: "quick" })).message).toContain("--profile takes deck or all");
    expect(fails(() => selectionFrom({ kind: "vector" })).message).toContain("--kind does not know");
    expect(fails(() => selectionFrom({ role: "hero" })).message).toContain("--role does not know");
    expect(fails(() => selectionFrom({ max: "0" })).message).toContain("--max takes a whole number");
    expect(fails(() => selectionFrom({ "min-long-side": "600px" })).message).toContain("--min-long-side takes a whole number");
  });
});

describe("openSource", () => {
  const withEnv = <T>(env: Record<string, string | undefined>, run: () => T): T => {
    const previous = Object.fromEntries(Object.keys(env).map((name) => [name, process.env[name]]));
    Object.assign(process.env, env);
    for (const [name, value] of Object.entries(env)) if (value === undefined) delete process.env[name];
    try {
      return run();
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  };

  it("scans locally when nothing names a hosted app", () => {
    expect(withEnv({ ASSETS_SCRAPER_REMOTE: undefined }, () => openSource({}).kind)).toBe("local");
  });

  it("scans remotely on --remote, and says what a missing token is", () => {
    expect(withEnv({ ASSETS_SCRAPER_REMOTE: undefined, ASSETS_SCRAPER_TOKEN: "t" }, () => openSource({ remote: true }).kind)).toBe("remote");
    const failure = withEnv({ ASSETS_SCRAPER_REMOTE: undefined, ASSETS_SCRAPER_TOKEN: undefined }, () => {
      try {
        return openSource({ remote: true });
      } catch (error) {
        return error as Error;
      }
    });
    expect((failure as Error).message).toContain("ASSETS_SCRAPER_TOKEN");
    expect((failure as Error).message).toContain(DEFAULT_REMOTE);
  });

  it("uses the hosted app the environment names without a flag", () => {
    expect(
      withEnv({ ASSETS_SCRAPER_REMOTE: "https://scraper.example.com", ASSETS_SCRAPER_TOKEN: "t" }, () => openSource({}).kind),
    ).toBe("remote");
  });
});

describe("the report", () => {
  it("names every drop reason, biggest first", () => {
    expect(formatDropped({ icon: 4, small: 9, cap: 0, "near-duplicate": 2 })).toBe("9 too small, 4 icons, 2 the same picture twice");
    expect(formatDropped({})).toBe("");
  });

  it("prints the page, the counts and the scan id", () => {
    const report = formatSummary(summarize(testScan()), true);
    expect(report).toContain("Stripe (stripe.com)");
    expect(report).toContain("236 assets: 40 svg, 196 images");
    expect(report).toContain("font: Inter (open licence, used on the page, installable)");
    expect(report).toContain("scan id: scan-1 (reused from the cache");
  });

  it("prints absolute paths, the drop reasons and the manifest", () => {
    const result: DownloadResult = {
      dir: "/work/scrap/stripe.com",
      files: [{ id: "a", name: "Logo", path: "/work/scrap/stripe.com/svg/logo.svg", bytes: 2_048, kind: "svg", role: "logo", url: "https://stripe.com/logo.svg" }],
      totalBytes: 2_048,
      dropped: { icon: 3 },
      failed: [{ id: "b", name: "Hero", reason: "HTTP 403" }],
      manifestPath: "/work/scrap/stripe.com/manifest.json",
    };
    const report = formatDownload(result);
    expect(report).toContain("wrote 1 file, 2.0 KB into /work/scrap/stripe.com");
    expect(report).toContain("  /work/scrap/stripe.com/svg/logo.svg");
    expect(report).toContain("dropped 3: 3 icons");
    expect(report).toContain("failed: Hero (HTTP 403)");
    expect(report).toContain("manifest: /work/scrap/stripe.com/manifest.json");
  });

  it("keeps the copy rules: no em dash, no en dash, no emoji", () => {
    expect(USAGE).not.toMatch(/[—–]/u);
    expect(USAGE).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(USAGE).toContain("assets-scraper get <url>");
  });
});
