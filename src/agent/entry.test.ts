import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { isEntry } from "./entry";

const trees: string[] = [];

afterEach(() => {
  for (const tree of trees.splice(0)) fs.rmSync(tree, { recursive: true, force: true });
});

describe("isEntry", () => {
  /** Regression: the MCP server compared the URL with argv as written, so a path through a link started nothing. */
  it("knows the entry point through a symbolic link on the way to it", () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-entry-")));
    trees.push(root);
    fs.mkdirSync(path.join(root, "real"));
    const file = path.join(root, "real", "mcp.mjs");
    fs.writeFileSync(file, "");
    fs.symlinkSync(path.join(root, "real"), path.join(root, "link"));

    expect(isEntry(pathToFileURL(file).href, file)).toBe(true);
    expect(isEntry(pathToFileURL(file).href, path.join(root, "link", "mcp.mjs"))).toBe(true);
  });

  it("is false for another file, a missing one or no argv at all", () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-entry-")));
    trees.push(root);
    const file = path.join(root, "cli.mjs");
    fs.writeFileSync(file, "");
    fs.writeFileSync(path.join(root, "other.mjs"), "");

    expect(isEntry(pathToFileURL(file).href, path.join(root, "other.mjs"))).toBe(false);
    expect(isEntry(pathToFileURL(file).href, path.join(root, "missing.mjs"))).toBe(false);
    expect(isEntry(pathToFileURL(file).href, undefined)).toBe(false);
  });
});
