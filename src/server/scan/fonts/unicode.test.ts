import { describe, expect, it } from "vitest";
import { coversBasicLatin, parseUnicodeRange } from "./unicode";

describe("unicode-range", () => {
  it("parses ranges and wildcards", () => {
    expect(parseUnicodeRange("U+0000-00FF, U+0131, U+4??")).toEqual([[0, 255], [0x131, 0x131], [0x400, 0x4ff]]);
    expect(coversBasicLatin("U+0000-00FF")).toBe(true);
    expect(coversBasicLatin("U+0400-045F")).toBe(false);
    expect(coversBasicLatin(undefined)).toBe(true);
  });

  it("is case-insensitive and ignores empty parts", () => {
    expect(parseUnicodeRange("u+41-5a,, u+61-7A")).toEqual([[0x41, 0x5a], [0x61, 0x7a]]);
    expect(coversBasicLatin("u+41-5a, u+61-7a")).toBe(true);
    expect(coversBasicLatin("U+41-5A")).toBe(false);
  });

  it("treats a missing or invalid descriptor as the full range, like browsers", () => {
    expect(parseUnicodeRange(undefined)).toEqual([[0, 0x10ffff]]);
    expect(parseUnicodeRange("")).toEqual([[0, 0x10ffff]]);
    expect(parseUnicodeRange("latin")).toEqual([[0, 0x10ffff]]);
    expect(parseUnicodeRange("U+0400-045F, nonsense")).toEqual([[0x400, 0x45f]]);
  });
});
