import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadScan, saveScan } from "@/agent/cache";
import { createAgentMcpServer } from "@/agent/mcp";
import { createScanSource } from "@/agent/source";
import type { AgentScan, DownloadResult, ScanSummary } from "@/agent/types";
import { GET as zipRoute } from "@/app/api/v1/assets.zip/route";
import { POST as scanRoute } from "@/app/api/v1/scan/route";
import { setAgentScanSourceForTests } from "@/app/api/v1/source";
import type { ZipManifest } from "@/app/api/v1/zip";
import { readZip, type ZipEntry } from "../../../e2e/support/zip";
import type { FixtureServer } from "../../fixtures/serve";
import { serveAssetsFixture } from "../assets/harness";

/**
 * The three ways in agree (plan Task G6.2). One scan of the fixture site goes into the cache, and the CLI, the MCP
 * server and the hosted routes each answer from it: the same summary, the same selection, the same file names and the
 * same bytes. They are three adapters over one core, and this is the test that says so, so a change to one of them that
 * moves the selection or the summary fails here rather than in a user's scrap folder.
 *
 * Feeding all three the one scan is deliberate: what is under test is the adapters, not whether two runs of Chromium
 * against the same page collect the same assets.
 */

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "../../..");
const CLI = path.join(ROOT, "dist/cli.mjs");
const TOKEN = "integration-agent-token-long-enough";

let server: FixtureServer;
let home: string;
let project: string;
let scan: AgentScan;
let client: Client;
const previousEnv = new Map<string, string | undefined>();

const setEnv = (name: string, value: string): void => {
  if (!previousEnv.has(name)) previousEnv.set(name, process.env[name]);
  process.env[name] = value;
};

/** The built CLI, in the project directory, reading the same cache as the in-process paths. */
const cli = async (args: string[]): Promise<{ stdout: string; stderr: string }> =>
  execFileAsync(process.execPath, [CLI, ...args], { cwd: project, env: { ...process.env }, maxBuffer: 32 * 1024 * 1024 });

const mcp = (name: string, args: Record<string, unknown>): Promise<CallToolResult> =>
  client.callTool({ name, arguments: args }) as Promise<CallToolResult>;

const fromMcp = <T>(result: CallToolResult): T => {
  expect(result.isError ?? false, JSON.stringify(result.content)).toBe(false);
  return JSON.parse((result.content as { text: string }[])[0].text) as T;
};

const zipEntries = async (query: string): Promise<{ entries: ZipEntry[]; manifest: ZipManifest }> => {
  const url = `https://assets.example.com/api/v1/assets.zip?url=${encodeURIComponent(`${server.origin}/`)}${query}`;
  const response = await zipRoute(new Request(url, { headers: { authorization: `Bearer ${TOKEN}` } }));
  expect(response.status).toBe(200);
  const entries = await readZip(await response.arrayBuffer());
  const manifest = JSON.parse(new TextDecoder().decode(entries.find((entry) => entry.name === "manifest.json")!.data)) as ZipManifest;
  return { entries, manifest };
};

/** The path inside the destination, with forward slashes, which is the one name all three paths can be compared on. */
const relative = (result: DownloadResult): string[] => result.files.map((file) => path.relative(result.dir, file.path).split(path.sep).join("/"));

/**
 * What the MCP `download_assets` tool answers: the same download, reported as paths relative to `dir` with the CDN URLs
 * left in `manifest.json`, because a tool answer has a context budget that a CLI stdout does not (spec 2).
 */
interface McpDownload {
  dir: string;
  manifest: string;
  count: number;
  totalBytes: number;
  files: { id: string; file: string; kind: string; role: string; bytes: number }[];
  dropped: Record<string, number>;
  failed: { id: string; name: string; reason: string }[];
}

beforeAll(async () => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-parity-")));
  project = path.join(home, "project");
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, "package.json"), "{}");
  setEnv("XDG_CACHE_HOME", path.join(home, "cache"));
  setEnv("AGENT_TOKENS", TOKEN);
  // The cache only answers the build that wrote it, and this test is two builds: the sources vitest loads and the
  // bundle the subprocess runs. Naming one identity is what lets them share the one scan, which is the point here:
  // what is under test is the three adapters, not the cache.
  setEnv("ASSETS_SCRAPER_BUILD_ID", "parity");
  server = await serveAssetsFixture();
  await execFileAsync(process.execPath, [path.join(ROOT, "scripts/build-agent.mjs")], { cwd: ROOT });

  // One scan, cached, then read back: every path works from the same bytes, the JSON round trip included.
  const source = createScanSource();
  const fresh = await source.scan(`${server.origin}/`);
  await saveScan(fresh);
  const cached = await loadScan(fresh.scanId);
  if (!cached) throw new Error("the scan did not reach the cache");
  scan = cached;

  // The hosted routes scan through this, so they answer from the same scan instead of driving Chromium again. The bytes
  // still come from the real local source, through safeFetch, as they do in production.
  setAgentScanSourceForTests({
    kind: "local",
    scan: async () => scan,
    fetchBytes: (target, options) => source.fetchBytes(target, options),
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "parity", version: "0" });
  await Promise.all([client.connect(clientTransport), createAgentMcpServer({ cwd: project }).connect(serverTransport)]);
}, 240_000);

