import { describe, expect, it } from "vitest";
import { binaryFamilyName, cleanCssFamily, GENERIC_FAMILIES, isMangledCssFamily, resolveFamilyName, splitFamilies, type NameMeta } from "./names";
import { growthFactor, LINEAR_GROWTH_BOUND, random } from "./testing";

/** discovery-lab/lib/fonts.mjs `resolveFamilyName`, verbatim apart from types: the reference implementation. */
function labResolveFamilyName(meta: NameMeta | null, cssFamily: string | null) {
  const STYLE_WORDS = /\s+(?:thin|hairline|extra ?light|ultra ?light|light|book|regular|normal|roman|medium|semi ?bold|demi ?bold|bold|extra ?bold|ultra ?bold|black|heavy|italic|oblique|\d{3})$/i;
  const BAD_NAME = /^(?:false|true|null|undefined|none|untitled|\.+|[-_ .]*)$|copyright|all rights reserved|licen[cs]e|trial|webfont|\(c\)|©|^[A-Z0-9]{16,}$/i;
  const deaccent = (x: string) => String(x || "").normalize("NFD").replace(/\p{M}/gu, "");
  const norm = (x: string) => deaccent(x).toLowerCase().replace(/[^a-z0-9]/g, "");
  const tokens = (x: string) => deaccent(x).replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 4);
  const css = cssFamily ? cleanCssFamily(cssFamily).replace(/\s+placeholder$/i, "") : null;
  const clean = (n: string | undefined) => (typeof n === "string" ? n.replace(/[\u0000-\u001f\u007f-\u009f\ufffd]/g, "").trim() : n);
  const valid = (n: string | undefined): n is string => {
    n = clean(n);
    return !!n && n.length >= 2 && n.length <= 48 && /\p{L}{2,}/u.test(n) && !BAD_NAME.test(n);
  };
  if (meta) for (const k of ["typoFamily", "wwsFamily", "nameId1", "postscriptName"] as const) meta = { ...meta, [k]: clean(meta[k]) };
  let bin: string | null = null;
  if (meta) {
    const psFamily = meta.postscriptName && valid(meta.postscriptName) ? meta.postscriptName.split("-")[0].replace(/([a-z])([A-Z])/g, "$1 $2") : null;
    for (const c of [meta.typoFamily, meta.wwsFamily, meta.nameId1 && meta.nameId1.replace(STYLE_WORDS, "").replace(STYLE_WORDS, ""), psFamily]) {
      if (valid(c ?? undefined)) {
        bin = c!.trim();
        break;
      }
    }
    if (bin && !meta.typoFamily) bin = bin.replace(STYLE_WORDS, "").trim();
  }
  if (!css || GENERIC_FAMILIES.has(css.toLowerCase())) return { name: bin || css || "(unknown)", basis: "binary" };
  if (!bin) return { name: css, basis: "css" };
  if (isMangledCssFamily(cssFamily)) return { name: bin, basis: "binary (css mangled)" };
  const nb = norm(bin);
  const nc = norm(css);
  if (nb === nc) return { name: bin, basis: "both" };
  if (nb.startsWith(nc)) return { name: css, basis: "css (binary adds style words)" };
  if (nc.includes(nb)) return { name: bin, basis: "binary (css is a renamed alias)" };
  const tb = new Set(tokens(bin));
  if (tokens(css).some((t) => tb.has(t) || nb.includes(t))) return { name: bin, basis: "binary (shared token)" };
  return { name: css, basis: "css (binary name unrelated)", embeddedName: bin };
}

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

  it("gives the same result as the lab implementation", () => {
    const next = random(20260916);
    const parts = [
      "Inter", "Mona Sans", "Söhne", "VF", "Geist", "TT", "Ripple", "a", "Regular", "Bold", "bold", "Extra Light", "ExtraLight",
      "extra  light", "Semi Bold", "Italic", "700", "Placeholder", "placeholder", "-", "_", ".", "Copyright", "d65c78",
      "0123456789abcdef", "__", "wf_", " ", "  ", "\t", "\u00a0", "\u007f",
    ];
    const text = () => Array.from({ length: Math.floor(next() * 6) }, () => parts[Math.floor(next() * parts.length)]).join("");
    const maybe = () => (next() < 0.3 ? undefined : text());
    for (let i = 0; i < 5_000; i += 1) {
      const meta = next() < 0.15 ? null : { typoFamily: maybe(), wwsFamily: maybe(), nameId1: maybe(), postscriptName: maybe() };
      const css = next() < 0.2 ? null : text();
      expect(resolveFamilyName(meta, css), JSON.stringify([meta, css])).toEqual(labResolveFamilyName(meta, css));
    }
  });

  it("stays linear on hostile names", async () => {
    const hostile = (size: number) => {
      const spaces = " ".repeat(size);
      return [
        resolveFamilyName({ nameId1: `Inter${spaces}Bold` }, null).name,
        resolveFamilyName({ nameId1: `Inter${spaces}x` }, null).name,
        resolveFamilyName({ nameId1: `${"a ".repeat(size / 2)}x`, postscriptName: "-".repeat(size / 2) }, "__a_".repeat(size / 4)).name,
        resolveFamilyName(null, `Brand${spaces}x`).name,
        resolveFamilyName(null, `Brand${spaces}Placeholder`).name,
      ];
    };
    // 48 characters at most for a binary name, as in the lab
    expect(hostile(200_000)).toEqual(["Inter", "(unknown)", "__a_".repeat(50_000), `Brand${" ".repeat(200_000)}x`, "Brand"]);
    expect(await growthFactor(hostile, 20_000)).toBeLessThan(LINEAR_GROWTH_BOUND);
  });

  it("keeps the CSS name and reports an unrelated embedded name", () => {
    expect(resolveFamilyName({ nameId1: "Source Sans 3" }, "Brand Serif")).toEqual({
      name: "Brand Serif",
      basis: "css (binary name unrelated)",
      embeddedName: "Source Sans 3",
    });
  });

  it("reads the binary family name on its own", () => {
    expect(binaryFamilyName({ nameId1: "Mona Sans ExtraLight Italic" })).toBe("Mona Sans");
    expect(binaryFamilyName({ typoFamily: "Inter Display", nameId1: "Inter Display Bold" })).toBe("Inter Display");
    expect(binaryFamilyName({ nameId1: "false", postscriptName: "false" })).toBeNull();
    expect(binaryFamilyName(null)).toBeNull();
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
