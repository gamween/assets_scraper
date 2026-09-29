// The packages the agent bundles do not inline (agent access spec section 3). `scripts/build-agent.mjs` leaves them
// external, and `scripts/mcp-launcher.mjs` checks they are installed before it starts the server, so the one list is
// what both sides read: a package added here is both kept out of the bundle and required at start.

/**
 * Native bindings (sharp, wawoff2), the browser driver and its Chromium, the font and CSS parsers, the HTTP client and
 * the MCP SDK, which ships its own ESM. They resolve from the repo's node_modules at run time.
 */
export const AGENT_EXTERNALS = [
  "playwright-core",
  "@sparticuz/chromium",
  "sharp",
  "fontkit",
  "css-tree",
  "undici",
  "ipaddr.js",
  "wawoff2",
  "@modelcontextprotocol/sdk",
];
