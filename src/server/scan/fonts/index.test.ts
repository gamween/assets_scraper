import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FontFamily } from "@/lib/contract";
import { SignLimitError } from "@/server/security/sign";
import type { CapturedFont, CapturedSheet, PostInput, RawCollectorOutput, Signer } from "../types";
import { parseFontBinary } from "./binary";
import { MAX_INLINE_BYTES, MAX_INLINE_FONTS } from "./files";
import { clearGoogleFontsCache } from "./google";
import { buildFontFamilies, isConvertibleFont } from "./index";
import { fakeGoogleFetch, growthFactor, LINEAR_GROWTH_BOUND } from "./testing";

vi.mock("./binary", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./binary")>();
  return { ...actual, parseFontBinary: vi.fn(actual.parseFontBinary) };
});

const signal = new AbortController().signal;
const bytes = (name: string) => readFileSync(path.join(process.cwd(), "tests/fixtures/site/assets", name));
const interMeta = parseFontBinary(bytes("__inter.woff2"));
const jbmMeta = parseFontBinary(bytes("jbm-cyr.woff2"));
const PAGE = "https://www.site.example/";

beforeEach(() => {
  clearGoogleFontsCache();
  vi.mocked(parseFontBinary).mockClear();
});

describe("isConvertibleFont", () => {
  it("is true for an open licence without any request", async () => {
    const fetch = fakeGoogleFetch([]);
    const meta = { format: "woff2" as const, nameId1: "Brand", licenseDescription: "This Font Software is licensed under the SIL Open Font License, Version 1.1" };
    expect(await isConvertibleFont(meta, { fetch, signal })).toBe(true);
    expect(fetch.calls).toHaveLength(0);
  });

  it("checks Google Fonts when the licence is unknown", async () => {
    const fetch = fakeGoogleFetch(["Inter"]);
    expect(await isConvertibleFont({ format: "woff2", nameId1: "Inter" }, { fetch, signal })).toBe(true);
    expect(await isConvertibleFont({ format: "woff2", nameId1: "Brand Sans" }, { fetch, signal })).toBe(false);
    expect(fetch.calls).toHaveLength(2);
  });

  it("is false for a commercial licence and for unreadable files", async () => {
    const fetch = fakeGoogleFetch(["Inter"]);
    const commercial = { format: "woff2" as const, nameId1: "Inter", copyright: "Copyright 2019 Klim Type Foundry", licenseUrl: "https://klim.co.nz/licences/" };
    expect(await isConvertibleFont(commercial, { fetch, signal })).toBe(false);
    expect(await isConvertibleFont(null, { fetch, signal })).toBe(false);
    expect(await isConvertibleFont({ format: "woff2", nameId1: "." }, { fetch, signal })).toBe(false);
    expect(fetch.calls).toHaveLength(0);
  });
});

type Parts = Partial<Pick<RawCollectorOutput, "fontFaces" | "fontStatuses" | "fontUsage">> & {
  fonts?: CapturedFont[];
  sheets?: CapturedSheet[];
  signer?: RecordingSigner;
  google?: string[];
  deadline?: number;
};

type RecordingSigner = Signer & { signed: string[] };

function signerThatSigns(max = Infinity): RecordingSigner {
  const signed: string[] = [];
  return {
    signed,
    sign(url) {
      if (signed.length >= max) throw new SignLimitError("too many signed URLs");
      signed.push(url);
      return `signed:${url}`;
    },
    get count() {
      return signed.length;
    },
  };
}

function inputOf(parts: Parts): PostInput {
  return {
    collector: {
      page: { title: "Site", baseUrl: PAGE, elementCount: 1 },
      candidates: [],
      svgs: [],
      fontFaces: parts.fontFaces ?? [],
      fontStatuses: parts.fontStatuses ?? [],
      fontUsage: parts.fontUsage ?? [],
      unreadableSheets: [],
      blobs: [],
      brandLinks: [],
      noise: {},
      stats: { elements: 1, ms: 1, truncated: false },
    },
    network: { images: [], fonts: parts.fonts ?? [], sheets: parts.sheets ?? [], bodyTimeouts: 0, skippedBodies: 0 },
    page: { requestedUrl: PAGE, finalUrl: PAGE, host: "www.site.example", siteName: "Site", title: "Site" },
    signer: parts.signer ?? signerThatSigns(),
    fetch: fakeGoogleFetch(parts.google ?? []),
    signal,
    deadline: parts.deadline ?? Date.now() + 10_000,
  };
}

