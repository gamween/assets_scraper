import { describe, expect, it } from "vitest";
import { sniffContentType } from "./asset-proxy";

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
const MB = 1024 * 1024;

const text = (value: string) => Buffer.from(value, "utf8");

function timed<T>(fn: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
}

describe("sniffContentType", () => {
  it("recognizes SVG text after a BOM, an XML declaration, comments and an SVG doctype", () => {
    expect(sniffContentType(text(SVG))).toBe("image/svg+xml");
    const preamble =
      '﻿ \n<?xml version="1.0" encoding="UTF-8"?>\n<!-- Generator: x -->\n<!---->' +
      '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n<!-- -- -->\n<SVG\nwidth="1">';
    expect(sniffContentType(text(preamble))).toBe("image/svg+xml");
  });

  it("refuses text that does not start like an SVG document", () => {
    for (const value of [
      "<html><svg></svg></html>",
      "<!DOCTYPE html><svg>",
      "<svgx>",
      "<svg",
      "<!-- <svg> ",
      "<!--><svg>",
      '<!-- a --><?xml version="1.0"?><svg>',
      "<!DOCTYPE svg><!DOCTYPE svg><svg>",
      "hello",
    ]) {
      expect(sniffContentType(text(value)), value).toBeNull();
    }
  });

  it("stays linear on comment-heavy and unterminated preambles", () => {
    // The former single regex backtracked exponentially: 24 empty comments before a non-SVG tag took seconds.
    for (const value of [
      `${"<!---->".repeat(24)}<html>`,
      "<!---->".repeat(1_000),
      `<!--${"-".repeat(10_000)}`,
      "<!-- -- ->".repeat(1_000),
      `<?xml${" ".repeat(10_000)}`,
      `<!doctype svg${" ".repeat(10_000)}`,
    ]) {
      const { value: type, ms } = timed(() => sniffContentType(text(value)));
      expect(type, value.slice(0, 16)).toBeNull();
      expect(ms, value.slice(0, 16)).toBeLessThan(100);
    }
    expect(sniffContentType(text(`${"<!---->".repeat(80)}${SVG}`))).toBe("image/svg+xml");
  });

  it("only looks at the first 4 KB, even for a whole buffered font", () => {
    expect(sniffContentType(text(`${" ".repeat(4_091)}${SVG}`))).toBe("image/svg+xml");
    expect(sniffContentType(text(`${" ".repeat(4_092)}${SVG}`))).toBeNull();

    const spaces = Buffer.alloc(25 * MB, 0x20);
    const whitespace = timed(() => sniffContentType(spaces));
    expect(whitespace.value).toBeNull();
    expect(whitespace.ms).toBeLessThan(100);

    // an ISO BMFF box that claims to be 4 GB long, whose brands would otherwise be scanned across 25 MB
    const box = Buffer.alloc(25 * MB);
    box.writeUInt32BE(0xffff_ffff, 0);
    box.write("ftypmif1", 4, "latin1");
    const ftyp = timed(() => sniffContentType(box));
    expect(ftyp.value).toBeNull();
    expect(ftyp.ms).toBeLessThan(100);
  });
});
