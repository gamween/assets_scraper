import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { FontFamily } from "@/lib/contract";
import { SignLimitError } from "@/server/security/sign";
import { fakeGoogleFetch } from "../../../../tests/integration/fonts/fake-google";
import type { CapturedFont, CapturedSheet, PostInput, RawCollectorOutput, Signer } from "../types";
import { parseFontBinary } from "./binary";
import { clearGoogleFontsCache } from "./google";
import { buildFontFamilies, isConvertibleFont } from "./index";

const signal = new AbortController().signal;
const bytes = (name: string) => readFileSync(path.join(process.cwd(), "tests/fixtures/site/assets", name));
const interMeta = parseFontBinary(bytes("__inter.woff2"));
const jbmMeta = parseFontBinary(bytes("jbm-cyr.woff2"));
const PAGE = "https://www.site.example/";

beforeEach(() => clearGoogleFontsCache());

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

async function build(parts: Parts) {
  const fetch = fakeGoogleFetch(parts.google ?? []);
  const signer = parts.signer ?? signerThatSigns();
  const input: PostInput = {
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
    signer,
    fetch,
    signal,
    deadline: parts.deadline ?? Date.now() + 10_000,
  };
  const { families } = await buildFontFamilies(input);
  for (const family of families) FontFamily.parse(family);
  return { families, byName: new Map(families.map((family) => [family.name, family])), fetch, signer };
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
    const { byName, families } = await build({
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
    expect(byName.get("argent-pixel-cf")!.faces[0].files[0]).toMatchObject({ url: typekit, format: "woff2", proxy: `signed:${typekit}` });
  });

  it("groups captured files without a rule by binary name and ignores failed or unreadable captures", async () => {
    const url = "https://cdn.other.example/fonts/jbm.woff2";
    const { families } = await build({
      fonts: [captured(url, jbmMeta), captured("https://cdn.other.example/fonts/junk.woff2", null), captured("https://cdn.other.example/fonts/gone.woff2", interMeta, 404)],
      fontStatuses: [loaded("JetBrains Mono", "500")],
      fontUsage: [{ stack: '"JetBrains Mono", monospace', weight: "500", style: "normal", chars: 12 }],
    });
    expect(families).toHaveLength(1);
    expect(families[0]).toMatchObject({ name: "JetBrains Mono", cssFamilies: [], source: "third-party", sourceHost: "cdn.other.example", usedOnPage: true, usage: 1 });
    expect(families[0].faces).toEqual([
      { weight: "500", style: "normal", loaded: true, subfamily: "Medium", files: [{ url, proxy: `signed:${url}`, format: "woff2", bytes: 1_000, coversLatin: false }] },
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

  it("stops signing at the signing cap without failing", async () => {
    const urls = ["a", "b", "c"].map((name) => `https://www.site.example/${name}.woff2`);
    const { families, signer } = await build({
      fontFaces: urls.map((url, index) => rule(`Face ${index}`, [url])),
      signer: signerThatSigns(1),
    });
    const files = families.flatMap((family) => family.faces.flatMap((face) => face.files));
    expect(signer.signed).toHaveLength(1);
    expect(files.map((file) => file.proxy).sort()).toEqual(["", "", `signed:${signer.signed[0]}`]);
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
