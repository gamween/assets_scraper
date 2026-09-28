import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod";
import { type Asset, AssetKind, AssetRole } from "@/lib/contract";
import { ScanFailure } from "@/server/errors";
import { sniffContentType } from "@/server/security/sniff";
import { findRecentScan, loadScan, saveScan } from "./cache";
import { resolveDestination } from "./dest";
import { downloadAssets } from "./download";
import { listInstalledFonts } from "./font-manifest";
import { installFonts, uninstallFonts } from "./fonts";
import { agentLimits } from "./limits";
import { createScanSource } from "./source";
import { summarize } from "./summary";
import type { AgentScan, DownloadResult, ScanSource, SelectionOptions } from "./types";

/**
 * The MCP server an agent talks to over stdio (spec section 6). Every tool answers with one JSON text block and nothing
 * else: files go to disk, and the only page content that ever crosses the wire is SVG markup on request and the palette
 * hexes, which is what keeps an agent's context from filling with bytes (spec 2, context cost).
 *
 * A scan is done once. `scan_page` caches it (spec 6) and every other tool reads it back by id, so a page is never
 * scanned twice to answer a follow-up, and an id that has aged out says so in words the agent can act on.
 */

export const MCP_TOOL_NAMES = [
  "scan_page",
  "list_assets",
  "download_assets",
  "read_svg",
  "get_palette",
  "install_fonts",
  "list_installed_fonts",
  "uninstall_fonts",
] as const;

/** The version this server reports to a client. Kept here rather than read from package.json, which the bundle has no path to. */
const SERVER_VERSION = "0.1.0";

/** Rows one `list_assets` call returns by default, and the most it will return. */
const DEFAULT_ASSET_ROWS = 40;
const MAX_ASSET_ROWS = 200;
/**
 * The most SVG markup `read_svg` puts in an answer. Past that an agent should download the file instead of reading it:
 * the point of this server is to keep bytes out of the context.
 */
const MAX_SVG_TEXT_BYTES = 256 * 1024;

/**
 * Writes a selection to disk. `src/agent/download.ts` holds the implementation; this is the shape the tool calls it
 * through, so a test can watch what the tool asked for. The destination is resolved here, not there, because it is the
 * agent that supplied it and spec 10 holds an agent-supplied path to the project's scrap directory.
 */
export type DownloadAssetsPort = (
  scan: AgentScan,
  options: { dir: string; source: ScanSource; selection?: SelectionOptions; signal?: AbortSignal },
) => Promise<DownloadResult>;

export interface AgentMcpOptions {
  /** Where scans run. Defaults to the local engine, or the hosted app when `ASSETS_SCRAPER_REMOTE` is set. */
  source?: ScanSource;
  /** The working directory the destination rule resolves from. Defaults to the directory the server was started in. */
  cwd?: string;
  /** Stands in for the real downloader in a test. Defaults to `downloadAssets`. */
  downloadAssets?: DownloadAssetsPort;
}

