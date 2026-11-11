/**
 * What the `/agents` page shows, kept apart from its markup so the tests next to it can hold it to the sources it
 * summarizes: docs/agents.md, the plugin manifest, scripts/mcp-launcher.mjs and the tools `src/agent/mcp.ts` registers.
 */

export const REPO_URL = "https://github.com/gamween/assets_scraper";
export const AGENTS_DOC_URL = `${REPO_URL}/blob/main/docs/agents.md`;

/** The hosted app the CLI scans against by default (`DEFAULT_REMOTE` in src/agent/cli.ts). */
const HOSTED_APP = "https://assets-scraper.vercel.app";

/** Section 1 of docs/agents.md: clone, build, add the clone as a marketplace, install the plugin. */
export const CLAUDE_CODE_INSTALL = [
  `git clone ${REPO_URL}`,
  "cd assets_scraper",
  "pnpm install",
  "pnpm build:agent",
  'claude plugin marketplace add "$PWD"',
  "claude plugin install assets-scraper",
].join("\n");

/**
 * The same server for any MCP client: the launcher the plugin starts, given by its absolute path. It builds the bundle
 * when it is missing or older than its sources, so a client that starts it after a pull still gets the current code.
 */
export const MCP_CLIENT_CONFIG = `{
  "mcpServers": {
    "assets-scraper": {
      "command": "node",
      "args": ["/absolute/path/to/assets_scraper/scripts/mcp-launcher.mjs"]
    }
  }
}`;

export const CLI_EXAMPLES = [
  "assets-scraper scan stripe.com",
  "assets-scraper get stripe.com --role logo,site-logo",
  "assets-scraper brand stripe.com",
];

/** Section 3 of docs/agents.md. */
export const SCAN_CURL = `curl -sS --fail-with-body ${HOSTED_APP}/api/v1/scan \\
  -H "Authorization: Bearer $ASSETS_SCRAPER_TOKEN" \\
  -H "content-type: application/json" \\
  -d '{"url":"stripe.com","view":"summary"}'`;

/** One row per tool the MCP server registers, in its order. content.test.ts fails when the two drift apart. */
export const MCP_TOOLS: readonly { name: string; purpose: string }[] = [
  { name: "scan_page", purpose: "Scan a page and get a short summary and a scan id" },
  { name: "list_assets", purpose: "Page through the assets, filtered by kind, role, size or name" },
  { name: "download_assets", purpose: "Write the usable files to disk, with a manifest" },
  { name: "download_brand_files", purpose: "Download the brand kit and unpack its logo files" },
  { name: "read_svg", purpose: "Read the markup of one SVG as text" },
  { name: "get_palette", purpose: "Get the palette hexes and their roles" },
  { name: "install_fonts", purpose: "Install the page fonts, with their licence" },
  { name: "list_installed_fonts", purpose: "List the fonts this tool installed" },
  { name: "uninstall_fonts", purpose: "Remove fonts this tool installed" },
];