afterAll(async () => {
  await client?.close();
  await server?.close();
  setAgentScanSourceForTests(null);
  for (const [name, value] of previousEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

describe("the summary the three paths report", () => {
  it("is the same document, whichever way in an agent uses", async () => {
    const fromCli = JSON.parse((await cli(["scan", `${server.origin}/`, "--json"])).stdout) as ScanSummary;
    const fromMcpServer = fromMcp<ScanSummary>(await mcp("scan_page", { url: `${server.origin}/` }));
    const response = await scanRoute(
      new Request("https://assets.example.com/api/v1/scan", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url: `${server.origin}/` }),
      }),
    );
    const body = (await response.json()) as { view: string; scanId: string; summary: ScanSummary };

    expect(fromCli.scanId).toBe(scan.scanId);
    expect(fromMcpServer).toEqual(fromCli);
    expect(body.summary).toEqual(fromCli);
    expect(body.scanId).toBe(fromCli.scanId);
    expect(Buffer.byteLength(JSON.stringify(fromCli))).toBeLessThan(4_096);
  }, 120_000);
});

describe("the selection the three paths write", () => {
  /** The deck profile, which is what every one of them does when an agent asks for nothing in particular. */
  it("keeps the same assets, under the same names, with the same bytes", async () => {
    const out = path.join(home, "cli-deck");
    const fromCli = JSON.parse((await cli(["get", `${server.origin}/`, "--out", out, "--json"])).stdout) as DownloadResult;
    const fromMcpServer = fromMcp<McpDownload>(await mcp("download_assets", { scanId: scan.scanId }));
    const { entries, manifest } = await zipEntries("");

    expect(fromCli.files.length).toBeGreaterThan(0);
    const ids = fromCli.files.map((file) => file.id);
    expect(fromMcpServer.files.map((file) => file.id)).toEqual(ids);
    expect(manifest.files.map((file) => file.id)).toEqual(ids);

    const names = relative(fromCli);
    expect(fromMcpServer.files.map((file) => file.file)).toEqual(names);
    expect(manifest.files.map((file) => file.file)).toEqual(names);

    const bytes = fromCli.files.map((file) => file.bytes);
    expect(fromMcpServer.files.map((file) => file.bytes)).toEqual(bytes);
    expect(manifest.files.map((file) => file.bytes)).toEqual(bytes);
    expect(fromMcpServer.totalBytes).toBe(fromCli.totalBytes);
    expect(manifest.totalBytes).toBe(fromCli.totalBytes);

    // The same file names hold the same bytes on both disks and in the archive.
    for (const [index, name] of names.entries()) {
      const written = fs.readFileSync(fromCli.files[index].path);
      expect(fs.readFileSync(path.join(fromMcpServer.dir, name)).equals(written), name).toBe(true);
      expect(Buffer.from(entries.find((entry) => entry.name === name)!.data).equals(written), name).toBe(true);
    }

    expect(fromMcpServer.dropped).toEqual(fromCli.dropped);
    expect(manifest.dropped).toEqual(fromCli.dropped);
    expect(fromMcpServer.failed).toEqual(fromCli.failed);
    expect(manifest.failed).toEqual(fromCli.failed);
    expect(manifest.truncated).toBe(false);

    // The archive's manifest is the document a local download writes, field for field: llms.txt tells an agent to unzip
    // this into scrap/<host>, so a reader of one has to be a reader of the other (review issue 18).
    const local = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8")) as Record<string, unknown>;
    const shared = (document: Record<string, unknown>) => Object.keys(document).filter((key) => key !== "downloadedAt").sort();
    expect(shared(local).every((key) => key in manifest)).toBe(true);
    expect(manifest.manifestVersion).toBe(1);
    expect(manifest.profile).toBe("deck");
    expect(new Date(manifest.downloadedAt).toISOString()).toBe(manifest.downloadedAt);
    expect(manifest.files[0].keptBecause).toBe((local.files as { keptBecause: string }[])[0].keptBecause);

    // The MCP tool resolves its own destination: the scrap folder of the project it was started in (spec 2).
    expect(fromMcpServer.dir).toBe(path.join(project, "scrap", "127.0.0.1"));
    expect(fromCli.dir).toBe(out);
  }, 120_000);

  it("reads the same filters the same way", async () => {
    const out = path.join(home, "cli-svg");
    const fromCli = JSON.parse((await cli(["get", `${server.origin}/`, "--out", out, "--kind", "svg", "--max", "3", "--json"])).stdout) as DownloadResult;
    // The singular `kind` the CLI and list_assets take; the plural is an alias for several at once (review issue 6).
    const fromMcpServer = fromMcp<McpDownload>(
      await mcp("download_assets", { scanId: scan.scanId, kind: "svg", max: 3, dest: path.join(project, "scrap", "svg-only") }),
    );
    const { manifest } = await zipEntries("&kinds=svg&max=3");

    expect(fromCli.files.length).toBeGreaterThan(0);
    expect(fromCli.files.length).toBeLessThanOrEqual(3);
    const ids = fromCli.files.map((file) => file.id);
    expect(fromMcpServer.files.map((file) => file.id)).toEqual(ids);
    expect(manifest.files.map((file) => file.id)).toEqual(ids);
    expect(fromMcpServer.files.map((file) => file.file)).toEqual(relative(fromCli));
    expect(manifest.files.map((file) => file.file)).toEqual(relative(fromCli));
    for (const name of relative(fromCli)) expect(name.startsWith("svg/")).toBe(true);
    expect(fromMcpServer.dropped).toEqual(fromCli.dropped);
    expect(manifest.dropped).toEqual(fromCli.dropped);
  }, 120_000);

  /**
   * The byte budget, which is the rule with three chances to be implemented twice: the CLI writes to disk, the MCP tool
   * writes through the same core, and the hosted archive fetches its own bytes. One `selectAssets` decides for all
   * three, and this is the test that says so.
   */
  it("spends the same byte budget on the same files", async () => {
    const whole = JSON.parse((await cli(["get", `${server.origin}/`, "--out", path.join(home, "cli-whole"), "--max-bytes", "0", "--json"])).stdout) as DownloadResult;
    expect(whole.files.length).toBeGreaterThan(2);
    const budget = whole.files[0].bytes + whole.files[1].bytes;

    const out = path.join(home, "cli-budget");
    const fromCli = JSON.parse(
      (await cli(["get", `${server.origin}/`, "--out", out, "--max-bytes", String(budget), "--json"])).stdout,
    ) as DownloadResult;
    const fromMcpServer = fromMcp<McpDownload>(
      await mcp("download_assets", { scanId: scan.scanId, maxTotalBytes: budget, dest: path.join(project, "scrap", "budget") }),
    );
    const { manifest } = await zipEntries(`&maxBytes=${budget}`);

    expect(fromCli.files.length).toBeGreaterThan(0);
    expect(fromCli.files.length).toBeLessThan(whole.files.length);
    expect(fromCli.totalBytes).toBeLessThanOrEqual(budget);
    expect(fromCli.dropped["over-budget"]).toBeGreaterThan(0);

    const ids = fromCli.files.map((file) => file.id);
    expect(fromMcpServer.files.map((file) => file.id)).toEqual(ids);
    expect(manifest.files.map((file) => file.id)).toEqual(ids);
    expect(fromMcpServer.totalBytes).toBe(fromCli.totalBytes);
    expect(manifest.totalBytes).toBe(fromCli.totalBytes);
    expect(fromMcpServer.dropped).toEqual(fromCli.dropped);
    expect(manifest.dropped).toEqual(fromCli.dropped);
    expect(manifest.budget).toEqual({ maxTotalBytes: budget, maxFileBytes: 8 * 1024 * 1024, keptBytes: fromCli.totalBytes });
    expect(JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8")).budget).toEqual(manifest.budget);
  }, 120_000);
});

describe("the fonts of a scan", () => {
  it("install and uninstall the same way through the CLI and the MCP server", async () => {
    const fontDir = path.join(home, "fonts");
    setEnv("ASSETS_SCRAPER_FONT_DIR", fontDir);
    setEnv("ASSETS_SCRAPER_STATE_DIR", path.join(home, "state"));

    const installed = JSON.parse((await cli(["fonts", "install", `${server.origin}/`, "--families", "Inter", "--json"])).stdout) as {
      fontDir: string;
      installed: { family: string; files: string[]; license: { kind: string } }[];
    };
    expect(installed.fontDir).toBe(fontDir);
    expect(installed.installed.map((font) => font.family)).toEqual(["Inter"]);
    expect(fs.existsSync(installed.installed[0].files[0])).toBe(true);

    // The MCP server reads the same manifest the CLI wrote, so an agent sees what the command installed.
    const listed = fromMcp<{ fonts: { family: string; files: string[] }[] }>(await mcp("list_installed_fonts", {}));
    expect(listed.fonts.map((font) => font.family)).toEqual(["Inter"]);
    expect(listed.fonts[0].files).toEqual(installed.installed[0].files);
    const printed = (await cli(["fonts", "list"])).stdout;
    expect(printed).toContain("Inter: open licence");
    expect(printed).toContain(installed.installed[0].files[0]);

    const removed = JSON.parse((await cli(["fonts", "uninstall", "Inter", "--json"])).stdout) as { removed: { family: string }[]; missing: string[] };
    expect(removed.removed.map((font) => font.family)).toEqual(["Inter"]);
    expect(removed.missing).toEqual([]);
    expect(fs.existsSync(installed.installed[0].files[0])).toBe(false);
    expect(fromMcp<{ fonts: unknown[] }>(await mcp("list_installed_fonts", {})).fonts).toEqual([]);
  }, 120_000);
});
