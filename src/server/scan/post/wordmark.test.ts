import { describe, expect, it } from "vitest";
import type { FontFamily } from "@/lib/contract";
import { buildWordmark, wordmarkFamily } from "./wordmark";

const testFontFamily = (patch: Partial<FontFamily> & { name: string }): FontFamily => ({
  id: `font-${patch.name.toLowerCase()}`,
  cssFamilies: [patch.name],
  source: "self-hosted",
  license: { kind: "open" },
  convertible: true,
  downloadable: true,
  usedOnPage: true,
  usage: 0.5,
  faces: [],
  ...patch,
});

/** What the collector hands over for investirday.fr's header link (`RawWordmark`). */
const investirday = () => ({
  runs: [
    { text: "Investir\n", hex: "#130d21" },
    { text: "Day", hex: "#fb2189" },
  ],
  stack: "Inter, system-ui, sans-serif",
  weight: 700,
  size: 12,
  letterSpacing: 1.2000000476837158,
  transform: "uppercase",
  logo: { group: 5, width: 36, height: 36 },
});

const inter = testFontFamily({ name: "Inter", cssFamilies: ["Inter", "__Inter_d65c78"] });
const context = (patch: Partial<Parameters<typeof buildWordmark>[1]> = {}) => ({
  families: [inter],
  assetIdOf: (source: { group?: number; svg?: string }) => (source.group === 5 ? "logo-id" : source.svg === "abc" ? "svg-id" : undefined),
  assetIds: new Set(["logo-id", "svg-id"]),
  ...patch,
});

describe("buildWordmark", () => {
  it("gives investirday.fr's lockup: the runs, the type settings, and the logo it sits beside", () => {
    expect(buildWordmark(investirday(), context())).toEqual({
      text: "Investir\nDay",
      family: "Inter",
      weight: 700,
      size: 12,
      letterSpacing: 1.2,
      transform: "uppercase",
      runs: [
        { text: "Investir\n", hex: "#130d21" },
        { text: "Day", hex: "#fb2189" },
      ],
      withLogo: { id: "logo-id", width: 36, height: 36 },
    });
  });

  it("ties an inline SVG by its hash, and leaves the tie out for a picture that became no asset or was cut", () => {
    expect(buildWordmark({ ...investirday(), logo: { svg: "abc", width: 20, height: 22 } }, context())?.withLogo).toEqual({ id: "svg-id", width: 20, height: 22 });
    expect(buildWordmark({ ...investirday(), logo: { group: 9, width: 36, height: 36 } }, context())?.withLogo).toBeUndefined();
    expect(buildWordmark(investirday(), context({ assetIds: new Set() }))?.withLogo).toBeUndefined();
    expect(buildWordmark(investirday(), context({ assetIdOf: undefined }))?.withLogo).toBeUndefined();
    expect(buildWordmark({ ...investirday(), logo: { group: 5, width: 0, height: 36 } }, context())?.withLogo).toBeUndefined();
  });

  it("merges neighbouring runs of one colour and reads an unknown transform as none", () => {
    const wordmark = buildWordmark({ ...investirday(), runs: [{ text: "Acme ", hex: "#111111" }, { text: "Labs", hex: "#111111" }], transform: "full-width" }, context());
    expect(wordmark).toMatchObject({ text: "Acme Labs", runs: [{ text: "Acme Labs", hex: "#111111" }], transform: "none" });
  });

  it("refuses what a page that replaced the collector could send", () => {
    const run = (text: string, hex = "#111111") => ({ text, hex });
    for (const raw of [
      undefined,
      "InvestirDay",
      { ...investirday(), runs: [] },
      { ...investirday(), runs: [run("A", "#111111"), run("B", "#222222"), run("C", "#333333"), run("D", "#444444"), run("E", "#555555")] },
      { ...investirday(), runs: [run("x".repeat(41))] },
      { ...investirday(), runs: [run("Home")] },
      { ...investirday(), runs: [run(" Acme")] },
      { ...investirday(), runs: [run("   ")] },
      { ...investirday(), runs: [run("Acme", "red")] },
      { ...investirday(), runs: [{ text: 7, hex: "#111111" }] },
      { ...investirday(), size: 0 },
      { ...investirday(), size: Number.NaN },
      { ...investirday(), weight: 4_000 },
      { ...investirday(), letterSpacing: "1.2px" },
      { ...investirday(), stack: undefined },
    ]) {
      expect(buildWordmark(raw, context()), JSON.stringify(raw)).toBeUndefined();
    }
  });
});

describe("wordmarkFamily", () => {
  it("names the family by the scan's name, a next/font CSS name included", () => {
    expect(wordmarkFamily("Inter, system-ui, sans-serif", [inter])).toBe("Inter");
    expect(wordmarkFamily(`"__Inter_d65c78", "__Inter_Fallback_d65c78"`, [inter])).toBe("Inter");
  });

  it("passes over a web font that never loaded, as the browser did, and keeps a system font as written", () => {
    const broken = testFontFamily({ name: "Brand Sans", usedOnPage: false });
    expect(wordmarkFamily(`"Brand Sans", Inter, sans-serif`, [broken, inter])).toBe("Inter");
    expect(wordmarkFamily(`"Brand Sans", "Helvetica Neue", sans-serif`, [broken, inter])).toBe("Helvetica Neue");
    expect(wordmarkFamily("system-ui, -apple-system, sans-serif", [inter])).toBe("system-ui");
  });

  it("cleans the first name of the stack when the scan has no fonts to read it against", () => {
    expect(wordmarkFamily(`"__Inter_d65c78", sans-serif`, [])).toBe("Inter");
    expect(wordmarkFamily(`"Brand Sans"`, [testFontFamily({ name: "Brand Sans", usedOnPage: false })])).toBe("Brand Sans");
    expect(wordmarkFamily("", [])).toBe("");
  });
});
