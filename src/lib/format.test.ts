import { describe, expect, it } from "vitest";
import { formatBytes, formatCount, formatDimensions, formatDuration } from "./format";

describe("format", () => {
  it.each([
    [0, "0 B"], [512, "512 B"], [3072, "3.0 KB"], [360_000, "352 KB"], [2_516_582, "2.4 MB"], [1_048_000, "1.0 MB"],
    [999, "999 B"], [1_000, "1.0 KB"], [10_188, "9.9 KB"], [10_200, "10 KB"],
    [250 * 1024 * 1024, "250 MB"], [1_073_700_000, "1.0 GB"], [5 * 1024 ** 3, "5.0 GB"],
  ])("formatBytes(%d) = %s", (n, s) => expect(formatBytes(n)).toBe(s));

  it("returns an empty string for invalid sizes", () => {
    expect(formatBytes(-1)).toBe("");
    expect(formatBytes(Number.NaN)).toBe("");
  });

  it("formats dimensions and durations", () => {
    expect(formatDimensions(1200, 630)).toBe("1200×630");
    expect(formatDimensions(undefined, 630)).toBe("");
    expect(formatDuration(11_400)).toBe("11s");
    expect(formatDuration(75_000)).toBe("1m 15s");
  });

  it("formats counts with optional nouns", () => {
    expect(formatCount(1500)).toBe("1,500");
    expect(formatCount(1, "asset")).toBe("1 asset");
    expect(formatCount(48, "asset")).toBe("48 assets");
    expect(formatCount(0, "file")).toBe("0 files");
    expect(formatCount(2, "family", "families")).toBe("2 families");
    expect(formatCount(Number.NaN, "asset")).toBe("");
  });
});
