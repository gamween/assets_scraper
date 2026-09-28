import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAgentMcpServer, MCP_TOOL_NAMES } from "@/agent/mcp";
import { selectAssets } from "@/agent/select";
import { createScanSource } from "@/agent/source";
import type { AgentScan, DownloadResult, ScanSummary } from "@/agent/types";
import type { FixtureServer } from "../../fixtures/serve";
import { serveAssetsFixture } from "../assets/harness";

/**
 * The MCP server against the fixture site through the SDK's in-memory transport (plan Task G3.2): the tools an agent
 * sees, the scan cache behind them, and the answers they give, all as JSON text.
 */

let server: FixtureServer;
let client: Client;
/** A temporary tree: the cache, the font directory, the state file, and a project the destination rule resolves from. */
let home: string;
let project: string;
let fontDir: string;
const previousEnv = new Map<string, string | undefined>();
/** What the stand-in downloader was asked for, so the test can check what the tool passed it. */
let downloads: { dir: string; ids: string[] }[];

const setEnv = (name: string, value: string): void => {
  if (!previousEnv.has(name)) previousEnv.set(name, process.env[name]);
  process.env[name] = value;
};

/** What the `download_assets` tool answers: paths relative to `dir`, counts, and where the manifest is. */
interface McpDownload {
  dir: string;
  manifest: string;
  count: number;
  totalBytes: number;
  files: { id: string; file: string; kind: string; role: string; bytes: number }[];
  dropped: Record<string, number>;
}

/**
 * Stands in for `downloadAssets`, which track G2 owns (`src/agent/download.ts`): it runs the same selection, writes one
 * file per kept asset into the directory the tool resolved, and reports what it dropped. Enough to check the tool's
 * plumbing, not a substitute for that track's own tests.
 */
async function fakeDownload(
  scan: AgentScan,
  options: { dir: string; selection?: Parameters<typeof selectAssets>[1] },
): Promise<DownloadResult> {
  const source = createScanSource();
  const selection = await selectAssets(scan.assets, options.selection ?? {});
  downloads.push({ dir: options.dir, ids: selection.keep.map((asset) => asset.id) });
  const files: DownloadResult["files"] = [];
  let totalBytes = 0;
  for (const asset of selection.keep) {
    const target = path.join(options.dir, asset.kind === "svg" ? "svg" : "images", asset.filename);
    const bytes =
      asset.inline && "text" in asset.inline ?
        Buffer.from(asset.inline.text, "utf8")
      : await source.fetchBytes(asset.display ?? asset.original ?? { url: "", proxy: "", format: asset.format });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
    totalBytes += bytes.length;
    files.push({ id: asset.id, name: asset.filename, path: target, bytes: bytes.length, kind: asset.kind, role: asset.role, url: asset.display?.url ?? "" });
  }
  const manifestPath = path.join(options.dir, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify({ files }));
  return { dir: options.dir, files, totalBytes, dropped: selection.dropped, budget: selection.budget, failed: [], manifestPath };
}

beforeAll(async () => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-mcp-")));
  project = path.join(home, "project");
  fontDir = path.join(home, "Fonts");
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, "package.json"), "{}");
  setEnv("XDG_CACHE_HOME", path.join(home, "cache"));
  setEnv("ASSETS_SCRAPER_FONT_DIR", fontDir);
  setEnv("ASSETS_SCRAPER_STATE_DIR", path.join(home, "state"));
  server = await serveAssetsFixture();

  downloads = [];
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "0" });
  await Promise.all([
    client.connect(clientTransport),
    createAgentMcpServer({ cwd: project, downloadAssets: fakeDownload }).connect(serverTransport),
  ]);
}, 150_000);

