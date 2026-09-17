import { describe, expect, it } from "vitest";
import { fontFileEntries, hasTtf, safeSegment, slugify } from "./font-files";
import { makeFont, makeFontFile } from "./testing";

describe("slugify", () => {
  it("strips accents and joins words with dashes", () => {
    expect(slugify("Söhne VF")).toBe("sohne-vf");
    expect(slugify("Crème Brûlée")).toBe("creme-brulee");
    expect(slugify("100 900")).toBe("100-900");
    expect(slugify("  --  ")).toBe("");
  });
});

describe("safeSegment", () => {
  it("replaces separators, reserved and control characters so a name stays one ZIP entry segment", () => {
    expect(safeSegment("../../etc/passwd")).toBe("-..-etc-passwd");
    expect(safeSegment("a\\b:c*d?e\"f<g>h|i")).toBe("a-b-c-d-e-f-g-h-i");
    expect(safeSegment("logo\u0000\u001f\u007f.svg")).toBe("logo-.svg");
    expect(safeSegment("tab\there")).toBe("tab-here");
  });

  it("trims dots and spaces at the ends and falls back when nothing is left", () => {
    expect(safeSegment(" .hidden. ")).toBe("hidden");
    expect(safeSegment("..", "font")).toBe("font");
    expect(safeSegment("", "site")).toBe("site");
  });

  it("keeps ordinary names, accents included, and caps the length", () => {
    expect(safeSegment("Inter Variable")).toBe("Inter Variable");
    expect(safeSegment("Söhne.woff2")).toBe("Söhne.woff2");
    expect(safeSegment("a".repeat(200))).toHaveLength(120);
  });
});

describe("fontFileEntries", () => {
  it("names files from the family and face, and offers a TTF only for open remote WOFF2 files", () => {
    const remote = makeFontFile({ url: "https://cdn.test/a1b2c3.woff2", proxy: "/api/asset?u=a&e=1&s=b" });
    const woff = makeFontFile({ url: "https://cdn.test/d4e5.woff", format: "woff", proxy: "/api/asset?u=c&e=1&s=d" });
    const family = makeFont({
      id: "inter",
      name: "Inter Variable",
      convertible: true,
      faces: [{ weight: "100 900", style: "italic", loaded: true, files: [remote, woff] }],
    });
    const entries = fontFileEntries(family);
    expect(entries.map((entry) => [entry.name, entry.ttfName])).toEqual([
      ["inter-variable-100-900-italic.woff2", "inter-variable-100-900-italic.ttf"],
      ["inter-variable-100-900-italic.woff", undefined],
    ]);
    expect(hasTtf({ convertible: false }, remote)).toBe(false);
    // Past the signing cap (proxy "") the server cannot convert the file
    expect(hasTtf({ convertible: true }, { ...remote, proxy: "" })).toBe(false);
    // Data-URI fonts download in their original format only (spec 9)
    expect(hasTtf({ convertible: true }, { ...remote, url: "", inline: { mime: "font/woff2", base64: "d09GMg==" } })).toBe(false);
  });
});
