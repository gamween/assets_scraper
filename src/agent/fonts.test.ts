import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as fontkit from "fontkit";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { decompress } from "wawoff2";
import type { FontFamily, FontFile } from "@/lib/contract";
import { agentLimitEnvName } from "./limits";
import { fontManifestPath, installFonts, listInstalledFonts, uninstallFonts, userFontDir } from "./fonts";
import { testFontFamily, testFontFile } from "./testing";

/**
 * The font installer (plan Task G3.1, spec section 5). Every test redirects the font directory and the state file into a
 * temporary tree, so nothing here ever touches `~/Library/Fonts`.
 */

const FIXTURE_WOFF2 = fileURLToPath(new URL("../../tests/fixtures/site/assets/__inter.woff2", import.meta.url));

/** The fixture Inter, as it is served (WOFF2) and as the installer should write it (TTF). */
let woff2: Buffer;
let ttf: Buffer;
/** The same TTF with its name records rewritten to a commercial notice, so a licence read from bytes is commercial. */
let commercialTtf: Buffer;
let sourceGlyphs: number;

const openFont = (bytes: Buffer): fontkit.Font => {
  const font = fontkit.create(bytes);
  if ("fonts" in font) throw new Error("expected a single font");
  return font;
};

/**
 * Replaces a UTF-16BE name record string in place, which is how this font stores them. The replacement is padded with
 * spaces to the length of the original, so the table directory the font declares stays true.
 */
const replaceName = (bytes: Buffer, from: string, text: string): Buffer => {
  const to = text.padEnd(from.length, " ");
  if (to.length !== from.length) throw new Error(`a name record replacement must fit ${from.length} characters`);
  const needle = Buffer.from(from, "utf16le").swap16();
  const at = bytes.indexOf(needle);
  if (at === -1) throw new Error(`not in this font: ${from}`);
  const out = Buffer.from(bytes);
  Buffer.from(to, "utf16le").swap16().copy(out, at);
  return out;
};

beforeAll(async () => {
  woff2 = await fs.promises.readFile(FIXTURE_WOFF2);
  ttf = Buffer.from(await decompress(woff2));
  sourceGlyphs = openFont(woff2).numGlyphs;
  commercialTtf = replaceName(
    replaceName(ttf, "Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter)", "Copyright Klim Type Foundry"),
    "https://openfontlicense.org",
    "Klim Type Foundry, Germany",
  );
});

let home: string;
let fontDir: string;
let stateDir: string;
const previous = new Map<string, string | undefined>();

const setEnv = (name: string, value: string | undefined): void => {
  if (!previous.has(name)) previous.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-fonts-")));
  fontDir = path.join(home, "Fonts");
  stateDir = path.join(home, "state");
  setEnv("ASSETS_SCRAPER_FONT_DIR", fontDir);
  setEnv("ASSETS_SCRAPER_STATE_DIR", stateDir);
});

afterEach(() => {
  for (const [name, value] of previous) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  previous.clear();
  fs.rmSync(home, { recursive: true, force: true });
});

/** Bytes by file URL, so `fetchBytes` answers without a network. */
const served = new Map<string, Buffer>();
const fetchBytes = async (file: FontFile): Promise<Buffer> => {
  const bytes = served.get(file.url);
  if (!bytes) throw new Error(`HTTP 404 for ${file.url}`);
  return bytes;
};

beforeEach(() => served.clear());

/** A family with one face holding one file, the shape the installer picks from. */
const oneFile = (name: string, file: Partial<FontFile>, patch: Partial<FontFamily> = {}): FontFamily =>
  testFontFamily({
    name,
    faces: [{ weight: "400", style: "normal", loaded: true, files: [testFontFile(file)] }],
    ...patch,
  });

const interWoff2 = (): FontFamily => {
  served.set("https://cdn.example.com/inter.woff2", woff2);
  return oneFile("Inter", { url: "https://cdn.example.com/inter.woff2", format: "woff2" }, { sourceHost: "fonts.example.com" });
};