async function build(parts: Parts) {
  const input = inputOf(parts);
  const { families } = await buildFontFamilies(input);
  for (const family of families) FontFamily.parse(family);
  const byName = new Map(families.map((family) => [family.name, family]));
  return { families, byName, fetch: input.fetch as ReturnType<typeof fakeGoogleFetch>, signer: input.signer as RecordingSigner };
}

const captured = (url: string, meta = interMeta, status = 200): CapturedFont => ({ url, status, contentType: "font/woff2", bytes: 1_000, meta });
const loaded = (family: string, weight = "400") => ({ family, weight, style: "normal", stretch: "normal", status: "loaded" as const });
const rule = (family: string, urls: (string | { url?: string; local?: string; format?: string })[], extra = {}) => ({
  family,
  src: urls.map((entry) => (typeof entry === "string" ? { url: entry } : entry)),
  weight: "400",
  style: "normal",
  baseUrl: PAGE,
  origin: "cssom" as const,
  ...extra,
});

describe("buildFontFamilies", () => {
  it("reads rules from captured cross-origin stylesheets and classifies Google Fonts and Adobe Fonts", async () => {
    const gstatic = "https://fonts.gstatic.com/s/inter/v13/latin.woff2";
    const typekit = "https://use.typekit.net/af/1a2b3c/000000000000000000017701/27/l?primer=7cdcb4&fvd=n4&v=3";
    const { byName, families, signer } = await build({
      sheets: [
        { url: "https://fonts.googleapis.com/css2?family=Inter", status: 200, cssText: `@font-face{font-family:'Inter';src:url(${gstatic}) format('woff2');unicode-range:U+0000-00FF}` },
        { url: "https://use.typekit.net/abc1def.css", status: 200, cssText: `@font-face{font-family:"argent-pixel-cf";src:url("${typekit}") format("woff2")}` },
        { url: "https://www.site.example/broken.css", status: 404, cssText: `@font-face{font-family:"Ghost";src:url(ghost.woff2)}` },
      ],
      fonts: [captured(gstatic), captured(typekit, null)],
      fontStatuses: [loaded("Inter"), loaded("argent-pixel-cf")],
      fontUsage: [
        { stack: "Inter, sans-serif", weight: "400", style: "normal", chars: 30 },
        { stack: '"argent-pixel-cf", serif', weight: "400", style: "normal", chars: 10 },
      ],
      google: ["Inter"],
    });
    expect(families.map((family) => family.name)).toEqual(["Inter", "argent-pixel-cf"]);
    expect(byName.get("Inter")).toMatchObject({
      source: "google-fonts",
      sourceHost: "fonts.gstatic.com",
      license: { kind: "open" },
      convertible: true,
      downloadable: true,
      googleFamily: "Inter",
      usage: 0.75,
    });
    expect(byName.get("argent-pixel-cf")).toMatchObject({
      source: "adobe-fonts",
      sourceHost: "use.typekit.net",
      license: { kind: "commercial" },
      convertible: false,
      downloadable: false,
      usage: 0.25,
    });
    // Adobe Fonts files are never offered for download, but the font row loads them for its specimen
    expect(byName.get("argent-pixel-cf")!.faces[0].files[0]).toMatchObject({ url: typekit, format: "woff2", proxy: `signed:${typekit}` });
    expect(signer.signed).toEqual([gstatic, typekit]);
  });

  it("groups captured files without a rule by binary name and ignores failed or unreadable captures", async () => {
    const url = "https://cdn.other.example/fonts/jbm.woff2";
    const { families } = await build({
      fonts: [captured(url, jbmMeta), captured("https://cdn.other.example/fonts/junk.woff2", null), captured("https://cdn.other.example/fonts/gone.woff2", interMeta, 404)],
      fontStatuses: [loaded("JetBrains Mono", "500")],
      fontUsage: [{ stack: '"JetBrains Mono", monospace', weight: "500", style: "normal", chars: 12 }],
    });
    expect(families).toHaveLength(1);
    expect(families[0]).toMatchObject({ name: "JetBrains Mono", cssFamilies: ["JetBrains Mono"], source: "third-party", sourceHost: "cdn.other.example", usedOnPage: true, usage: 1 });
    expect(families[0].faces).toEqual([
      { weight: "500", style: "normal", loaded: true, subfamily: "Medium", files: [{ url, proxy: `signed:${url}`, format: "woff2", bytes: 1_000, coversLatin: false }] },
    ]);
  });

  it("names captured files without a rule after the family the page registered them under", async () => {
    const inter = "https://cdn.site.example/f/inter.woff2";
    const unreadable = "https://cdn.site.example/f/brand.woff2";
    const { byName, families } = await build({
      // "Fallback" is declared by a local() rule, so it is not a registered family
      fontFaces: [rule("Fallback", [{ local: "Arial" }])],
      fonts: [captured(inter), captured(unreadable, null)],
      fontStatuses: [loaded("MyInter"), loaded("Brand Display"), loaded("Fallback")],
      fontUsage: [
        { stack: "MyInter, sans-serif", weight: "400", style: "normal", chars: 6 },
        { stack: "'Brand Display', Fallback", weight: "400", style: "normal", chars: 2 },
      ],
    });
    expect(families.map((family) => family.name)).toEqual(["Inter", "Brand Display"]);
    expect(byName.get("Inter")).toMatchObject({ cssFamilies: ["MyInter"], usedOnPage: true, usage: 0.75 });
    expect(byName.get("Brand Display")).toMatchObject({ cssFamilies: ["Brand Display"], usedOnPage: true, usage: 0.25, license: { kind: "unknown" } });
    expect(byName.get("Brand Display")!.faces).toEqual([
      { weight: "400", style: "normal", loaded: true, files: [{ url: unreadable, proxy: `signed:${unreadable}`, format: "woff2", bytes: 1_000, coversLatin: true }] },
    ]);

    // with two registered families left, an unreadable file cannot be named and is dropped
    const ambiguous = await build({
      fonts: [captured(unreadable, null)],
      fontStatuses: [loaded("Brand Display"), loaded("Brand Text")],
    });
    expect(ambiguous.families).toEqual([]);
  });

  it("merges CSS families that resolve to one name, keeps their faces apart and attributes Wix-style stacks", async () => {
    const { families } = await build({
      fontFaces: [rule("Inter", ["https://cdn.site.example/inter.woff2"]), rule("Inter Medium", ["https://cdn.site.example/inter-medium.woff2"])],
      fonts: [captured("https://cdn.site.example/inter.woff2"), captured("https://cdn.site.example/inter-medium.woff2")],
      fontStatuses: [loaded("Inter"), loaded("Inter Medium")],
      fontUsage: [
        { stack: "wfont_1a2b3c, 'Inter Medium', sans-serif", weight: "500", style: "normal", chars: 8 },
        { stack: "Helvetica, Arial", weight: "400", style: "normal", chars: 8 },
      ],
    });
    expect(families).toHaveLength(1);
    expect(families[0]).toMatchObject({ name: "Inter", cssFamilies: ["Inter", "Inter Medium"], source: "self-hosted", usage: 0.5 });
    expect(families[0].faces).toHaveLength(2);
  });

  it("parses only the data: URI source a rule picks", async () => {
    const font = bytes("jbm-cyr.woff2");
    const { families } = await build({
      fontFaces: [rule("Tiny", [{ url: `data:font/woff;base64,${Buffer.from("wOFF, not picked").toString("base64")}` }, { url: `data:font/woff2;base64,${font.toString("base64")}` }])],
    });
    expect(families[0].faces[0].files).toMatchObject([{ format: "woff2", bytes: font.length }]);
    expect(vi.mocked(parseFontBinary).mock.calls.map(([buffer]) => buffer.length)).toEqual([font.length]);
  });

  it("keeps percent-encoded data: URI fonts inline even when unused, and never signs them", async () => {
    const font = bytes("jbm-cyr.woff2");
    const encoded = [...font].map((byte) => (/[A-Za-z0-9]/.test(String.fromCharCode(byte)) ? String.fromCharCode(byte) : `%${byte.toString(16).padStart(2, "0")}`)).join("");
    const { families, signer, fetch } = await build({
      fontFaces: [rule("Tiny", [{ url: `data:application/font-woff2;charset=utf-8,${encoded}`, format: "woff2" }])],
      fontStatuses: [{ ...loaded("Tiny"), status: "unloaded" }],
    });
    expect(families).toHaveLength(1);
    expect(families[0]).toMatchObject({ name: "Tiny", source: "data-uri", usedOnPage: false, usage: 0, license: { kind: "open" }, convertible: true });
    expect(families[0].sourceHost).toBeUndefined();
    expect(families[0].faces[0]).toMatchObject({ loaded: false, subfamily: "Medium" });
    expect(families[0].faces[0].files).toEqual([
      { url: "", proxy: "", format: "woff2", bytes: font.length, coversLatin: false, inline: { mime: "font/woff2", base64: font.toString("base64") } },
    ]);
    expect(signer.signed).toEqual([]);
    expect(fetch.calls).toEqual([]);
  });

  it("lists data: URI sources only when their bytes are a font, typed by their signature", async () => {
    const font = bytes("jbm-cyr.woff2");
    const html = "<script>alert(1)</script>";
    const { byName, families } = await build({
      fontFaces: [
        rule("Script", [{ url: `data:text/html,${encodeURIComponent(html)}`, format: "woff2" }]),
        rule("Fallback", [{ url: `data:text/html;base64,${Buffer.from(html).toString("base64")}`, format: "woff2" }, { url: "https://www.site.example/f.woff", format: "woff" }]),
        rule("Mislabeled", [{ url: `data:text/html;base64,${font.toString("base64")}` }]),
      ],
    });
    expect(families.map((family) => family.name).sort()).toEqual(["Fallback", "Mislabeled"]);
    expect(byName.get("Fallback")!.faces[0].files).toEqual([{ url: "https://www.site.example/f.woff", proxy: "signed:https://www.site.example/f.woff", format: "woff", coversLatin: true }]);
    expect(byName.get("Mislabeled")!.faces[0].files[0]).toMatchObject({ format: "woff2", inline: { mime: "font/woff2", base64: font.toString("base64") } });
  });

  it("caps the data: URI fonts a scan decodes, parses and inlines, loaded faces first", async () => {
    const font = bytes("jbm-cyr.woff2");
    const count = MAX_INLINE_FONTS + 8;
    const { families } = await build({
      // Distinct URIs of the same bytes: faces 0 to 19 did not load, faces 20 to 39 did
      fontFaces: Array.from({ length: count }, (_, index) => rule(`Face ${index}`, [`data:font/woff2;v=${index};base64,${font.toString("base64")}`])),
      fontStatuses: Array.from({ length: count }, (_, index) => ({ ...loaded(`Face ${index}`), status: index < 20 ? ("unloaded" as const) : ("loaded" as const) })),
    });
    expect(families).toHaveLength(MAX_INLINE_FONTS);
    expect(families.filter((family) => family.usedOnPage)).toHaveLength(20);
    const unused = families.filter((family) => !family.usedOnPage).map((family) => family.name);
    expect(unused.sort()).toEqual(Array.from({ length: MAX_INLINE_FONTS - 20 }, (_, index) => `Face ${index}`).sort());
    expect(vi.mocked(parseFontBinary)).toHaveBeenCalledTimes(MAX_INLINE_FONTS);

    // A file past the byte budget is not decoded twice nor parsed, and the rule falls back to its next source
    vi.mocked(parseFontBinary).mockClear();
    const huge = Buffer.concat([Buffer.from("wOF2"), Buffer.alloc(MAX_INLINE_BYTES)]);
    const capped = await build({
      fontFaces: [
        rule("Huge", [{ url: `data:font/woff2;base64,${huge.toString("base64")}` }, { url: "https://www.site.example/huge.woff", format: "woff" }]),
        rule("Tiny", [`data:font/woff2;base64,${font.toString("base64")}`]),
      ],
    });
    expect(capped.byName.get("Huge")!.faces[0].files).toMatchObject([{ url: "https://www.site.example/huge.woff", format: "woff" }]);
    expect(capped.byName.get("Tiny")!.faces[0].files).toMatchObject([{ url: "", bytes: font.length, inline: { base64: font.toString("base64") } }]);
    expect(vi.mocked(parseFontBinary).mock.calls.map(([buffer]) => buffer.length)).toEqual([font.length]);
  });

  it("reads at most 5,000 rules from the CSSOM and 5,000 from captured stylesheets", async () => {
    const face = (index: number) => rule("Face", [`https://www.site.example/${index}.woff2`]);
    const sheet = Array.from({ length: 5_001 }, (_, index) => `@font-face{font-family:Face;src:url(/s${index}.woff2)}`).join("");
    const { families } = await build({
      fontFaces: Array.from({ length: 5_001 }, (_, index) => face(index)),
      sheets: [
        { url: "https://www.site.example/a.css", status: 200, cssText: sheet },
        { url: "https://www.site.example/b.css", status: 200, cssText: "@font-face{font-family:Face;src:url(/more.woff2)}" },
      ],
    });
    const urls = families[0].faces[0].files.map((file) => file.url);
    expect(urls).toHaveLength(10_000);
    expect(urls).not.toContain("https://www.site.example/5000.woff2");
    expect(urls).not.toContain("https://www.site.example/s5000.woff2");
    expect(urls).not.toContain("https://www.site.example/more.woff2");
  });

  it("stays linear on hostile collector output", async () => {
    const long = "Face".repeat(25);
    const hostile: Record<string, (size: number) => Parts> = {
      // every rule against every document.fonts status of its family
      statuses: (size) => ({
        fontFaces: Array.from({ length: size }, (_, index) => rule(long, [`${PAGE}${index}.woff2`], { weight: String(index) })),
        fontStatuses: Array.from({ length: size }, (_, index) => loaded(long, `w${index}`)),
      }),
      // CSS families that clean to one name: every new one against the ones already kept
      variants: (size) => ({ fontFaces: Array.from({ length: size }, (_, index) => rule(`__${"Inter".repeat(40)}_${index.toString(16).padStart(6, "0")}`, [`${PAGE}${index}.woff2`])) }),
      // every binary name of a file without a rule against every registered family
      undeclared: (size) => ({
        fonts: Array.from({ length: size }, (_, index) => captured(`${PAGE}u${index}.woff2`, { format: "woff2", nameId1: `Name ${index} Sans` })),
        fontStatuses: Array.from({ length: size }, (_, index) => loaded(`Registered ${index}`)),
      }),
      // family names that give the same id
      ids: (size) => ({ fontFaces: Array.from({ length: size }, (_, index) => rule(String.fromCharCode(0x4e00 + index), [`${PAGE}${index}.woff2`])) }),
    };
    // 600 grows to 4,800, under the cap of 5,000 CSSOM rules; binary names and registered families are capped at 128
    for (const [name, parts] of Object.entries(hostile)) {
      const factor = await growthFactor((size) => buildFontFamilies(inputOf(parts(size))), name === "undeclared" ? 300 : 600);
      expect.soft(factor, name).toBeLessThan(LINEAR_GROWTH_BOUND);
    }
  }, 60_000);

  it("lists the loaded source of a rule, else its best declared format, and skips local() only rules", async () => {
    const base = "https://www.site.example/f/";
    const { byName } = await build({
      fontFaces: [
        rule("Multi", [{ local: "Multi" }, { url: `${base}multi.ttf`, format: "truetype" }, { url: `${base}multi.woff2`, format: "woff2" }, { url: `${base}multi.eot` }]),
        rule("Loaded", [{ url: `${base}loaded.woff2`, format: "woff2" }, { url: `${base}loaded.woff`, format: "woff" }]),
        rule("__Inter_Fallback_d65c78", [{ local: "Arial" }]),
      ],
      fonts: [captured(`${base}loaded.woff`, { ...interMeta!, format: "woff" })],
    });
    // "Loaded" has no characters but its file loaded, so it is used and sorts first
    expect([...byName.keys()]).toEqual(["Loaded", "Multi"]);
    expect(byName.get("Loaded")).toMatchObject({ usedOnPage: true, usage: 0, faces: [{ loaded: true }] });
    expect(byName.get("Loaded")!.faces[0].files.map((file) => [file.url, file.format])).toEqual([[`${base}loaded.woff`, "woff"]]);
    expect(byName.get("Multi")).toMatchObject({ usedOnPage: false, faces: [{ loaded: false }] });
    expect(byName.get("Multi")!.faces[0].files.map((file) => [file.url, file.format])).toEqual([[`${base}multi.woff2`, "woff2"]]);
  });

  it("stops signing at the signing cap without failing, loaded files first and Adobe Fonts files last", async () => {
    const [declared, loadedFace, loadedFile] = ["a", "b", "c"].map((name) => `https://www.site.example/${name}.woff2`);
    const typekit = "https://use.typekit.net/af/1a2b3c/000000000000000000017701/27/l?fvd=n4&v=3";
    const parts: Parts = {
      fontFaces: [
        rule("Kit", [typekit]),
        rule("Face", [declared], { weight: "300" }),
        rule("Face", [loadedFace], { weight: "400" }),
        rule("Face", [loadedFile], { weight: "700" }),
      ],
      fonts: [captured(typekit, null), captured(loadedFile)],
      fontStatuses: [loaded("Face", "400"), loaded("Kit")],
    };
    const { byName, families, signer } = await build({ ...parts, signer: signerThatSigns(2) });
    expect(families.map((family) => family.name)).toEqual(["Kit", "Face"]);
    expect(signer.signed).toEqual([loadedFile, loadedFace]);
    expect(byName.get("Face")!.faces.map((face) => [face.weight, face.loaded, face.files[0].proxy])).toEqual([
      ["300", false, ""],
      ["400", true, `signed:${loadedFace}`],
      ["700", true, `signed:${loadedFile}`],
    ]);
    expect(byName.get("Kit")!.faces[0].files[0].proxy).toBe("");

    const all = await build({ ...parts, signer: signerThatSigns(4) });
    expect(all.signer.signed).toEqual([loadedFile, loadedFace, declared, typekit]);
  });

  it("checks Google Fonts for the first 8 used families, a renamed font by its embedded name only", async () => {
    const faces = Array.from({ length: 9 }, (_, index) => rule(index ? `Face ${index}` : "Brand Serif", [`https://www.site.example/${index}.woff2`]));
    const { byName, fetch } = await build({
      fontFaces: faces,
      fonts: [captured("https://www.site.example/0.woff2")],
      fontStatuses: faces.map((face) => loaded(face.family)),
      fontUsage: faces.map((face, index) => ({ stack: face.family, weight: "400", style: "normal", chars: 20 - index })),
      google: ["Inter"],
    });
    expect(byName.get("Brand Serif")).toMatchObject({ googleFamily: "Inter" });
    expect(fetch.calls.map((call) => new URL(call.url).searchParams.get("family"))).toEqual(["Inter", ...Array.from({ length: 7 }, (_, index) => `Face ${index + 1}`)]);
  });

  it("does not take the Google Fonts match of a CSS name for a binary that names another font", async () => {
    const url = "https://www.site.example/lato.woff2";
    const { families, fetch } = await build({
      fontFaces: [rule("Lato", [url])],
      fonts: [captured(url, { format: "woff2", nameId1: "Proxima Nova" })],
      fontStatuses: [loaded("Lato")],
      google: ["Lato"],
    });
    expect(families[0]).toMatchObject({ name: "Lato", license: { kind: "unknown" }, convertible: false });
    expect(families[0].googleFamily).toBeUndefined();
    expect(fetch.calls.map((call) => new URL(call.url).searchParams.get("family"))).toEqual(["Proxima Nova"]);
  });

  it("offers TTF for an unknown licence only when Google Fonts knows the family, and skips the check past the deadline", async () => {
    const parts: Parts = {
      fontFaces: [rule("Lato", ["https://www.site.example/lato.woff2"])],
      fontStatuses: [loaded("Lato")],
      fontUsage: [{ stack: "Lato", weight: "400", style: "normal", chars: 4 }],
      google: ["Lato"],
    };
    const matched = await build(parts);
    expect(matched.families[0]).toMatchObject({ license: { kind: "unknown" }, googleFamily: "Lato", convertible: true });

    clearGoogleFontsCache();
    const late = await build({ ...parts, deadline: Date.now() - 1 });
    expect(late.fetch.calls).toEqual([]);
    expect(late.families[0].googleFamily).toBeUndefined();
    expect(late.families[0].convertible).toBe(false);
  });
});
