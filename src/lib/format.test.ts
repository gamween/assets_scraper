import { describe, expect, it } from "vitest";
import { formatBytes, formatDimensions, formatDuration } from "./format";

describe("format", () => {
  it.each([
    [0, "0 B"], [512, "512 B"], [3072, "3.0 KB"], [360_000, "352 KB"], [2_516_582, "2.4 MB"], [1_048_000, "1.0 MB"],
  ])("formatBytes(%d) = %s", (n, s) => expect(formatBytes(n)).toBe(s));

  it("formats dimensions and durations", () => {
    expect(formatDimensions(1200, 630)).toBe("1200×630");
    expect(formatDimensions(undefined, 630)).toBe("");
    expect(formatDuration(11_400)).toBe("11s");
    expect(formatDuration(75_000)).toBe("1m 15s");
  });
});