describe("installFonts", () => {
  it("converts a WOFF2 family to TTF and records the install", async () => {
    const report = await installFonts([interWoff2()], { fetchBytes });

    expect(report.skipped).toEqual([]);
    expect(report.fontDir).toBe(fontDir);
    expect(report.installed).toHaveLength(1);
    const [install] = report.installed;
    const file = path.join(fontDir, "Inter-Regular.ttf");
    expect(install).toMatchObject({ family: "Inter", files: [file], converted: true, sourceHost: "fonts.example.com" });
    expect(install.license.kind).toBe("open");
    expect(install.license.text).toContain("Inter Project Authors");
    expect(new Date(install.installedAt).toISOString()).toBe(install.installedAt);

    const written = fs.readFileSync(file);
    expect(written.readUInt32BE(0)).toBe(0x0001_0000);
    expect(openFont(written).numGlyphs).toBe(sourceGlyphs);

    const manifest: unknown = JSON.parse(fs.readFileSync(fontManifestPath(), "utf8"));
    expect(manifest).toMatchObject({ installs: [install] });
  });

  it("installs a family that is already TTF without converting it", async () => {
    served.set("https://cdn.example.com/inter.ttf", ttf);
    const family = oneFile("Inter", { url: "https://cdn.example.com/inter.ttf", format: "ttf" });
    family.faces[0].weight = "700";

    const report = await installFonts([family], { fetchBytes });

    expect(report.installed).toMatchObject([{ family: "Inter", converted: false, files: [path.join(fontDir, "Inter-Bold.ttf")] }]);
    expect(fs.readFileSync(path.join(fontDir, "Inter-Bold.ttf")).equals(ttf)).toBe(true);
  });

  it("installs a commercial family and reports the licence read from the binary", async () => {
    served.set("https://cdn.example.com/sohne.ttf", commercialTtf);
    const family = oneFile("Söhne VF", { url: "https://cdn.example.com/sohne.ttf", format: "ttf" }, { license: { kind: "unknown" } });

    const report = await installFonts([family], { fetchBytes });

    expect(report.installed).toHaveLength(1);
    expect(report.installed[0].license.kind).toBe("commercial");
    expect(report.installed[0].license.text).toContain("Klim Type Foundry");
    expect(report.installed[0].files).toEqual([path.join(fontDir, "SohneVF-Regular.ttf")]);
  });

  it("skips what it cannot install and says why", async () => {
    const adobe = oneFile("Kit Font", { format: "woff2" }, { source: "adobe-fonts" });
    const hidden = oneFile("Ghost", { format: "woff2" }, { downloadable: false });
    const legacy = oneFile("Old", { url: "https://cdn.example.com/old.eot", format: "eot" });
    const noLatin = oneFile("Cyrillic Only", { format: "woff2", coversLatin: false });

    const report = await installFonts([adobe, hidden, legacy, noLatin], { fetchBytes });

    expect(report.installed).toEqual([]);
    expect(report.skipped).toEqual([
      { family: "Kit Font", reason: "adobe-fonts" },
      { family: "Ghost", reason: "not-downloadable" },
      { family: "Old", reason: "unsupported-format" },
      { family: "Cyrillic Only", reason: "no-latin-file" },
    ]);
  });

  it("never overwrites a file it did not install", async () => {
    fs.mkdirSync(fontDir, { recursive: true });
    fs.writeFileSync(path.join(fontDir, "Inter-Regular.ttf"), "mine");

    const report = await installFonts([interWoff2()], { fetchBytes });

    expect(report.installed).toEqual([]);
    expect(report.skipped).toEqual([{ family: "Inter", reason: "exists", detail: path.join(fontDir, "Inter-Regular.ttf") }]);
    expect(fs.readFileSync(path.join(fontDir, "Inter-Regular.ttf"), "utf8")).toBe("mine");
  });

  it("replaces a file it installed itself and keeps one manifest entry", async () => {
    await installFonts([interWoff2()], { fetchBytes });
    const report = await installFonts([interWoff2()], { fetchBytes });

    expect(report.installed).toHaveLength(1);
    expect(await listInstalledFonts()).toHaveLength(1);
  });

  it("installs only the families the caller named and reports the unknown ones", async () => {
    served.set("https://cdn.example.com/other.ttf", ttf);
    const other = oneFile("Other", { url: "https://cdn.example.com/other.ttf", format: "ttf" });

    const report = await installFonts([interWoff2(), other], { fetchBytes, only: ["inter", "Nope"] });

    expect(report.installed.map((install) => install.family)).toEqual(["Inter"]);
    expect(report.skipped).toEqual([{ family: "Nope", reason: "unknown-family" }]);
  });

  it("refuses a file over the size limit, a fetch that fails and bytes that do not decode", async () => {
    setEnv(agentLimitEnvName("fontInstallMaxBytes"), "1000");
    expect(await installFonts([interWoff2()], { fetchBytes })).toMatchObject({ skipped: [{ family: "Inter", reason: "too-large" }] });
    setEnv(agentLimitEnvName("fontInstallMaxBytes"), undefined);

    const gone = oneFile("Gone", { url: "https://cdn.example.com/gone.woff2", format: "woff2" });
    expect(await installFonts([gone], { fetchBytes })).toMatchObject({ skipped: [{ family: "Gone", reason: "fetch-failed" }] });

    served.set("https://cdn.example.com/broken.woff2", Buffer.from("wOF2 not really a font"));
    const broken = oneFile("Broken", { url: "https://cdn.example.com/broken.woff2", format: "woff2" });
    expect(await installFonts([broken], { fetchBytes })).toMatchObject({ skipped: [{ family: "Broken", reason: "conversion-failed" }] });
  });
});

describe("listInstalledFonts and uninstallFonts", () => {
  it("lists what was installed and removes it again", async () => {
    await installFonts([interWoff2()], { fetchBytes });
    const file = path.join(fontDir, "Inter-Regular.ttf");
    expect(await listInstalledFonts()).toMatchObject([{ family: "Inter", files: [file] }]);

    const removal = await uninstallFonts(["inter"]);

    expect(removal.removed.map((install) => install.family)).toEqual(["Inter"]);
    expect(removal.missing).toEqual([]);
    expect(fs.existsSync(file)).toBe(false);
    expect(await listInstalledFonts()).toEqual([]);
  });

  it("reports an unknown family as missing instead of throwing", async () => {
    expect(await uninstallFonts(["Nope"])).toEqual({ removed: [], missing: ["Nope"] });
  });

  it("reads an empty list when nothing was ever installed, and ignores a corrupt manifest", async () => {
    expect(await listInstalledFonts()).toEqual([]);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(fontManifestPath(), "{ not json");
    expect(await listInstalledFonts()).toEqual([]);
  });
});

describe("userFontDir", () => {
  it("is the platform font directory without an override", () => {
    setEnv("ASSETS_SCRAPER_FONT_DIR", undefined);
    const expected =
      process.platform === "darwin" ?
        path.join(os.homedir(), "Library", "Fonts")
      : path.join(os.homedir(), ".local", "share", "fonts");
    expect(userFontDir()).toBe(expected);
  });

  it("is the override when one is set", () => {
    expect(userFontDir()).toBe(fontDir);
  });
});
