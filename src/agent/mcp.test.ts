import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAgentMcpServer, MCP_TOOL_NAMES, missingRuntimeDependency } from "./mcp";
import { testAsset, testScan } from "./testing";
import type { AgentScan, ScanSource } from "./types";

/**
 * The MCP server against a scan source that answers from memory, so the tool behavior an agent depends on is pinned
 * without a browser. The whole server against the fixture site is in tests/integration/agent/mcp.test.ts.
 */

/** A page of four assets: a vector with no intrinsic size, a small raster, a big one, and one the scan could not measure. */
const scan: AgentScan = testScan({
  assets: [
    testAsset({ id: "vector-logo", format: "svg", role: "site-logo", score: 90, order: 0 }),
    testAsset({ id: "thumbnail", role: "image", width: 200, height: 120, score: 80, order: 1 }),
    testAsset({ id: "hero", role: "image", width: 1600, height: 900, score: 70, order: 2 }),
    testAsset({ id: "unmeasured", role: "image", score: 60, order: 3 }),
  ],
});

const source: ScanSource = {
  kind: "local",
  scan: async () => scan,
  fetchBytes: async () => Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>"),
};

let home: string;
let scanId: string;
const previousEnv = new Map<string, string | undefined>();

/** A client on one end of an in-memory pair, the server on the other, with the downloader the test wants. */
async function connect(options: Parameters<typeof createAgentMcpServer>[0] = {}): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([
    client.connect(clientTransport),
    createAgentMcpServer({ source, cwd: home, ...options }).connect(serverTransport),
  ]);
  return client;
}

let client: Client;

beforeAll(async () => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-mcp-unit-")));
  // A project marker, so the destination rule resolves to this tree rather than to the real ~/Downloads.
  fs.writeFileSync(path.join(home, "package.json"), "{}");
  previousEnv.set("XDG_CACHE_HOME", process.env.XDG_CACHE_HOME);
  process.env.XDG_CACHE_HOME = path.join(home, "cache");
  client = await connect();
  const summary = JSON.parse(text(await call(client, "scan_page", { url: "https://stripe.com" }))) as { scanId: string };
  scanId = summary.scanId;
});

afterAll(async () => {
  await client?.close();
  for (const [name, value] of previousEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

const call = (on: Client, name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> =>
  on.callTool({ name, arguments: args }) as Promise<CallToolResult>;

function text(result: CallToolResult): string {
  const [block] = result.content as { type: string; text: string }[];
  expect(block.type).toBe("text");
  return block.text;
}

describe("MCP_TOOL_NAMES", () => {
  it("names the eight tools of the spec, once each", () => {
    expect(MCP_TOOL_NAMES).toHaveLength(8);
    expect(new Set(MCP_TOOL_NAMES).size).toBe(8);
  });
});

describe("list_assets", () => {
  it("gates rasters on minLongSide and keeps vectors and assets with no known size", async () => {
    const listed = JSON.parse(text(await call(client, "list_assets", { scanId, minLongSide: 600 }))) as {
      assets: { id: string }[];
    };

    expect(listed.assets.map((asset) => asset.id)).toEqual(["vector-logo", "hero", "unmeasured"]);
  });

  it("filters on kind, role and name as well", async () => {
    const svgOnly = JSON.parse(text(await call(client, "list_assets", { scanId, kind: "svg" }))) as { total: number };
    const named = JSON.parse(text(await call(client, "list_assets", { scanId, nameContains: "hero" }))) as {
      assets: { id: string }[];
    };

    expect(svgOnly.total).toBe(1);
    expect(named.assets.map((asset) => asset.id)).toEqual(["hero"]);
  });
});

describe("download_assets", () => {
  /**
   * The downloader `src/agent/download.ts` provides is wired in at plan Task G6.1. Until then the default port says so in
   * one sentence rather than writing nothing quietly, and this is the test that has to change when it is wired: replace it
   * with one asserting that a server created with no `downloadAssets` writes files through the real downloader.
   */
  it("says the downloader is not wired in this build, in words an agent can report", async () => {
    const unwired = await connect();

    const result = await call(unwired, "download_assets", { scanId });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("src/agent/download.ts");
    await unwired.close();
  });

  it("passes the resolved destination and the filters to the downloader it was given", async () => {
    const seen: { dir: string; ids?: string[] }[] = [];
    const wired = await connect({
      downloadAssets: async (_scan, options) => {
        seen.push({ dir: options.dir, ...(options.selection?.ids === undefined ? {} : { ids: options.selection.ids }) });
        return { dir: options.dir, files: [], totalBytes: 0, dropped: {}, failed: [], manifestPath: "" };
      },
    });

    await call(wired, "download_assets", { scanId, ids: ["hero"] });

    expect(seen).toEqual([{ dir: path.join(home, "scrap", "stripe.com"), ids: ["hero"] }]);
    await wired.close();
  });
});

describe("missingRuntimeDependency", () => {
  it("is null when every runtime dependency resolves", () => {
    expect(missingRuntimeDependency()).toBeNull();
  });

  it("names the first dependency that does not resolve", () => {
    const missing = missingRuntimeDependency((name) => {
      if (name === "sharp") throw new Error("Cannot find module 'sharp'");
      return name;
    });
    expect(missing).toBe("sharp");
  });
});