afterAll(async () => {
  await client?.close();
  await server?.close();
  for (const [name, value] of previousEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

const call = (name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> =>
  client.callTool({ name, arguments: args }) as Promise<CallToolResult>;

/** The one text block every tool answers with. Fails the test when a tool returns anything else. */
function text(result: CallToolResult): string {
  expect(result.content).toHaveLength(1);
  expect(result.content[0].type).toBe("text");
  return (result.content[0] as { text: string }).text;
}

const json = <T>(result: CallToolResult): T => {
  expect(result.isError ?? false).toBe(false);
  return JSON.parse(text(result)) as T;
};

/** Filled by the first test, then used by every tool that takes a scan id. */
let scanId: string;

describe("the assets-scraper MCP server", () => {
  it("lists the eight tools with their schemas", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([...MCP_TOOL_NAMES].sort());
    expect(MCP_TOOL_NAMES).toHaveLength(8);
    for (const tool of tools) {
      expect(tool.description, tool.name).toBeTruthy();
      expect(tool.inputSchema.type).toBe("object");
    }
    const scanTool = tools.find((tool) => tool.name === "scan_page");
    expect(Object.keys(scanTool?.inputSchema.properties ?? {}).sort()).toEqual(["refresh", "url"]);
    expect(scanTool?.inputSchema.required).toEqual(["url"]);
  });

  it("scans the page and answers with a summary under 4 KB", async () => {
    const result = await call("scan_page", { url: `${server.origin}/` });
    const summary = json<ScanSummary>(result);
    scanId = summary.scanId;

    expect(Buffer.byteLength(text(result))).toBeLessThan(4_096);
    expect(summary.page.host).toBe("127.0.0.1");
    expect(summary.counts.assets).toBeGreaterThan(0);
    expect(summary.logos.length).toBeGreaterThan(0);
    expect(summary.palette.every((swatch) => /^#[0-9a-f]{6}$/.test(swatch.hex))).toBe(true);
    expect(summary.fonts.map((font) => font.family)).toContain("Inter");
  });

  it("answers the same scan from the cache, and rescans on refresh", async () => {
    expect(json<ScanSummary>(await call("scan_page", { url: `${server.origin}/` })).scanId).toBe(scanId);
    const fresh = json<ScanSummary>(await call("scan_page", { url: `${server.origin}/`, refresh: true }));
    expect(fresh.scanId).not.toBe(scanId);
  }, 150_000);

  it("lists assets with filters and pagination", async () => {
    const all = json<{ total: number; assets: { id: string; kind: string }[] }>(await call("list_assets", { scanId }));
    expect(all.assets.length).toBeLessThanOrEqual(40);
    expect(all.total).toBeGreaterThanOrEqual(all.assets.length);

    const svg = json<{ total: number; assets: { kind: string }[] }>(await call("list_assets", { scanId, kind: "svg" }));
    expect(svg.assets.every((asset) => asset.kind === "svg")).toBe(true);
    expect(svg.total).toBeLessThan(all.total);

    const page = json<{ assets: { id: string }[]; offset: number }>(await call("list_assets", { scanId, limit: 2, offset: 1 }));
    expect(page.assets).toHaveLength(2);
    expect(page.offset).toBe(1);
    expect(page.assets[0].id).toBe(all.assets[1].id);

    const logos = json<{ assets: { role: string }[] }>(await call("list_assets", { scanId, role: "site-logo" }));
    expect(logos.assets.every((asset) => asset.role === "site-logo")).toBe(true);
  });

  it("reads the markup of an SVG asset", async () => {
    const logos = json<{ assets: { id: string; kind: string }[] }>(await call("list_assets", { scanId, kind: "svg" }));
    const markup = json<{ markup: string }>(await call("read_svg", { scanId, id: logos.assets[0].id })).markup;
    expect(markup.trimStart().startsWith("<svg")).toBe(true);
  });

  it("returns the palette as hexes with roles", async () => {
    const palette = json<{ palette: { hex: string; role?: string }[] }>(await call("get_palette", { scanId }));
    expect(palette.palette.length).toBeGreaterThan(0);
    expect(palette.palette.every((swatch) => /^#[0-9a-f]{6}$/.test(swatch.hex))).toBe(true);
  });

  it("downloads a selection into the project scrap directory", async () => {
    const result = json<McpDownload>(await call("download_assets", { scanId, role: "site-logo" }));

    expect(result.dir).toBe(path.join(project, "scrap", "127.0.0.1"));
    expect(result.files.length).toBeGreaterThan(0);
    // Paths relative to `dir`, which is given once: the tool answer has a context budget (spec 2, context cost).
    for (const file of result.files) expect(fs.existsSync(path.join(result.dir, file.file))).toBe(true);
    expect(fs.existsSync(result.manifest)).toBe(true);
    expect(downloads.at(-1)?.ids).toEqual(result.files.map((file) => file.id));

    const filtered = json<McpDownload>(await call("download_assets", { scanId, max: 1, profile: "all" }));
    expect(filtered.files).toHaveLength(1);
    expect(filtered.dropped.cap).toBeGreaterThan(0);
  });

  it("refuses a destination outside the project scrap directory", async () => {
    const result = await call("download_assets", { scanId, dest: path.join(project, "src") });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("scrap");
    expect(fs.existsSync(path.join(project, "src"))).toBe(false);
  });

  it("installs and uninstalls the page fonts", async () => {
    const report = json<{ installed: { family: string; files: string[]; license: { kind: string } }[]; skipped: unknown[] }>(
      await call("install_fonts", { scanId, families: ["Inter"] }),
    );
    expect(report.installed).toHaveLength(1);
    expect(report.installed[0].family).toBe("Inter");
    expect(report.installed[0].files[0]).toBe(path.join(fontDir, "Inter-Regular.ttf"));
    expect(fs.existsSync(report.installed[0].files[0])).toBe(true);

    const listed = json<{ fonts: { family: string }[] }>(await call("list_installed_fonts"));
    expect(listed.fonts.map((font) => font.family)).toEqual(["Inter"]);

    const removed = json<{ removed: { family: string }[]; missing: string[] }>(await call("uninstall_fonts", { families: ["Inter", "Nope"] }));
    expect(removed.removed.map((font) => font.family)).toEqual(["Inter"]);
    expect(removed.missing).toEqual(["Nope"]);
    expect(fs.existsSync(path.join(fontDir, "Inter-Regular.ttf"))).toBe(false);
  });

  it("tells the agent to scan again when the scan id is unknown", async () => {
    for (const name of ["list_assets", "download_assets", "get_palette", "install_fonts"]) {
      const result = await call(name, { scanId: "gone-1-000000" });
      expect(result.isError, name).toBe(true);
      expect(text(result), name).toContain("scan_page");
    }
  });
});
