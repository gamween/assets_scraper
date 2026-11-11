import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MCP_TOOL_NAMES } from "@/agent/testing";
import { CLAUDE_CODE_INSTALL, CLI_EXAMPLES, MCP_CLIENT_CONFIG, MCP_TOOLS, SCAN_CURL } from "./content";

/**
 * The `/agents` page restates what the agent layer offers and how to start it. Each part is held here to the source it
 * comes from, so a tool added to the server, a moved launcher or a changed install step fails a test rather than
 * leaving the page quietly wrong.
 */

const ROOT = path.resolve(import.meta.dirname, "../../..");
const read = (file: string): string => fs.readFileSync(path.join(ROOT, file), "utf8");

const PLUGIN = JSON.parse(read("plugins/assets-scraper/.claude-plugin/plugin.json")) as {
  name: string;
  mcpServers: Record<string, { command: string; args: string[] }>;
};

describe("the /agents page", () => {
  it("lists the tools the MCP server registers, in its order", () => {
    // src/agent/mcp.test.ts holds the server to MCP_TOOL_NAMES, so a tool added there fails until the page lists it.
    expect(MCP_TOOLS.map((tool) => tool.name)).toEqual(MCP_TOOL_NAMES);
    for (const tool of MCP_TOOLS) expect(tool.purpose, tool.name).toMatch(/^[A-Z][^.]*[a-z]$/);
  });

  it("gives other MCP clients the command the plugin runs, under the name the plugin gives the server", () => {
    const config = JSON.parse(MCP_CLIENT_CONFIG) as { mcpServers: Record<string, { command: string; args: string[] }> };
    const [[name, server]] = Object.entries(config.mcpServers);
    const [pluginName, pluginServer] = Object.entries(PLUGIN.mcpServers)[0];
    expect(name).toBe(pluginName);
    expect(server.command).toBe(pluginServer.command);

    // Both point at the launcher in the clone: the plugin from its own directory, the generic config by absolute path.
    const launcher = "scripts/mcp-launcher.mjs";
    expect(pluginServer.args).toEqual([`\${CLAUDE_PLUGIN_ROOT}/../../${launcher}`]);
    expect(server.args).toEqual([`/absolute/path/to/assets_scraper/${launcher}`]);
    expect(fs.existsSync(path.join(ROOT, launcher))).toBe(true);
  });

  it("installs the Claude Code plugin with the steps of docs/agents.md", () => {
    const doc = read("docs/agents.md");
    expect(doc).toContain(["```bash", CLAUDE_CODE_INSTALL, "```"].join("\n"));
    expect(CLAUDE_CODE_INSTALL).toContain(`claude plugin install ${PLUGIN.name}`);
  });

  it("runs CLI commands the CLI has, and the scan request of docs/agents.md", () => {
    const doc = read("docs/agents.md");
    for (const example of CLI_EXAMPLES) {
      const [bin, command, , ...options] = example.split(" ");
      expect(bin).toBe("assets-scraper");
      expect(doc, example).toContain(`assets-scraper ${command} <url> [options]`);
      for (const option of options.filter((part) => part.startsWith("--"))) expect(doc, option).toContain(`\n${option} `);
    }
    expect(doc).toContain(SCAN_CURL);
  });
});
