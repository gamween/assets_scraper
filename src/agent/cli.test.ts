import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveScan } from "./cache";
import { DEFAULT_REMOTE, USAGE, UsageError, formatDownload, formatDropped, formatSummary, openSource, scanPage, scanUrl, selectionFrom } from "./cli";
import { summarize } from "./summary";
import { testScan } from "./testing";
import type { AgentScan, DownloadResult, ScanSource } from "./types";

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

describe("scanUrl", () => {
  it("reads a URL the way the app reads what a user pastes", () => {
    expect(scanUrl("stripe.com")).toBe("https://stripe.com/");
    expect(scanUrl(" <https://stripe.com/pricing>. ")).toBe("https://stripe.com/pricing");
    expect(scanUrl("http://127.0.0.1:8080/")).toBe("http://127.0.0.1:8080/");
  });

  it("refuses what is not a web address, with the code the API uses", () => {
    expect(fails(() => scanUrl("not a url")).message).toContain("invalid-url");
    expect(fails(() => scanUrl("mailto:someone@example.com")).message).toContain("invalid-url");
  });

  it("leaves an unusual port to the scan, which knows whether it is allowed", () => {
    expect(scanUrl("stripe.com:8443")).toBe("https://stripe.com:8443/");
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

describe("scanPage", () => {
  const trees: string[] = [];
  afterEach(() => {
    for (const tree of trees.splice(0)) fs.rmSync(tree, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  /** An empty cache directory of its own, so one test cannot read what another saved. */
  const cache = (): void => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-cli-")));
    trees.push(root);
    vi.stubEnv("XDG_CACHE_HOME", root);
  };

  /** A source that answers from memory and records the URLs it was asked for. */
  const fakeSource = (kind: ScanSource["kind"], scan: AgentScan): ScanSource & { asked: string[] } => {
    const asked: string[] = [];
    return {
      kind,
      asked,
      scan: async (url) => {
        asked.push(url);
        return scan;
      },
      fetchBytes: async () => Buffer.alloc(0),
    };
  };

  const fresh = (source: AgentScan["source"]): AgentScan =>
    testScan({ scanId: `cached-${source}`, source, scannedAt: new Date().toISOString() });

  it("reuses a cached scan of the same source", async () => {
    cache();
    await saveScan(fresh("local"));
    const source = fakeSource("local", fresh("local"));

    expect(await scanPage("https://stripe.com/", source, {})).toMatchObject({ reused: true, scan: { scanId: "cached-local" } });
    expect(source.asked).toEqual([]);
  });

  /**
   * Regression: the cache was read before the source was looked at, so `--remote` could answer from a scan that ran on
   * this machine and never contact the hosted app. `--remote` is a claim about where the answer came from.
   */
  it("never answers a remote run from a local scan, and never the other way round", async () => {
    cache();
    await saveScan(fresh("local"));
    const remote = fakeSource("remote", testScan({ scanId: "from-remote", source: "remote", scannedAt: new Date().toISOString() }));

    const first = await scanPage("https://stripe.com/", remote, {});

    expect(first).toMatchObject({ reused: false, scan: { scanId: "from-remote", source: "remote" } });
    expect(remote.asked).toEqual(["https://stripe.com/"]);

    // The remote answer is cached in its turn, for the remote source only.
    const local = fakeSource("local", fresh("local"));
    expect(await scanPage("https://stripe.com/", remote, {})).toMatchObject({ reused: true, scan: { scanId: "from-remote" } });
    expect(await scanPage("https://stripe.com/", local, {})).toMatchObject({ reused: true, scan: { scanId: "cached-local" } });
    expect(local.asked).toEqual([]);
  });

  it("scans again when --refresh is given, whatever is cached", async () => {
    cache();
    await saveScan(fresh("local"));
    const source = fakeSource("local", testScan({ scanId: "rescanned", scannedAt: new Date().toISOString() }));

    expect(await scanPage("https://stripe.com/", source, { refresh: true })).toMatchObject({ reused: false, scan: { scanId: "rescanned" } });
    expect(source.asked).toEqual(["https://stripe.com/"]);
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
