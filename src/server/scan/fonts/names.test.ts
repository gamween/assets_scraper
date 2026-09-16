import { describe, expect, it } from "vitest";
import { cleanCssFamily, isMangledCssFamily, resolveFamilyName, splitFamilies } from "./names";

describe("resolveFamilyName", () => {
  // discovery-lab.md 3.2
  it.each([
    ["__Inter_d65c78", { nameId1: "Inter" }, "Inter"],
    ["NotionInter", { nameId1: "Inter" }, "Inter"],
    ["GeistSans", { nameId1: "Geist" }, "Geist"],
    ["Mona Sans", { nameId1: "Mona Sans ExtraLight" }, "Mona Sans"],
    ["sohne-var", { typoFamily: "Söhne VF" }, "Söhne VF"],
    ["Geograph", { nameId1: "Copyright Klim Type Foundry" }, "Geograph"],
    ["wf_1a2b3c4d5e6f7a8b9c", { nameId1: "Akzidenz-Grotesk BQ" }, "Akzidenz-Grotesk BQ"],
    ["Waldenburg-75357948a2b6a39b", null, "Waldenburg"],
    ["argent-pixel-cf", { nameId1: "Argent Pixel CF" }, "Argent Pixel CF"],
    ["rippleFont", { nameId1: "TT Ripple" }, "TT Ripple"],
    ["IBM Plex Mono-c20ba633a65a8c57", null, "IBM Plex Mono"],
    ["Inter Display Placeholder", null, "Inter Display"],
  ])("%s with %j gives %s", (css, meta, name) => {
    expect(resolveFamilyName(meta, css).name).toBe(name);
  });

  it("rejects garbage binary names", () => {
    expect(resolveFamilyName({ nameId1: ".\u007f" }, "Sohne")).toEqual({ name: "Sohne", basis: "css" });
    expect(resolveFamilyName({ nameId1: "." }, null).name).toBe("(unknown)");
    expect(resolveFamilyName({ nameId1: "false", postscriptName: "false" }, "Framer Font").name).toBe("Framer Font");
    expect(resolveFamilyName({ nameId1: "ABCDEF0123456789ABCD" }, "Brand").name).toBe("Brand");
  });

  it("stays linear on hostile name records", () => {
    const started = performance.now();
    expect(resolveFamilyName({ nameId1: `Inter${" ".repeat(200_000)}Bold` }, null).name).toBe("Inter");
    expect(resolveFamilyName({ nameId1: `Inter${" ".repeat(200_000)}x` }, null).name).toBe("Inter x");
    expect(resolveFamilyName({ nameId1: `${"a ".repeat(100_000)}x`, postscriptName: "-".repeat(100_000) }, `${"__a_".repeat(50_000)}`).name).toBe("__a_".repeat(50_000));
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("keeps the CSS name and reports an unrelated embedded name", () => {
    expect(resolveFamilyName({ nameId1: "Source Sans 3" }, "Brand Serif")).toEqual({
      name: "Brand Serif",
      basis: "css (binary name unrelated)",
      embeddedName: "Source Sans 3",
    });
  });

  it("falls back to the PostScript family and to the binary for generic or missing CSS families", () => {
    expect(resolveFamilyName({ postscriptName: "BerkeleyMono-Regular" }, null).name).toBe("Berkeley Mono");
    expect(resolveFamilyName({ typoFamily: "Inter" }, "sans-serif").name).toBe("Inter");
    expect(resolveFamilyName(null, null).name).toBe("(unknown)");
  });
});

describe("CSS family helpers", () => {
  it("cleans Next.js and build hash mangling", () => {
    expect(cleanCssFamily("__Inter_d65c78")).toBe("Inter");
    expect(cleanCssFamily("__Inter_Fallback_d65c78")).toBe("Inter");
    expect(cleanCssFamily("__IBM_Plex_Mono_a1b2c3")).toBe("IBM Plex Mono");
    expect(cleanCssFamily("Brand Serif")).toBe("Brand Serif");
    expect(isMangledCssFamily("__Inter_d65c78")).toBe(true);
    expect(isMangledCssFamily("wfont_123abc")).toBe(true);
    expect(isMangledCssFamily("Inter")).toBe(false);
  });

  it("splits computed font stacks", () => {
    expect(splitFamilies(`"__Inter_d65c78", "__Inter_Fallback_d65c78", 'Brand, Serif', system-ui , sans-serif`)).toEqual([
      "__Inter_d65c78",
      "__Inter_Fallback_d65c78",
      "Brand, Serif",
      "system-ui",
      "sans-serif",
    ]);
    expect(splitFamilies("")).toEqual([]);
  });
});
