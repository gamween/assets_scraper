import { describe, expect, it } from "vitest";
import { MCP_TOOL_NAMES, missingRuntimeDependency } from "./mcp";

/** The parts of the MCP server that need no transport. The tools themselves are tested in tests/integration/agent/mcp.test.ts. */

describe("MCP_TOOL_NAMES", () => {
  it("names the eight tools of the spec, once each", () => {
    expect(MCP_TOOL_NAMES).toHaveLength(8);
    expect(new Set(MCP_TOOL_NAMES).size).toBe(8);
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
