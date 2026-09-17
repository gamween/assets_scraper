import { readFileSync } from "node:fs";
import path from "node:path";
import type { Browser } from "playwright-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FontFamily, type FontFile } from "@/lib/contract";
import { buildFontFamilies } from "@/server/scan/fonts";
import { clearGoogleFontsCache } from "@/server/scan/fonts/google";
import { fakeGoogleFetch } from "@/server/scan/fonts/testing";
import { parseUnicodeRange } from "@/server/scan/fonts/unicode";
import type { PostInput } from "@/server/scan/types";
import { serveFixture, type FixtureServer } from "../../fixtures/serve";
import { fakeSigner, launchChrome, scanPageFonts } from "./harness";

const SITE = path.join(import.meta.dirname, "../../fixtures/site");
const ss3 = readFileSync(path.join(SITE, "assets/ss3.woff2"));

// The fixture page plus used `@font-face` rules whose only source is a data: URI of ss3.woff2, one of them for a family
// whose name needs CSS escapes.
const ss3Uri = `data:font/woff2;base64,${ss3.toString("base64")}`;
const inlinePage = readFileSync(path.join(SITE, "index.html"), "utf8")
  .replace(
    "</head>",
    `<style>@font-face{font-family:"Inline Face";src:url(${ss3Uri}) format("woff2")}@font-face{font-family:"Quote \\"Face\\"";src:url(${ss3Uri})}</style></head>`,
  )
  .replace("</main>", `<p style="font-family:'Inline Face'">Inline text</p><p style='font-family:"Quote \\"Face\\""'>Quote text</p></main>`);

let server: FixtureServer;
let browser: Browser;

