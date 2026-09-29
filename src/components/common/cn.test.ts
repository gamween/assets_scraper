import { describe, expect, it, vi } from "vitest";
import { cn } from "./cn";

// The page merges with the tables compiled ahead of time. `cn/config` compiled its default config on the first call,
// during hydration, and shipped 45 KB of compiler and config to every visit: loading it at all fails this file.
vi.mock("cn/config", () => {
  throw new Error("cn/config compiles the merge tables in the browser; cn.ts merges with cn-tables.ts");
});

describe("cn", () => {
  it("reads the app's type scale as sizes, not colors", () => {
    // The stock merger took `text-body` for a color and dropped the real color from the same element.
    expect(cn("text-body text-ink-fg")).toBe("text-body text-ink-fg");
    expect(cn("font-mono text-mono text-text-3")).toBe("font-mono text-mono text-text-3");
    expect(cn("text-body", "text-mono")).toBe("text-mono");
    expect(cn("text-input-lg text-mono-xs")).toBe("text-mono-xs");
  });

  it("merges like the stock merger otherwise", () => {
    expect(cn("px-2 py-1", "px-3")).toBe("py-1 px-3");
    expect(cn("text-sm", "text-body")).toBe("text-body");
    expect(cn("bg-surface", false, { "bg-well": true })).toBe("bg-well");
  });
});
