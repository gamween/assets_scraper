import { describe, expect, it } from "vitest";
import { sniffContentType } from "./sniff";

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
      '\uFEFF \n<?xml version="1.0" encoding="UTF-8"?>\n<!-- Generator: x -->\n<!---->' +
      '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n<!-- -- -->\n<SVG\nwidth="1">';
    expect(sniffContentType(text(preamble))).toBe("image/svg+xml");
  });

  it("recognizes real-world exports: doctype internal subsets, stylesheet instructions and empty svg elements", () => {
    const illustrator =
      '<?xml version="1.0" encoding="utf-8"?>\n<!-- Generator: Adobe Illustrator 16.0.0, SVG Export Plug-In . SVG Version: 6.00 Build 0)  -->\n' +
      '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd" [\n' +
      '\t<!ENTITY ns_extend "http://ns.adobe.com/Extensibility/1.0/">\n\t<!ENTITY ns_ai "http://ns.adobe.com/AdobeIllustrator/10.0/">\n]>\n' +
      '<svg version="1.1" id="Layer_1" xmlns:x="&ns_extend;" xmlns="http://www.w3.org/2000/svg">';
    expect(sniffContentType(text(illustrator))).toBe("image/svg+xml");
    expect(sniffContentType(text('<!DOCTYPE svg [ <!ENTITY a "b"> ] >\n<svg>'))).toBe("image/svg+xml");
    expect(sniffContentType(text('<?xml version="1.0"?>\n<?xml-stylesheet type="text/css" href="style.css"?>\n<svg width="1">'))).toBe("image/svg+xml");
    expect(sniffContentType(text('<?xml-stylesheet href="a.css"?><!-- x --><svg>'))).toBe("image/svg+xml");
    expect(sniffContentType(text("<svg/>"))).toBe("image/svg+xml");
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
      "<!DOCTYPE svgz><svg>",
      "<!DOCTYPE svg [ <!ENTITY a \"b\"> <svg>",
      "<!DOCTYPE svg [ ]",
      '<?xml version="1.0"?><?xml version="1.0"?><svg>',
      "<?xml-stylesheet href='a.css' <svg>",
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
      `<!doctype svg [${"] ".repeat(2_000)}`,
      `<!doctype svg [${"]".repeat(4_000)}`,
      `<?a${"?".repeat(4_000)}`,
      "<?a?>".repeat(1_000),
    ]) {
      const { value: type, ms } = timed(() => sniffContentType(text(value)));
      expect(type, value.slice(0, 16)).toBeNull();
      expect(ms, value.slice(0, 16)).toBeLessThan(500);
    }
    expect(sniffContentType(text(`${"<!---->".repeat(80)}${SVG}`))).toBe("image/svg+xml");
  });

  it("only looks at the first 4 KB, even for a whole buffered font", () => {
    expect(sniffContentType(text(`${" ".repeat(4_091)}${SVG}`))).toBe("image/svg+xml");
    expect(sniffContentType(text(`${" ".repeat(4_092)}${SVG}`))).toBeNull();

    const spaces = Buffer.alloc(25 * MB, 0x20);
    const whitespace = timed(() => sniffContentType(spaces));
    expect(whitespace.value).toBeNull();
    expect(whitespace.ms).toBeLessThan(500);

    // an ISO BMFF box that claims to be 4 GB long, whose brands would otherwise be scanned across 25 MB
    const box = Buffer.alloc(25 * MB);
    box.writeUInt32BE(0xffff_ffff, 0);
    box.write("ftypmif1", 4, "latin1");
    const ftyp = timed(() => sniffContentType(box));
    expect(ftyp.value).toBeNull();
    expect(ftyp.ms).toBeLessThan(500);
  });
});
