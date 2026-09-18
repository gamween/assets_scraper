import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { googleFontsUrl } from "@/components/results/font-actions";
import { FontFamily } from "@/lib/contract";
import { createSigner, SignLimitError } from "@/server/security/sign";
import type { CapturedFont, CapturedSheet, FontBinaryMeta, PostInput, RawCollectorOutput, Signer } from "../types";
import { parseFontBinary } from "./binary";
import { MAX_DESCRIPTOR_CHARS, MAX_UNICODE_RANGE_CHARS, normalizeStretch, normalizeStyle, normalizeWeight } from "./css";
import { MAX_INLINE_BYTES, MAX_INLINE_FONTS, MAX_URL_CHARS } from "./files";
import { clearGoogleFontsCache } from "./google";
import { buildFontFamilies, isConvertibleFont, signFontFiles } from "./index";
import { fakeGoogleFetch, fastestMs, growthFactor, LINEAR_GROWTH_BOUND } from "./testing";
import { coversBasicLatin } from "./unicode";

vi.mock("./binary", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./binary")>();
  return { ...actual, parseFontBinary: vi.fn(actual.parseFontBinary) };
});
// Records the descriptors this module normalizes and parses, to show which ones it skips first
vi.mock("./css", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./css")>();
  return { ...actual, normalizeWeight: vi.fn(actual.normalizeWeight), normalizeStyle: vi.fn(actual.normalizeStyle), normalizeStretch: vi.fn(actual.normalizeStretch) };
});
vi.mock("./unicode", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./unicode")>();
  return { ...actual, coversBasicLatin: vi.fn(actual.coversBasicLatin) };
});

const signal = new AbortController().signal;
const bytes = (name: string) => readFileSync(path.join(process.cwd(), "tests/fixtures/site/assets", name));
const interMeta = parseFontBinary(bytes("__inter.woff2"));
const jbmMeta = parseFontBinary(bytes("jbm-cyr.woff2"));
const PAGE = "https://www.site.example/";
const MIB = 1024 * 1024;

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
  // As the engine does once the assets are signed
  const capped = signFontFiles(families, input.signer);
  for (const family of families) FontFamily.parse(family);
  const byName = new Map(families.map((family) => [family.name, family]));
  return { families, byName, capped, fetch: input.fetch as ReturnType<typeof fakeGoogleFetch>, signer: input.signer as RecordingSigner };
}

/**
 * The length of the longest string key given to a `Map` or a `Set` while `task` runs. V8 hashes a string of 16,384
 * characters or more by its length alone, so such keys of one length collide.
 */