beforeAll(async () => {
  server = await serveFixture({
    "/inline.html": (_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(inlinePage);
    },
  });
  browser = await launchChrome();
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

beforeEach(() => clearGoogleFontsCache());

async function build(pathname: string) {
  const url = `${server.origin}${pathname}`;
  const { collector, network } = await scanPageFonts(browser, url);
  const signer = fakeSigner();
  const fetch = fakeGoogleFetch(["Inter", "Source Sans 3"]);
  const input: PostInput = {
    collector,
    network,
    page: { requestedUrl: url, finalUrl: url, host: server.host, siteName: "Fixture", title: "Fixture Co" },
    signer,
    fetch,
    signal: new AbortController().signal,
    deadline: Date.now() + 30_000,
  };
  const output = await buildFontFamilies(input);
  const families = output.families.map((family) => FontFamily.parse(family));
  const byName = new Map(families.map((family) => [family.name, family]));
  const files = families.flatMap((family) => family.faces.flatMap((face) => face.files));
  return { output, families, byName, files, signer, fetch };
}

const fileName = (file: FontFile) => file.url.split("/").pop();

describe("buildFontFamilies on the fixture site", () => {
  it("groups, names, classifies and signs the fixture fonts", async () => {
    const { output, families, byName, files, signer, fetch } = await build("/");
    expect(output.hidden).toEqual({});
    expect(families.map((family) => family.name)).toEqual(["Inter", "Brand Serif", "Unused Face"]);

    const inter = byName.get("Inter")!;
    expect(inter).toMatchObject({
      cssFamilies: ["__Inter_d65c78"],
      source: "self-hosted",
      sourceHost: "127.0.0.1",
      usedOnPage: true,
      googleFamily: "Inter",
      license: { kind: "open", url: "https://openfontlicense.org/" },
      convertible: true,
      downloadable: true,
    });
    expect(inter.axes).toContainEqual({ tag: "wght", min: 100, max: 900, default: 400 });
    expect(inter.faces).toHaveLength(1);
    expect(inter.faces[0]).toMatchObject({ weight: "100 900", style: "normal", loaded: true });
    expect(inter.faces[0].files.map(fileName)).toEqual(["__inter.woff2", "jbm-cyr.woff2"]);
    expect(inter.faces[0].files.map((file) => file.coversLatin)).toEqual([true, false]);
    expect(inter.faces[0].files[0]).toMatchObject({ format: "woff2", bytes: 48_432 });
    expect(inter.faces[0].files[1]).toMatchObject({ format: "woff2", bytes: 1_172 });
    // Chrome serializes ranges as "U+0-FF", the stylesheet says "U+0000-00FF": both rules are one
    expect(inter.faces[0].files.map((file) => parseUnicodeRange(file.unicodeRange))).toEqual([[[0, 0xff]], [[0x400, 0x45f]]]);

    const brand = byName.get("Brand Serif")!;
    expect(brand).toMatchObject({
      cssFamilies: ["Brand Serif"],
      source: "self-hosted",
      usedOnPage: true,
      googleFamily: "Source Sans 3",
      license: { kind: "open" },
      convertible: true,
      downloadable: true,
    });
    expect(brand.faces).toEqual([
      expect.objectContaining({ weight: "400", style: "normal", loaded: true, subfamily: "Regular", files: [expect.objectContaining({ format: "woff2", bytes: 153_800, coversLatin: true })] }),
    ]);

    const unused = byName.get("Unused Face")!;
    expect(unused).toMatchObject({ usedOnPage: false, usage: 0, license: { kind: "unknown" }, convertible: false, downloadable: true, source: "self-hosted" });
    expect(unused.googleFamily).toBeUndefined();
    expect(unused.faces).toHaveLength(1);
    expect(unused.faces[0].loaded).toBe(false);
    expect(unused.faces[0].files).toHaveLength(1);
    expect(unused.faces[0].files[0]).toMatchObject({ url: `${server.origin}/assets/missing.woff2`, format: "woff2", coversLatin: true });
    expect(unused.faces[0].files[0].bytes).toBeUndefined();

    // sorted by usage, then used before unused
    expect(inter.usage).toBeGreaterThan(brand.usage);
    expect(brand.usage).toBeGreaterThan(0);
    expect(inter.usage + brand.usage).toBeLessThanOrEqual(1);
    for (let i = 1; i < families.length; i += 1) {
      const [a, b] = [families[i - 1], families[i]];
      expect(a.usage > b.usage || (a.usage === b.usage && (a.usedOnPage || !b.usedOnPage))).toBe(true);
    }

    // every remote file has a signed proxy, and nothing else was signed
    for (const file of files) {
      expect(file.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/assets\//);
      expect(file.proxy).toBe(`/api/asset?u=${encodeURIComponent(file.url)}`);
      expect(file.inline).toBeUndefined();
    }
    expect([...signer.signed].sort()).toEqual(files.map((file) => file.url).sort());

    // ids are unique, and only used families were checked against Google Fonts, Brand Serif by its binary name only
    expect(new Set(families.map((family) => family.id)).size).toBe(families.length);
    const asked = fetch.calls.map((call) => new URL(call.url).searchParams.get("family"));
    expect([...asked].sort()).toEqual(["Inter", "Source Sans 3"]);
  });

  it("carries data: URI fonts inline, without a URL or a signature", async () => {
    const { byName, families, files, signer } = await build("/inline.html");
    expect(families.map((family) => family.name)).toEqual(expect.arrayContaining(["Inter", "Brand Serif", "Inline Face", "Unused Face"]));

    const inline = byName.get("Inline Face")!;
    expect(inline).toMatchObject({
      cssFamilies: ["Inline Face"],
      source: "data-uri",
      usedOnPage: true,
      googleFamily: "Source Sans 3",
      license: { kind: "open" },
      convertible: true,
      downloadable: true,
    });
    expect(inline.sourceHost).toBeUndefined();
    expect(inline.usage).toBeGreaterThan(0);
    expect(inline.faces).toHaveLength(1);
    expect(inline.faces[0].loaded).toBe(true);
    expect(inline.faces[0].files).toEqual([
      { url: "", proxy: "", format: "woff2", bytes: ss3.length, coversLatin: true, inline: { mime: "font/woff2", base64: ss3.toString("base64") } },
    ]);

    expect(signer.signed.some((url) => url.startsWith("data:"))).toBe(false);
    expect([...signer.signed].sort()).toEqual(files.filter((file) => file.url).map((file) => file.url).sort());

    // The CSSOM gives this family as `"Quote \"Face\""` and document.fonts as `Quote "Face"`: both read as one family
    expect(byName.get(`Quote "Face"`)).toMatchObject({ cssFamilies: [`Quote "Face"`], source: "data-uri", usedOnPage: true, faces: [{ loaded: true }] });
  });
});
