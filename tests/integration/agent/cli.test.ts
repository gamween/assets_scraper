import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DownloadManifest } from "@/agent/download";
import type { AgentScan, DownloadResult, ScanSummary } from "@/agent/types";
import type { FixtureServer } from "../../fixtures/serve";
import { serveAssetsFixture } from "../assets/harness";

/**
 * The `assets-scraper` command as an agent runs it (plan Task G2.3): the built bundle, driven against the fixture site
 * in a child process, reading only its stdout, stderr and exit code.
 *
 * One real scan pays for the whole file: `scan` caches it and the `get` runs reuse it, which is the loop an agent uses
 * and the cheapest way to run several downloads against one page.
 */

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "../../..");
const CLI = path.join(ROOT, "dist/cli.mjs");

let server: FixtureServer;
let work: string;
let cache: string;
let scanId: string;

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the built CLI in a directory of its own, with the temporary cache and the fixture host allowed. */
const run = async (args: string[], env: Record<string, string | undefined> = {}): Promise<Run> => {
  const environment: NodeJS.ProcessEnv = { ...process.env, XDG_CACHE_HOME: cache };
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete environment[name];
    else environment[name] = value;
  }
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], { cwd: work, env: environment, maxBuffer: 32 * 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
};

const cachedScan = (): AgentScan => {
  const dir = path.join(cache, "assets-scraper");
  const file = fs.readdirSync(dir).find((name) => name.endsWith(".json"));
  if (!file) throw new Error("expected a cached scan");
  return JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as AgentScan;
};

beforeAll(async () => {
  work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-cli-")));
  cache = path.join(work, "cache");
  server = await serveAssetsFixture();
  await execFileAsync(process.execPath, [path.join(ROOT, "scripts/build-agent.mjs")], { cwd: ROOT });
}, 120_000);

afterAll(async () => {
  await server?.close();
  fs.rmSync(work, { recursive: true, force: true });
});

describe("assets-scraper scan", () => {
  it("prints the summary as JSON and caches the scan", async () => {
    const result = await run(["scan", `${server.origin}/`, "--json"]);

    expect(result.code).toBe(0);
    const summary = JSON.parse(result.stdout) as ScanSummary;
    expect(summary.page.host).toBe("127.0.0.1");
    expect(summary.counts.assets).toBeGreaterThan(0);
    expect(summary.fonts.map((font) => font.family)).toContain("Inter");
    expect(Buffer.byteLength(result.stdout)).toBeLessThan(4_096);
    scanId = summary.scanId;
    expect(cachedScan().scanId).toBe(scanId);
  }, 150_000);

  it("prints a readable report without JSON", async () => {
    const result = await run(["scan", `${server.origin}/`]);

    expect(result.code).toBe(0);
    expect(result.stdout.trimStart().startsWith("{")).toBe(false);
    expect(result.stdout).toContain("127.0.0.1");
    expect(result.stdout).toContain("assets");
    expect(result.stdout).toContain("palette");
    expect(result.stdout).toContain("Inter");
    expect(result.stdout).toContain(scanId);
    expect(result.stdout).not.toMatch(/[—–]/);
  });
});

describe("assets-scraper get", () => {
  it("writes the selection and prints the result as JSON", async () => {
    const out = path.join(work, "out-json");

    const result = await run(["get", `${server.origin}/`, "--out", out, "--json"]);

    expect(result.code).toBe(0);
    const download = JSON.parse(result.stdout) as DownloadResult & { scanId: string };
    expect(download.scanId).toBe(scanId);
    expect(download.dir).toBe(out);
    expect(download.files.length).toBeGreaterThan(0);
    for (const file of download.files) {
      expect(path.isAbsolute(file.path)).toBe(true);
      expect(fs.statSync(file.path).size).toBe(file.bytes);
    }
    const manifest = JSON.parse(fs.readFileSync(download.manifestPath, "utf8")) as DownloadManifest;
    expect(manifest.files).toHaveLength(download.files.length);
    expect(manifest.page.host).toBe("127.0.0.1");
  }, 60_000);

  it("keeps every SVG with the all profile", async () => {
    const out = path.join(work, "out-svg");
    const scan = cachedScan();
    const available = scan.assets.filter((asset) => asset.kind === "svg" && (asset.inline ?? asset.display?.url ?? asset.original?.url));

    const result = await run(["get", `${server.origin}/`, "--out", out, "--profile", "all", "--kind", "svg", "--json"]);

    expect(result.code).toBe(0);
    const download = JSON.parse(result.stdout) as DownloadResult;
    const lost = (download.dropped.duplicate ?? 0) + (download.dropped.cap ?? 0) + download.failed.length;
    expect(download.files).toHaveLength(available.length - lost);
    expect(download.dropped.small).toBeUndefined();
    expect(download.dropped.icon).toBeUndefined();
    expect(fs.existsSync(path.join(out, "images"))).toBe(false);
  }, 60_000);

  it("prints absolute paths and one line of drop reasons without JSON", async () => {
    const out = path.join(work, "out-human");

    const result = await run(["get", `${server.origin}/`, "--out", out]);

    expect(result.code).toBe(0);
    expect(result.stdout.trimStart().startsWith("{")).toBe(false);
    expect(result.stdout).toContain(path.join(out, "svg"));
    expect(result.stdout).toContain(path.join(out, "manifest.json"));
    expect(result.stdout).toMatch(/dropped \d+:/);
    expect(result.stdout).not.toMatch(/[—–]/);
  }, 60_000);
});

describe("assets-scraper failures", () => {
  it("exits 1 with one line for a URL it cannot scan", async () => {
    const result = await run(["scan", "not a url"]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
    expect(result.stderr).toMatch(/invalid-url/);
  }, 30_000);

  it("exits 1 explaining what a remote scan is missing", async () => {
    const result = await run(["scan", "stripe.com", "--remote"], { ASSETS_SCRAPER_TOKEN: undefined, ASSETS_SCRAPER_REMOTE: undefined });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("ASSETS_SCRAPER_TOKEN");
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
  }, 30_000);

  it("prints the usage and exits 1 for an unknown command", async () => {
    const unknown = await run(["frobnicate"]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("assets-scraper");

    const help = await run(["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("assets-scraper scan");
    expect(help.stdout).toContain("assets-scraper get");
  }, 30_000);
});