async function longestKeyDuring(task: () => Promise<unknown>): Promise<number> {
  let longest = 0;
  const restores = [Map.prototype, Set.prototype].flatMap((prototype) =>
    (["get", "has", "set", "add", "delete"] as const)
      .filter((name) => Object.hasOwn(prototype, name))
      .map((name) => {
        const original = Reflect.get(prototype, name) as (this: unknown, key: unknown, ...rest: unknown[]) => unknown;
        const recording = function (this: unknown, key: unknown, ...rest: unknown[]) {
          if (typeof key === "string" && key.length > longest) longest = key.length;
          return original.call(this, key, ...rest);
        };
        Object.defineProperty(prototype, name, { value: recording });
        return () => Object.defineProperty(prototype, name, { value: original });
      }),
  );
  try {
    await task();
  } finally {
    for (const restore of restores) restore();
  }
  return longest;
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

  it("matches registered families of 256 characters at most, even ones that would resolve to the binary name", async () => {
    // Wix-style families are machine-generated, so they resolve to the binary name whatever their length
    const wix = (length: number) => `wf_${"0".repeat(length - 3)}`;
    const { families } = await build({ fonts: [captured("https://cdn.site.example/f/inter.woff2")], fontStatuses: [loaded(wix(256)), loaded(wix(257))] });
    expect(families).toHaveLength(1);
    expect(families[0]).toMatchObject({ name: "Inter", cssFamilies: [wix(256)] });
  });

  it("decodes families from the CSSOM and document.fonts as the browser reads them", async () => {
    const declared = "https://www.site.example/quote.woff2";
    const unreadable = "https://www.site.example/unreadable.woff2";
    // `font-family:"a\"b "`: the CSSOM gives `"a\"b "`, which collectors may pass without its quotes, and document.fonts
    // gives `a"b `. Read apart, `a"b ` was a family without a rule, which took the unreadable capture.
    for (const family of [`"a\\"b "`, `a\\"b `]) {
      const { families } = await build({ fontFaces: [rule(family, [declared])], fonts: [captured(unreadable, null)], fontStatuses: [loaded(`a"b `)] });
      expect(families).toHaveLength(1);
      expect(families[0]).toMatchObject({ name: `a"b `, cssFamilies: [`a"b `], usedOnPage: true, faces: [{ loaded: true, files: [{ url: declared }] }] });
    }
    // Captured stylesheets give families decoded, and a face made with the FontFace constructor gives a CSS string
    const { byName } = await build({
      sheets: [{ url: `${PAGE}a.css`, status: 200, cssText: `@font-face{font-family:"\\"q\\"";src:url(q.woff2)}` }],
      fonts: [captured(unreadable, null)],
      fontStatuses: [loaded(`"My \\"Font\\""`)],
    });
    expect([...byName.keys()].sort()).toEqual([`"q"`, `My "Font"`]);
  });

  it("skips collector entries of other types, which a page can return through the main-world collector", async () => {
    const url = "https://www.site.example/ok.woff2";
    const junk = (entries: unknown[]) => entries as never[];
    const usage = (stack: unknown, chars: unknown) => ({ stack, weight: "400", style: "normal", chars });
    const { families } = await build({
      fontFaces: junk([
        null,
        7,
        { ...rule("Bad", [url]), family: 5 },
        { ...rule("Bad", [url]), src: "url(bad.woff2)" },
        { ...rule("Bad", [url]), weight: 700 },
        rule("Ok", junk([null, { url: 5 }, { url, format: 7 }])),
      ]),
      fontStatuses: junk([null, { ...loaded("Ok"), family: ["Ok"] }, { ...loaded("Ok"), weight: 400 }, loaded("Ok")]),
      fontUsage: junk([null, usage(5, 3), usage("Ok", "7"), usage("Ok", 1e300), usage("Ok", 4)]),
    });
    expect(families).toHaveLength(1);
    expect(families[0]).toMatchObject({ name: "Ok", usedOnPage: true, usage: 1, faces: [{ loaded: true, files: [{ url, format: "woff2" }] }] });
  });

  it("gives a registered family to a file without a rule only when it resolves to no other name", async () => {
    // A Wix-style family resolves to any binary name: both files took it, and the last one all of its usage
    const wix = "wf_1a2b3c4d5e6f7a8b9c";
    const files = [captured("https://cdn.site.example/f/inter.woff2"), captured("https://cdn.site.example/f/jbm.woff2", jbmMeta)];
    const usage = [{ stack: `${wix}, sans-serif`, weight: "400", style: "normal", chars: 100 }];
    const { families } = await build({ fonts: files, fontStatuses: [loaded(wix)], fontUsage: usage });
    expect(families.map((family) => [family.name, family.cssFamilies, family.usage])).toEqual([
      ["Inter", [], 0],
      ["JetBrains Mono", [], 0],
    ]);
    // Files that share a name still take it, and one that resolves to a single name keeps its usage
    const shared = await build({ fonts: [files[0], captured("https://cdn.site.example/f/inter-bold.woff2")], fontStatuses: [loaded(wix)], fontUsage: usage });
    expect(shared.families.map((family) => [family.name, family.cssFamilies, family.usage])).toEqual([["Inter", [wix], 1]]);
    const renamed = await build({ fonts: files, fontStatuses: [loaded(wix), loaded("MyInter")], fontUsage: [{ ...usage[0], stack: "MyInter" }] });
    expect(renamed.families.map((family) => [family.name, family.cssFamilies, family.usage])).toEqual([
      ["Inter", ["MyInter"], 1],
      ["JetBrains Mono", [], 0],
    ]);
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

  it("never makes a family with an Adobe Fonts file downloadable, even merged with files from other hosts", async () => {
    const selfHosted = "https://www.site.example/proxima.woff2";
    const typekit = "https://use.typekit.net/af/abc/l?fvd=n4&v=3";
    const proxima = { format: "woff2" as const, nameId1: "Proxima Nova" };
    const { families } = await build({
      fontFaces: [rule("Proxima Nova", [selfHosted]), rule("proxima-nova", [typekit])],
      fonts: [captured(selfHosted, proxima), captured(typekit, proxima)],
      fontStatuses: [loaded("Proxima Nova"), loaded("proxima-nova")],
    });
    expect(families).toHaveLength(1);
    expect(families[0]).toMatchObject({
      name: "Proxima Nova",
      cssFamilies: ["Proxima Nova", "proxima-nova"],
      source: "adobe-fonts",
      sourceHost: "use.typekit.net",
      license: { kind: "commercial" },
      convertible: false,
      downloadable: false,
    });
    expect(families[0].faces.flatMap((face) => face.files.map((file) => file.url))).toEqual([selfHosted, typekit]);
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

  it("skips data: URIs from the CSSOM estimated over 4 MiB or longer serialized than written, as stylesheets do", async () => {
    const font = bytes("jbm-cyr.woff2").toString("base64");
    const fallback = `${PAGE}fallback.woff2`;
    const { byName } = await build({
      fontFaces: [
        rule("Kept", [`data:font/woff2;base64,${font}`]),
        // Base64 decoding skips the accented letter, which URL.parse writes as 6 characters
        rule("Accented", [`data:font/woff2;base64,${font}\u00e9`, fallback]),
        rule("Large", [`data:font/woff2,wOF2${"A".repeat(MAX_INLINE_BYTES - 3)}`, fallback]),
      ],
    });
    expect(byName.get("Kept")!.faces[0].files).toMatchObject([{ url: "", format: "woff2", bytes: 1_172 }]);
    for (const family of ["Accented", "Large"]) expect(byName.get(family)!.faces[0].files.map((file) => file.url), family).toEqual([fallback]);
  });

  it("keys no Map or Set by a data: URI over 8 KiB, and lists a data: URI font found in the CSSOM and a stylesheet once", async () => {
    // Grouping 7,552 distinct data: URIs of 16,400 characters, all hashed alike, took 54 seconds: each insert in the
    // files of a scan, and in its declared URLs, compared the URI with every earlier one
    const font = bytes("jbm-cyr.woff2");
    const payload = Buffer.concat([font, Buffer.alloc(12_300 - font.length)]).toString("base64");
    const uri = (index: number) => `data:font/woff2;v=${String(index).padStart(2, "0")};base64,${payload}`;
    const faces = Array.from({ length: 8 }, (_, index) => `Face ${index}`);
    let families: FontFamily[] = [];
    const longest = await longestKeyDuring(async () => {
      ({ families } = await build({
        fontFaces: faces.map((face, index) => rule(face, [uri(index), uri(index + 8)])),
        sheets: [{ url: `${PAGE}a.css`, status: 200, cssText: faces.map((face, index) => `@font-face{font-family:"${face}";src:url(${uri(index)})}`).join("") }],
      }));
    });
    expect(uri(0).length).toBeGreaterThan(16_384);
    expect(longest).toBeLessThanOrEqual(MAX_URL_CHARS);
    expect(families.map((family) => family.name).sort()).toEqual(faces);
    for (const family of families) expect(family.faces.flatMap((face) => face.files), family.name).toMatchObject([{ url: "", format: "woff2", bytes: 12_300 }]);
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

  it("reads at most 16 sources of a rule from the CSSOM or a captured stylesheet, however many it lists", async () => {
    const urls = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => `${PAGE}${prefix}${index}.woff2`);
    const { byName } = await build({
      fontFaces: [rule("Cssom", urls("c", 1_000))],
      sheets: [{ url: `${PAGE}a.css`, status: 200, cssText: `@font-face{font-family:Sheet;src:${urls("s", 1_000).map((url) => `url(${url})`).join(",")}}` }],
      // The 17th source of each rule loaded: past the cap, it is a file without a rule, named by its binary
      fonts: [captured(`${PAGE}c16.woff2`), captured(`${PAGE}s16.woff2`, jbmMeta)],
    });
    expect([...byName.keys()].sort()).toEqual(["Cssom", "Inter", "JetBrains Mono", "Sheet"]);
    for (const [family, url] of [["Cssom", `${PAGE}c0.woff2`], ["Sheet", `${PAGE}s0.woff2`], ["Inter", `${PAGE}c16.woff2`], ["JetBrains Mono", `${PAGE}s16.woff2`]]) {
      expect(byName.get(family)!.faces.flatMap((face) => face.files.map((file) => file.url)), family).toEqual([url]);
    }

    // Past the cap, a CSSOM rule that lists more sources costs nothing more: its other entries are never read
    const read = new Set<string>();
    const src = new Proxy(rule("Face", urls("f", 160_000)).src, {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key)) read.add(key);
        return Reflect.get(target, key, receiver);
      },
    });
    const { families } = await buildFontFamilies(inputOf({ fontFaces: [{ ...rule("Face", []), src }] }));
    expect(families.map((family) => family.name)).toEqual(["Face"]);
    expect([...read]).toEqual(Array.from({ length: 16 }, (_, index) => String(index)));
  });

  it("lists no file whose URL is over 8 KiB, from the CSSOM, a stylesheet or a capture, and resolves only absolute URLs against a longer base URL", async () => {
    // Absolute URLs of `length` characters
    const url = (length: number, char: string) => `${PAGE}${char.repeat(length - PAGE.length)}`;
    const longBase = `${PAGE}?${"q".repeat(MAX_URL_CHARS)}`;
    const { byName } = await build({
      fontFaces: [rule("CssomAt", [url(MAX_URL_CHARS, "c")]), rule("CssomOver", [url(MAX_URL_CHARS + 1, "c")]), rule("CssomBase", ["relative.woff2", `${PAGE}cssom.woff2`], { baseUrl: longBase })],
      sheets: [
        { url: `${PAGE}a.css`, status: 200, cssText: `@font-face{font-family:SheetAt;src:url(${url(MAX_URL_CHARS, "s")})}@font-face{font-family:SheetOver;src:url(${url(MAX_URL_CHARS + 1, "s")})}` },
        { url: longBase, status: 200, cssText: `@font-face{font-family:SheetBase;src:url(relative.woff2),url(${PAGE}sheet.woff2)}` },
      ],
      // Files without a rule, named by their binaries
      fonts: [captured(url(MAX_URL_CHARS, "i")), captured(url(MAX_URL_CHARS + 1, "j"), jbmMeta)],
    });
    const files = Object.fromEntries([...byName].map(([name, family]) => [name, family.faces.flatMap((face) => face.files.map((file) => file.url))]));
    expect(files).toEqual({
      CssomAt: [url(MAX_URL_CHARS, "c")],
      CssomBase: [`${PAGE}cssom.woff2`],
      SheetAt: [url(MAX_URL_CHARS, "s")],
      SheetBase: [`${PAGE}sheet.woff2`],
      Inter: [url(MAX_URL_CHARS, "i")],
    });
  });

  it("stops reading captured stylesheets once the scan deadline passes or the scan is aborted", async () => {
    const sheet = (family: string): CapturedSheet => ({ url: `${PAGE}${family}.css`, status: 200, cssText: `@font-face{font-family:${family};src:url(/${family}.woff2)}` });
    const late = await build({ fontFaces: [rule("Cssom", [`${PAGE}c.woff2`])], sheets: [sheet("Sheet")], deadline: Date.now() - 1 });
    expect(late.families.map((family) => family.name)).toEqual(["Cssom"]);

    // Aborted while the first stylesheet is read: the next one is not
    const controller = new AbortController();
    const { cssText, ...first } = sheet("First");
    const input = inputOf({
      sheets: [
        Object.defineProperty({ ...first, cssText: "" }, "cssText", {
          get: () => {
            controller.abort();
            return cssText;
          },
        }),
        sheet("Second"),
      ],
    });
    const { families } = await buildFontFamilies({ ...input, signal: controller.signal });
    expect(families.map((family) => family.name)).toEqual(["First"]);
  });

  it("skips families longer than 1,024 characters from the CSSOM and document.fonts before decoding them", async () => {
    const quoted = (length: number, char: string) => `"${char.repeat(length - 2)}"`;
    const rules = await build({ fontFaces: [rule(quoted(1_024, "a"), [`${PAGE}a.woff2`]), rule(quoted(1_025, "b"), [`${PAGE}b.woff2`])] });
    expect(rules.families.map((family) => family.name)).toEqual(["a".repeat(1_022)]);
    // A registered family names an unreadable capture when it is the only one left
    const unreadable = captured(`${PAGE}unreadable.woff2`, null);
    const registered = async (family: string) => (await build({ fonts: [unreadable], fontStatuses: [loaded(family)] })).families.map((entry) => entry.name);
    expect(await registered("c".repeat(1_024))).toEqual(["c".repeat(1_024)]);
    expect(await registered(quoted(1_024, "d"))).toEqual(["d".repeat(1_022)]);
    expect(await registered("e".repeat(1_025))).toEqual([]);
    expect(await registered(quoted(1_025, "f"))).toEqual([]);
  });

  it("skips rules and document.fonts statuses whose weight, style or stretch is over 256 characters, or unicode range over 64 KiB, before normalizing them", async () => {
    const fields = { weight: ["font-weight", "100 900"], style: ["font-style", "italic"], stretch: ["font-stretch", "75%"], unicodeRange: ["unicode-range", "U+0-FF"] } as const;
    const maxOf = (field: string) => (field === "unicodeRange" ? MAX_UNICODE_RANGE_CHARS : MAX_DESCRIPTOR_CHARS);
    for (const [field, [descriptor, value]] of Object.entries(fields)) {
      // `value` padded with spaces to `length` characters, from the CSSOM and from a captured stylesheet
      const face = (family: string, length: number) => rule(family, [`${PAGE}${family}.woff2`], { [field]: value.padEnd(length) });
      const css = (family: string, length: number) => `@font-face{font-family:${family};src:url(/${family}.woff2);${descriptor}:${value.padEnd(length)}}`;
      const max = maxOf(field);
      const { families } = await build({
        fontFaces: [face("CssomAt", max), face("CssomOver", max + 1)],
        sheets: [{ url: `${PAGE}a.css`, status: 200, cssText: css("SheetAt", max) + css("SheetOver", max + 1) }],
      });
      expect(families.map((family) => family.name).sort(), field).toEqual(["CssomAt", "SheetAt"]);
    }
    // A registered family names an unreadable capture when it is the only one left
    const unreadable = captured(`${PAGE}unreadable.woff2`, null);
    for (const field of ["weight", "style", "stretch"]) {
      const registered = async (length: number) =>
        (await build({ fonts: [unreadable], fontStatuses: [{ ...loaded("Registered"), [field]: "normal".padEnd(length) }] })).families.map((family) => family.name);
      expect(await registered(MAX_DESCRIPTOR_CHARS), field).toEqual(["Registered"]);
      expect(await registered(MAX_DESCRIPTOR_CHARS + 1), field).toEqual([]);
    }

    // One 15 MB `font-weight` took 2.3 seconds and 1.3 GB to normalize, and 16 of them ran out of memory, whether from
    // a stylesheet, the CSSOM or document.fonts. Such values are never normalized, parsed or sent.
    const normalizers = [normalizeWeight, normalizeStyle, normalizeStretch, coversBasicLatin].map((fn) => vi.mocked(fn));
    for (const fn of normalizers) fn.mockClear();
    const long = "1 ".repeat(MIB / 2);
    const { families } = await build({
      sheets: [{ url: `${PAGE}a.css`, status: 200, cssText: Object.values(fields).map(([descriptor]) => `@font-face{font-family:Sheet;src:url(/s.woff2);${descriptor}:${long}}`).join("") }],
      fontFaces: [rule("Kept", [`${PAGE}kept.woff2`], { unicodeRange: "U+0-FF" }), ...Object.keys(fields).map((field) => rule("Cssom", [`${PAGE}c.woff2`], { [field]: long }))],
      fontStatuses: ["weight", "style", "stretch"].map((field) => ({ ...loaded("Kept"), [field]: long })),
    });
    expect(families.map((family) => family.name)).toEqual(["Kept"]);
    for (const [index, fn] of normalizers.entries()) {
      const lengths = fn.mock.calls.map(([text]) => text?.length ?? 0);
      expect(lengths.length, fn.getMockName()).toBeGreaterThan(0);
      expect(Math.max(...lengths), fn.getMockName()).toBeLessThanOrEqual(index === 3 ? MAX_UNICODE_RANGE_CHARS : MAX_DESCRIPTOR_CHARS);
    }
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

  it("groups and names fonts in time that barely grows with the length of names", async () => {
    // Each pair of a binary name and a registered family read the file's name records again, in time that also grew
    // with the family's length: 128 names against 128 families of 50 KB took seconds, where no deadline can stop it
    const inputs = (length: number) => {
      const long = "x".repeat(length);
      // typoFamily, wwsFamily and postscriptName are too long to be names, so each file is named by nameId1
      const meta = (index: number, records: string): FontBinaryMeta => ({ format: "woff2", nameId1: `Name ${index} Sans`, typoFamily: records, wwsFamily: records, postscriptName: records });
      const undeclared = (records: string) => Array.from({ length: 128 }, (_, index) => captured(`${PAGE}u${index}.woff2`, meta(index, records)));
      const sheet = Array.from({ length: 5_000 }, (_, index) => `@font-face{font-family:Sheet${index};src:url(/one.woff2)}`).join("");
      return [
        // families registered without a rule
        inputOf({ fonts: undeclared("x".repeat(60)), fontStatuses: Array.from({ length: 128 }, (_, index) => loaded(`${long}Registered ${index}`)) }),
        // name records of files without a rule
        inputOf({ fonts: undeclared(long), fontStatuses: Array.from({ length: 128 }, (_, index) => loaded(`Registered ${index}`)) }),
        // name records of one file under 10,000 rules of distinct families, from the CSSOM and a captured sheet
        inputOf({
          fontFaces: Array.from({ length: 5_000 }, (_, index) => rule(`Face ${index}`, [`${PAGE}one.woff2`])),
          sheets: [{ url: `${PAGE}a.css`, status: 200, cssText: sheet }],
          fonts: [captured(`${PAGE}one.woff2`, meta(0, long))],
        }),
      ];
    };
    const short = inputs(60);
    const long = inputs(60_000);
    const results = [];
    for (const input of long) results.push(await buildFontFamilies(input));
    expect(results.map(({ families }) => families.length)).toEqual([128, 128, 10_000]);
    // Registered families past the length cap are not matched
    expect(results[0].families.flatMap((family) => family.cssFamilies)).toEqual([]);

    const run = (batch: PostInput[]) => async () => {
      for (const input of batch) await buildFontFamilies(input);
    };
    await run(short)();
    // About 1.5 here, and 15 to 90 with any part of the fix undone: 1,000 times longer names cost the time of reading them
    expect((await fastestMs(run(long))) / (await fastestMs(run(short)))).toBeLessThan(5);
  }, 120_000);

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

  it("leaves signing to signFontFiles: every file comes out with an empty proxy", async () => {
    const url = "https://www.site.example/a.woff2";
    const input = inputOf({ fontFaces: [rule("Face", [url])], fonts: [captured(url)], fontStatuses: [loaded("Face")] });
    const { families } = await buildFontFamilies(input);
    expect(families[0].faces[0].files.map((file) => [file.url, file.proxy])).toEqual([[url, ""]]);
    expect((input.signer as RecordingSigner).signed).toEqual([]);
  });

  it("signs files of loaded faces, then Basic-Latin files of unloaded faces, then the rest, and stops at the cap", async () => {
    const [cyrillic, latin, loadedFace, otherFamily] = ["a", "b", "c", "d"].map((name) => `https://www.site.example/${name}.woff2`);
    const typekit = "https://use.typekit.net/af/1a2b3c/000000000000000000017701/27/l?fvd=n4&v=3";
    const parts: Parts = {
      fontFaces: [
        rule("Face", [cyrillic], { weight: "300", unicodeRange: "U+0400-045F" }),
        rule("Face", [latin], { weight: "500" }),
        rule("Face", [loadedFace], { weight: "400" }),
        rule("Kit", [typekit]),
        rule("Other", [otherFamily], { unicodeRange: "U+0400-045F" }),
      ],
      fonts: [captured(typekit, null), captured(loadedFace)],
      fontStatuses: [loaded("Face", "400"), loaded("Kit")],
    };
    const { byName, capped, signer } = await build({ ...parts, signer: signerThatSigns(3) });
    expect(capped).toBe(true);
    expect(signer.signed).toEqual([loadedFace, typekit, latin]);
    expect(byName.get("Face")!.faces.map((face) => [face.weight, face.loaded, face.files[0].proxy])).toEqual([
      ["300", false, ""],
      ["500", false, `signed:${latin}`],
      ["400", true, `signed:${loadedFace}`],
    ]);
    expect(byName.get("Other")!.faces[0].files[0].proxy).toBe("");

    const all = await build({ ...parts, signer: signerThatSigns(5) });
    expect(all.capped).toBe(false);
    expect(all.signer.signed).toHaveLength(5);
    expect(all.signer.signed.slice(3).sort()).toEqual([cyrillic, otherFamily].sort());
  });

  it("past the cap still gives a file the path of a URL the scan already signed", async () => {
    const [fresh, shared] = ["fresh", "shared"].map((name) => `https://www.site.example/${name}.woff2`);
    const signer = createSigner({ secret: "s".repeat(32), max: 1 });
    // an asset with the same URL was signed first and used the whole cap
    const assetPath = signer.sign(shared);
    const { byName, capped } = await build({
      fontFaces: [rule("Face", [fresh], { weight: "400" }), rule("Face", [shared], { weight: "700" })],
      fonts: [captured(fresh)],
      fontStatuses: [loaded("Face", "400")],
      signer: Object.assign(signer, { signed: [] }),
    });
    expect(capped).toBe(true);
    expect(byName.get("Face")!.faces.map((face) => [face.weight, face.files[0].proxy])).toEqual([
      ["400", ""],
      ["700", assetPath],
    ]);
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

  it("reports the catalogue spelling of a family declared without its spaces, so the specimen link resolves", async () => {
    const url = "https://www.site.example/scp.woff2";
    const { families } = await build({
      fontFaces: [rule("SourceCodePro", [url])],
      fontStatuses: [loaded("SourceCodePro")],
      fontUsage: [{ stack: "SourceCodePro", weight: "400", style: "normal", chars: 4 }],
      google: ["Source Code Pro"],
    });
    expect(families[0]).toMatchObject({ name: "SourceCodePro", googleFamily: "Source Code Pro" });
    // The Fonts tab builds the specimen href from `googleFamily`: the declared spelling would 404 on fonts.google.com
    expect(googleFontsUrl(families[0].googleFamily!)).toBe("https://fonts.google.com/specimen/Source+Code+Pro");
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
