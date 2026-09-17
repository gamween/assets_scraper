import { describe, expect, it } from "vitest";
import { extensionFor, formatFromContentType, formatFromUrl, sniffFormat } from "./format";

const bytes = (...values: (number | string)[]) =>
  Buffer.concat(values.map((v) => (typeof v === "string" ? Buffer.from(v, "latin1") : Buffer.from([v]))));

describe("formatFromContentType", () => {
  it("maps image content types", () => {
    expect(formatFromContentType("image/svg+xml; charset=utf-8", "x")).toBe("svg");
    expect(formatFromContentType("image/x-icon", "https://a.com/favicon")).toBe("ico");
    expect(formatFromContentType("image/vnd.microsoft.icon", "")).toBe("ico");
    expect(formatFromContentType("IMAGE/JPEG", "")).toBe("jpg");
    expect(formatFromContentType("image/png", "https://a.com/x.jpg")).toBe("png");
    expect(formatFromContentType("image/avif", "")).toBe("avif");
    expect(formatFromContentType("image/bmp", "")).toBe("bmp");
  });

  it("falls back to the URL extension", () => {
    expect(formatFromContentType("application/octet-stream", "https://a.com/x.webp?v=1")).toBe("webp");
    expect(formatFromContentType("", "https://a.com/logo.SVG#icon")).toBe("svg");
    expect(formatFromContentType("image/tiff", "https://a.com/x.tiff")).toBe("other");
    expect(formatFromContentType("text/html", "https://a.com/page")).toBe("other");
  });
});

describe("formatFromUrl", () => {
  it("reads extensions and data URI types", () => {
    expect(formatFromUrl("https://a.com/a/b.jpeg")).toBe("jpg");
    expect(formatFromUrl("https://a.com/b.gif?x=1.png")).toBe("gif");
    expect(formatFromUrl("data:image/svg+xml;base64,PHN2Zz4=")).toBe("svg");
    expect(formatFromUrl("https://a.com/image")).toBe("other");
    expect(formatFromUrl("not a url")).toBe("other");
  });
});

describe("sniffFormat", () => {
  it("recognizes magic bytes", () => {
    expect(sniffFormat(bytes(0x89, "PNG\r\n", 0x1a, "\n", 0, 0))).toBe("png");
    expect(sniffFormat(bytes(0xff, 0xd8, 0xff, 0xe0, 0))).toBe("jpg");
    expect(sniffFormat(bytes("GIF89a", 1, 0))).toBe("gif");
    expect(sniffFormat(bytes("RIFF", 0, 0, 0, 0, "WEBPVP8 "))).toBe("webp");
    expect(sniffFormat(bytes(0, 0, 0, 0x1c, "ftypavif", 0, 0, 0, 0))).toBe("avif");
    expect(sniffFormat(bytes(0, 0, 0, 0x1c, "ftypavis", 0, 0, 0, 0))).toBe("avif");
    expect(sniffFormat(bytes(0, 0, 1, 0, 1, 0, 16, 16))).toBe("ico");
    expect(sniffFormat(bytes("BM", 0, 0, 0, 0, 0, 0, 0, 0))).toBe("bmp");
  });

  it("recognizes SVG text with a BOM, XML prolog, comments or doctype", () => {
    expect(sniffFormat(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe("svg");
    expect(sniffFormat(Buffer.from('\uFEFF  <?xml version="1.0"?>\n<!-- x --><!DOCTYPE svg><svg></svg>'))).toBe("svg");
  });

  it("returns other otherwise", () => {
    expect(sniffFormat(Buffer.from("<!doctype html><html></html>"))).toBe("other");
    expect(sniffFormat(Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]))).toBe("other");
    expect(sniffFormat(Buffer.alloc(0))).toBe("other");
  });
});

describe("extensionFor", () => {
  it("gives the file extension of a format", () => {
    expect(extensionFor("jpg")).toBe("jpg");
    expect(extensionFor("svg")).toBe("svg");
    expect(extensionFor("other")).toBe("bin");
  });
});
