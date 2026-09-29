import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { z } from "zod";

/**
 * The Claude Code plugin (plan Task G5.1): both manifests parse against the fields Claude Code documents, the skill is
 * where the loader looks for it, and the MCP command resolves to the file `pnpm build:agent` writes.
 */

const ROOT = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const PLUGIN_DIR = path.join(ROOT, "plugins", "assets-scraper");
const read = (file: string): string => fs.readFileSync(file, "utf8");
const readJson = (file: string): unknown => JSON.parse(read(file));

const KEBAB = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const Person = z.object({ name: z.string().min(1), email: z.email().optional(), url: z.url().optional() });

const Marketplace = z.object({
  $schema: z.string().optional(),
  name: z.string().regex(KEBAB),
  description: z.string().min(1),
  owner: Person,
  plugins: z
    .array(
      z.object({
        name: z.string().regex(KEBAB),
        description: z.string().min(1),
        source: z.string().startsWith("./"),
        author: Person.optional(),
        category: z.string().optional(),
        keywords: z.array(z.string()).optional(),
      }),
    )
    .min(1),
});

const McpStdioServer = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

const Plugin = z.object({
  $schema: z.string().optional(),
  name: z.string().regex(KEBAB),
  description: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  author: Person,
  repository: z.url().optional(),
  license: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  mcpServers: z.record(z.string().regex(KEBAB), McpStdioServer),
});

describe("the Claude Code plugin manifests", () => {
  it("lists one plugin whose source directory holds a manifest", () => {
    const marketplace = Marketplace.parse(readJson(path.join(ROOT, ".claude-plugin", "marketplace.json")));
    expect(marketplace.plugins.map((plugin) => plugin.name)).toEqual(["assets-scraper"]);
    const source = path.resolve(ROOT, marketplace.plugins[0].source);
    expect(source).toBe(PLUGIN_DIR);
    expect(fs.existsSync(path.join(source, ".claude-plugin", "plugin.json"))).toBe(true);
  });

  it("declares the MCP server with the environment the remote mode needs", () => {
    const plugin = Plugin.parse(readJson(path.join(PLUGIN_DIR, ".claude-plugin", "plugin.json")));
    expect(plugin.name).toBe("assets-scraper");
    const server = plugin.mcpServers["assets-scraper"];
    expect(server).toBeDefined();
    expect(server.command).toBe("node");
    expect(server.args).toHaveLength(1);
    // Unset variables expand to nothing, so a user who never set them still gets a server that starts (spec 9).
    expect(server.env).toEqual({
      ASSETS_SCRAPER_REMOTE: "${ASSETS_SCRAPER_REMOTE:-}",
      ASSETS_SCRAPER_TOKEN: "${ASSETS_SCRAPER_TOKEN:-}",
      ASSETS_SCRAPER_ACCESS_CODE: "${ASSETS_SCRAPER_ACCESS_CODE:-}",
    });
  });

  it("points the MCP server at the committed launcher, which is what keeps the bundle current", () => {
    const plugin = Plugin.parse(readJson(path.join(PLUGIN_DIR, ".claude-plugin", "plugin.json")));
    const [entry] = plugin.mcpServers["assets-scraper"].args ?? [];
    expect(entry).toContain("${CLAUDE_PLUGIN_ROOT}");
    // Claude Code sets CLAUDE_PLUGIN_ROOT to the installed plugin directory, which is this one for a local marketplace.
    const resolved = path.resolve(entry.replace("${CLAUDE_PLUGIN_ROOT}", PLUGIN_DIR));
    // The bundle itself is gitignored, so a clone can have none or an old one: the launcher rebuilds it before
    // serving, which the manifest could not do by naming dist/mcp.mjs directly (ship review, stale bundle).
    expect(resolved).toBe(path.join(ROOT, "scripts", "mcp-launcher.mjs"));
    expect(fs.existsSync(resolved)).toBe(true);
  });

  it("keeps the skill where the loader looks for it", () => {
    const skill = path.join(PLUGIN_DIR, "skills", "assets-scraper", "SKILL.md");
    const text = read(skill);
    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(text);
    expect(frontmatter).not.toBeNull();
    expect(frontmatter?.[1]).toMatch(/^name: assets-scraper$/m);
    const description = /^description: (.+)$/m.exec(frontmatter?.[1] ?? "");
    expect(description?.[1].length).toBeGreaterThan(40);
    // The workflow an agent has to follow, and the rules that keep a download small (plan G5.1 step 2).
    for (const marker of ["scan_page", "list_assets", "download_assets", "install_fonts", "scrap/", "Examples"]) {
      expect(text).toContain(marker);
    }
  });

  it("writes its copy in the house style", () => {
    const files = [
      path.join(PLUGIN_DIR, "skills", "assets-scraper", "SKILL.md"),
      path.join(ROOT, "docs", "agents.md"),
      path.join(ROOT, "README.md"),
    ];
    for (const file of files) {
      const text = read(file);
      expect(text, `${file} uses an em dash or an en dash`).not.toMatch(/[–—]/);
      expect(text, `${file} uses an emoji`).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });
});

describe("pnpm build:agent", () => {
  const source = path.join(ROOT, "src", "agent", "mcp.ts");
  const entry = path.join(ROOT, "dist", "mcp.mjs");

  it("writes the MCP entry point the plugin runs", async () => {
    await promisify(execFile)("pnpm", ["build:agent"], { cwd: ROOT });
    if (!fs.existsSync(source)) {
      // Track G3 writes src/agent/mcp.ts. Until it lands the build skips the entry with a warning, by design.
      expect(fs.existsSync(entry)).toBe(false);
      return;
    }
    expect(read(entry).startsWith("#!/usr/bin/env node")).toBe(true);
  }, 120_000);
});