const ok = (value: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

const fail = (message: string): CallToolResult => ({ isError: true, content: [{ type: "text", text: message }] });

const failureText = (error: unknown): string => {
  if (error instanceof ScanFailure) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
};

/** What every tool that takes a `scanId` says when the scan has aged out of the cache or never existed. */
const UNKNOWN_SCAN = (scanId: string): string =>
  `unknown scanId ${JSON.stringify(scanId)}: it is not in the cache any more. Run scan_page on the URL again.`;

/**
 * The real downloader, behind the port. The destination is already resolved and confined by the tool, so it is passed as
 * an explicit `dest`, which `resolveDestination` takes as it is rather than deriving a second path from the host.
 */
const downloadThroughCore: DownloadAssetsPort = (scan, options) =>
  downloadAssets(scan, options.source, {
    ...(options.selection ?? {}),
    dest: options.dir,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

/** The filters `list_assets` takes, in the words of spec section 4. */
const listFilterShape = {
  kind: AssetKind.optional().describe("only svg, or only image"),
  role: AssetRole.optional().describe("only assets the scan gave this role"),
  minLongSide: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("drop rasters whose longest side is under this many pixels. Vectors, and assets the scan could not measure, are kept"),
  nameContains: z.string().max(200).optional().describe("only assets whose name contains this text"),
};

/**
 * The size gate of spec 4.2: a vector has no size to gate on, and an asset the scan could measure nothing for is kept
 * rather than silently dropped, so an agent listing with `minLongSide` to find usable art does not lose the vector logos
 * it was looking for. `selectAssets` gates a download the same way, and exempts the logo roles on top of this, which a
 * plain listing does not: here the number the agent asked for is what it gets for a raster with a known size.
 */
const passesSizeGate = (asset: Asset, minLongSide: number): boolean => {
  if (asset.kind === "svg") return true;
  const width = asset.width ?? asset.renderedWidth;
  const height = asset.height ?? asset.renderedHeight;
  if (width === undefined && height === undefined) return true;
  return Math.max(width ?? 0, height ?? 0) >= minLongSide;
};

export function createAgentMcpServer(options: AgentMcpOptions = {}): McpServer {
  /**
   * The scan source, opened on the first tool call rather than at startup: a remote with no token refuses to be built,
   * and an agent reads that as a tool error it can act on instead of a server that would not start.
   */
  let opened = options.source;
  const openSource = (): ScanSource => (opened ??= createScanSource());
  const cwd = options.cwd ?? process.cwd();
  const download = options.downloadAssets ?? downloadThroughCore;
  const server = new McpServer({ name: "assets-scraper", version: SERVER_VERSION });

  /** The cached scan, or the answer that tells the agent what to do about it. */
  const withScan = async (scanId: string, run: (scan: AgentScan) => Promise<CallToolResult>): Promise<CallToolResult> => {
    const scan = await loadScan(scanId);
    if (!scan) return fail(UNKNOWN_SCAN(scanId));
    try {
      return await run(scan);
    } catch (error) {
      return fail(failureText(error));
    }
  };

  server.registerTool(
    "scan_page",
    {
      title: "Scan a page",
      description:
        "Scans a page and returns a short summary: the scan id, the counts per kind, the palette, the fonts and the logos. " +
        "Never the whole asset list. Pass the scan id to the other tools. A scan of the same URL inside the hour is reused.",
      inputSchema: {
        url: z.string().min(1).max(2048).describe("the page to scan, with or without a scheme"),
        refresh: z.boolean().optional().describe("scan again instead of reusing a cached scan of the same URL"),
      },
    },
    async ({ url, refresh }) => {
      try {
        const cached = refresh === true ? null : await findRecentScan(url);
        const scan = cached ?? (await openSource().scan(url));
        if (!cached) await saveScan(scan);
        return ok(summarize(scan));
      } catch (error) {
        return fail(failureText(error));
      }
    },
  );

  server.registerTool(
    "list_assets",
    {
      title: "List the assets of a scan",
      description: "Compact rows for the assets of a scan, most relevant first. Filter and page through them rather than asking for everything.",
      inputSchema: {
        scanId: z.string().describe("the id scan_page returned"),
        ...listFilterShape,
        limit: z.number().int().min(1).max(MAX_ASSET_ROWS).optional().describe(`rows to return, ${DEFAULT_ASSET_ROWS} by default`),
        offset: z.number().int().min(0).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ scanId, kind, role, minLongSide, nameContains, limit, offset }) =>
      withScan(scanId, async (scan) => {
        const needle = nameContains?.toLowerCase();
        const matching = scan.assets.filter((asset) => {
          if (kind !== undefined && asset.kind !== kind) return false;
          if (role !== undefined && asset.role !== role) return false;
          if (needle !== undefined && !asset.name.toLowerCase().includes(needle)) return false;
          if (minLongSide !== undefined && !passesSizeGate(asset, minLongSide)) return false;
          return true;
        });
        const from = offset ?? 0;
        const rows = matching
          .slice()
          .sort((a, b) => b.score - a.score || a.order - b.order)
          .slice(from, from + (limit ?? DEFAULT_ASSET_ROWS))
          .map((asset) => ({
            id: asset.id,
            name: asset.name,
            kind: asset.kind,
            role: asset.role,
            ...(asset.width === undefined ? {} : { width: asset.width }),
            ...(asset.height === undefined ? {} : { height: asset.height }),
            ...(asset.bytes === undefined ? {} : { bytes: asset.bytes }),
          }));
        return ok({ scanId, total: matching.length, offset: from, assets: rows });
      }),
  );

  server.registerTool(
    "download_assets",
    {
      title: "Download a selection",
      description:
        "Writes the usable assets of a scan into scrap/<host> inside the current project: duplicates, thumbnails, icons " +
        "and low quality images are dropped and counted by reason. Returns the paths, not the bytes.",
      inputSchema: {
        scanId: z.string().describe("the id scan_page returned"),
        ids: z.array(z.string()).max(agentLimits.maxFiles).optional().describe("exact asset ids, which win over the filters"),
        profile: z.enum(["deck", "all"]).optional().describe("deck (default) keeps what is usable, all keeps everything the filters allow"),
        kinds: z.array(AssetKind).optional(),
        roles: z.array(AssetRole).optional(),
        minLongSide: z.number().int().positive().optional(),
        nameContains: z.string().max(200).optional(),
        max: z.number().int().positive().optional().describe(`files to write, ${agentLimits.maxFiles} by default`),
        dest: z.string().max(1024).optional().describe("a directory inside the project scrap folder. Left out, it is scrap/<host>"),
      },
    },
    async ({ scanId, dest, ...filters }) =>
      withScan(scanId, async (scan) => {
        const destination = resolveDestination({ host: scan.page.host, cwd, restrictToProject: true, ...(dest === undefined ? {} : { dest }) });
        const result = await download(scan, { dir: destination.dir, source: openSource(), selection: filters });
        return ok(result);
      }),
  );

  server.registerTool(
    "read_svg",
    {
      title: "Read an SVG",
      description: "The markup of one SVG asset, as text. Use it to inspect or reuse a vector without writing it to disk.",
      inputSchema: { scanId: z.string(), id: z.string().describe("the asset id, from list_assets or the logos of scan_page") },
      annotations: { readOnlyHint: true },
    },
    async ({ scanId, id }) =>
      withScan(scanId, async (scan) => {
        const asset = scan.assets.find((candidate) => candidate.id === id);
        if (!asset) return fail(`no asset ${JSON.stringify(id)} in this scan. Call list_assets to see what it holds.`);
        if (asset.kind !== "svg") return fail(`asset ${JSON.stringify(id)} is a ${asset.format} image, not an SVG. Use download_assets for it.`);
        // Inline markup first, then inline bytes (an SVG the collector kept base64 encoded), then the network.
        const inline = asset.inline;
        const markup =
          inline && "text" in inline ? inline.text
          : inline && "base64" in inline ? Buffer.from(inline.base64, "base64").toString("utf8")
          : (await openSource().fetchBytes(asset.display ?? asset.original ?? { url: "", proxy: "", format: asset.format })).toString("utf8");
        const bytes = Buffer.from(markup, "utf8");
        if (bytes.byteLength > MAX_SVG_TEXT_BYTES) {
          return fail(`this SVG is ${bytes.byteLength} bytes, too much to read into a context. Use download_assets instead.`);
        }
        // The repo's own detector, not a prefix test: a hand-rolled one accepted every `<!DOCTYPE html>` and every bare
        // comment, so the one guard between a hostile page and this answer never fired for the case it was written for.
        if (sniffContentType(bytes) !== "image/svg+xml") {
          return fail(`the bytes of asset ${JSON.stringify(id)} are not SVG markup`);
        }
        return ok({ id: asset.id, name: asset.name, filename: asset.filename, markup });
      }),
  );

  server.registerTool(
    "get_palette",
    {
      title: "Get the palette",
      description: "The brand and neutral colors of a scanned page, as hexes with the role the scan gave them.",
      inputSchema: { scanId: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ scanId }) =>
      withScan(scanId, async (scan) =>
        ok({
          scanId,
          palette: [...(scan.palette?.brand ?? []), ...(scan.palette?.neutrals ?? [])],
        }),
      ),
  );

  server.registerTool(
    "install_fonts",
    {
      title: "Install the page fonts",
      description:
        "Converts the fonts of a scan to TTF and installs them in the user font directory, so they can be used in a design " +
        "tool. Reports the licence read from each font, commercial ones included, and what could not be installed and why.",
      inputSchema: {
        scanId: z.string(),
        families: z.array(z.string()).max(50).optional().describe("family names, as scan_page reported them. Left out, every installable family"),
      },
    },
    async ({ scanId, families }) =>
      withScan(scanId, async (scan) => {
        const report = await installFonts(scan.fonts, {
          fetchBytes: (file, fetchOptions) => openSource().fetchBytes(file, fetchOptions),
          pageHost: scan.page.host,
          ...(families === undefined ? {} : { only: families }),
        });
        return ok(report);
      }),
  );

  server.registerTool(
    "list_installed_fonts",
    {
      title: "List the fonts this tool installed",
      description: "The fonts installed through install_fonts, with their licence, their files, where they came from and when.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => ok({ fonts: await listInstalledFonts() }),
  );

  server.registerTool(
    "uninstall_fonts",
    {
      title: "Uninstall fonts",
      description: "Removes the font files install_fonts wrote for these families. It never touches a file it did not install.",
      inputSchema: { families: z.array(z.string()).min(1).max(50) },
    },
    async ({ families }) => ok(await uninstallFonts(families)),
  );

  return server;
}

/** Packages the bundles keep external (see scripts/build-agent.mjs): without them nothing can scan or convert. */
const RUNTIME_DEPENDENCIES = ["playwright-core", "sharp", "fontkit", "css-tree", "undici", "ipaddr.js", "wawoff2"];

/**
 * The first runtime dependency that cannot be resolved, or null. The bundles resolve these from the repo's
 * `node_modules` at run time, so a repo that was never installed, or was installed for another platform, fails on the
 * first scan with a stack trace instead of a sentence. This turns that into the sentence.
 */
export function missingRuntimeDependency(resolve: (name: string) => unknown = createRequire(import.meta.url).resolve): string | null {
  for (const name of RUNTIME_DEPENDENCIES) {
    try {
      resolve(name);
    } catch {
      return name;
    }
  }
  return null;
}

/** Serves the tools on stdio. Nothing is ever written to stdout except the protocol: diagnostics go to stderr. */
export async function main(): Promise<void> {
  const missing = missingRuntimeDependency();
  if (missing !== null) {
    console.error(
      `assets-scraper: the dependency ${missing} is not installed. Run "pnpm install && pnpm build:agent" in the repository, then start this server again.`,
    );
    process.exitCode = 1;
    return;
  }
  const server = createAgentMcpServer();
  await server.connect(new StdioServerTransport());
}

// `import.meta.main` is Node 24; this is the Node 22 form. It is false when a test imports the module, and true when
// node runs this file (the bundle) as its entry point.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
