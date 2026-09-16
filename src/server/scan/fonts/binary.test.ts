import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseFontBinary, sniffFontFormat } from "./binary";

const asset = (name: string) => readFileSync(path.join(process.cwd(), "tests/fixtures/site/assets", name));

describe("parseFontBinary", () => {
  it("reads names, licence records, axes and Latin coverage from a variable WOFF2", () => {
    const meta = parseFontBinary(asset("__inter.woff2"));
    expect(meta).toMatchObject({
      format: "woff2",
      familyName: "Inter",
      nameId1: "Inter",
      subfamilyName: "Regular",
      postscriptName: "Inter-Regular",
      fullName: "Inter Regular",
      licenseUrl: "https://openfontlicense.org",
      weightClass: 400,
      coversLatin: true,
    });
    expect(meta?.copyright).toContain("Inter Project Authors");
    expect(meta?.typoFamily).toBeUndefined();
    expect(meta?.axes).toContainEqual({ tag: "wght", min: 100, max: 900, default: 400 });
  });

  it("prefers the typographic family and reports missing Latin glyphs", () => {
    const meta = parseFontBinary(asset("jbm-cyr.woff2"));
    expect(meta).toMatchObject({
      familyName: "JetBrains Mono",
      typoFamily: "JetBrains Mono",
      nameId1: "JetBrains Mono Medium",
      subfamilyName: "Medium",
      coversLatin: false,
      weightClass: 500,
    });
    expect(meta?.axes).toBeUndefined();
  });

  it("reads the licence description of a static font", () => {
    const meta = parseFontBinary(asset("ss3.woff2"));
    expect(meta?.familyName).toBe("Source Sans 3");
    expect(meta?.licenseDescription).toMatch(/SIL Open Font License, Version 1\.1/);
    expect(meta?.licenseUrl).toBe("http://scripts.sil.org/OFL");
  });

  it("gives null for bytes that are not a font", () => {
    expect(parseFontBinary(Buffer.from("definitely not a font file, just text"))).toBeNull();
    expect(parseFontBinary(Buffer.from([0x77, 0x4f, 0x46, 0x32, 1, 2, 3]))).toBeNull();
    expect(parseFontBinary(asset("__inter.woff2").subarray(0, 2000))).toBeNull();
    expect(parseFontBinary(Buffer.alloc(0))).toBeNull();
  });
});

describe("sniffFontFormat", () => {
  it("recognizes font signatures", () => {
    expect(sniffFontFormat(asset("ss3.woff2"))).toBe("woff2");
    expect(sniffFontFormat(Buffer.from("wOFF0000"))).toBe("woff");
    expect(sniffFontFormat(Buffer.from([0, 1, 0, 0, 0, 0]))).toBe("ttf");
    expect(sniffFontFormat(Buffer.from("true0000"))).toBe("ttf");
    expect(sniffFontFormat(Buffer.from("OTTO0000"))).toBe("otf");
    const eot = Buffer.alloc(40);
    eot.writeUInt16LE(0x504c, 34);
    expect(sniffFontFormat(eot)).toBe("eot");
    expect(sniffFontFormat(Buffer.from("<html>"))).toBe("other");
  });
});
