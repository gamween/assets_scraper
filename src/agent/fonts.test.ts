import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as fontkit from "fontkit";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { decompress } from "wawoff2";
import type { FontFamily, FontFile } from "@/lib/contract";
import { agentLimitEnvName } from "./limits";
import { fontManifestPath, listInstalledFonts } from "./font-manifest";
import { installFonts, toSfnt, uninstallFonts, userFontDir } from "./fonts";
import { testFontFamily, testFontFile } from "./testing";

/**
 * The font installer (plan Task G3.1, spec section 5). Every test redirects the font directory and the state file into a
 * temporary tree, so nothing here ever touches `~/Library/Fonts`.
 */

const FIXTURE_WOFF2 = fileURLToPath(new URL("../../tests/fixtures/site/assets/__inter.woff2", import.meta.url));
/** Two more real web fonts, so a test can convert and install two different families at the same time. */
const FIXTURE_JETBRAINS_WOFF2 = fileURLToPath(new URL("../../tests/fixtures/site/assets/jbm-cyr.woff2", import.meta.url));
const FIXTURE_SOURCE_WOFF2 = fileURLToPath(new URL("../../tests/fixtures/site/assets/ss3.woff2", import.meta.url));

/** The fixture Inter, as it is served (WOFF2) and as the installer should write it (TTF). */
let woff2: Buffer;
let ttf: Buffer;
/** The same TTF with its name records rewritten to a commercial notice, so a licence read from bytes is commercial. */
let commercialTtf: Buffer;
let jetbrainsWoff2: Buffer;
let sourceWoff2: Buffer;
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
  jetbrainsWoff2 = await fs.promises.readFile(FIXTURE_JETBRAINS_WOFF2);
  sourceWoff2 = await fs.promises.readFile(FIXTURE_SOURCE_WOFF2);
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

  it("refuses a name a symbolic link holds instead of following it", async () => {
    fs.mkdirSync(fontDir, { recursive: true });
    fs.symlinkSync(path.join(home, "elsewhere.ttf"), path.join(fontDir, "Inter-Regular.ttf"));

    const report = await installFonts([interWoff2()], { fetchBytes });

    expect(report.installed).toEqual([]);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0]).toMatchObject({ family: "Inter", reason: "exists" });
    expect(fs.existsSync(path.join(home, "elsewhere.ttf"))).toBe(false);
  });

  it("does not let two families that fold to one file name overwrite each other", async () => {
    served.set("https://cdn.example.com/second.ttf", ttf);
    const second = oneFile("Söhne", { url: "https://cdn.example.com/second.ttf", format: "ttf" });
    const first = oneFile("Sohne", { url: "https://cdn.example.com/second.ttf", format: "ttf" });

    const report = await installFonts([first, second], { fetchBytes });

    expect(report.installed.map((install) => install.family)).toEqual(["Sohne"]);
    expect(report.skipped).toEqual([{ family: "Söhne", reason: "exists", detail: path.join(fontDir, "Sohne-Regular.ttf") }]);
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
    // The detail names the families the scan does hold, so a slip on a name is correctable from the answer alone.
    expect(report.skipped).toEqual([{ family: "Nope", reason: "unknown-family", detail: "this page has Inter, Other" }]);
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

  it("removes the file a family installed before when its style changes", async () => {
    served.set("https://cdn.example.com/inter.ttf", ttf);
    const bold = oneFile("Inter", { url: "https://cdn.example.com/inter.ttf", format: "ttf" });
    bold.faces[0].weight = "700";
    await installFonts([bold], { fetchBytes });

    const report = await installFonts([oneFile("Inter", { url: "https://cdn.example.com/inter.ttf", format: "ttf" })], { fetchBytes });

    expect(report.installed).toMatchObject([{ family: "Inter", files: [path.join(fontDir, "Inter-Regular.ttf")] }]);
    expect(fs.existsSync(path.join(fontDir, "Inter-Bold.ttf"))).toBe(false);
    await uninstallFonts(["Inter"]);
    expect(fs.readdirSync(fontDir)).toEqual([]);
    expect(await listInstalledFonts()).toEqual([]);
  });

  it("records both families when two installs run at once", async () => {
    served.set("https://cdn.example.com/a.ttf", ttf);
    const first = oneFile("Alpha", { url: "https://cdn.example.com/a.ttf", format: "ttf" });
    const second = oneFile("Beta", { url: "https://cdn.example.com/a.ttf", format: "ttf" });

    const reports = await Promise.all([installFonts([first], { fetchBytes }), installFonts([second], { fetchBytes })]);

    expect(reports.flatMap((report) => report.skipped)).toEqual([]);
    expect((await listInstalledFonts()).map((install) => install.family).sort()).toEqual(["Alpha", "Beta"]);
    expect(fs.readdirSync(stateDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("keeps each family's own bytes and licence when two conversions run at once", async () => {
    served.set("https://cdn.example.com/inter.woff2", woff2);
    served.set("https://cdn.example.com/jbm.woff2", jetbrainsWoff2);
    const inter = oneFile("Inter", { url: "https://cdn.example.com/inter.woff2", format: "woff2" });
    const mono = oneFile("JetBrains Mono", { url: "https://cdn.example.com/jbm.woff2", format: "woff2" });

    const [first, second] = await Promise.all([installFonts([inter], { fetchBytes }), installFonts([mono], { fetchBytes })]);

    // The licence is read from the bytes about to be written, so a swapped heap view would report the other font's notice.
    expect(first.installed[0].license.text).toContain("Inter Project Authors");
    expect(second.installed[0].license.text).toContain("JetBrains Mono Project Authors");
    const interFile = fs.readFileSync(path.join(fontDir, "Inter-Regular.ttf"));
    const monoFile = fs.readFileSync(path.join(fontDir, "JetBrainsMono-Regular.ttf"));
    expect(interFile.equals(ttf)).toBe(true);
    expect(monoFile.equals(Buffer.from(await decompress(jetbrainsWoff2)))).toBe(true);
    expect(openFont(interFile).numGlyphs).toBe(sourceGlyphs);
  });

  it("does not let a later call take a file name another family holds", async () => {
    served.set("https://cdn.example.com/one.ttf", ttf);
    await installFonts([oneFile("Sohne", { url: "https://cdn.example.com/one.ttf", format: "ttf" })], { fetchBytes });

    const report = await installFonts([oneFile("S\u00f6hne", { url: "https://cdn.example.com/one.ttf", format: "ttf" })], { fetchBytes });

    expect(report.installed).toEqual([]);
    expect(report.skipped).toEqual([{ family: "S\u00f6hne", reason: "exists", detail: path.join(fontDir, "Sohne-Regular.ttf") }]);
    expect((await listInstalledFonts()).map((install) => install.family)).toEqual(["Sohne"]);
  });

  it("refuses a name that appeared while the bytes were being fetched", async () => {
    const target = path.join(fontDir, "Inter-Regular.ttf");
    const family = interWoff2();
    const plantThenFetch = async (file: FontFile): Promise<Buffer> => {
      fs.mkdirSync(fontDir, { recursive: true });
      fs.writeFileSync(target, "not ours");
      return fetchBytes(file);
    };

    const report = await installFonts([family], { fetchBytes: plantThenFetch });

    expect(report.installed).toEqual([]);
    expect(report.skipped).toEqual([{ family: "Inter", reason: "exists", detail: target }]);
    expect(fs.readFileSync(target, "utf8")).toBe("not ours");
  });

  it("cuts a family name too long for a file name and installs it anyway", async () => {
    served.set("https://cdn.example.com/long.ttf", ttf);
    const family = oneFile("Ligature ".repeat(200).trim(), { url: "https://cdn.example.com/long.ttf", format: "ttf" });

    const report = await installFonts([family], { fetchBytes });

    expect(report.skipped).toEqual([]);
    const [file] = report.installed[0].files;
    expect(Buffer.byteLength(path.basename(file))).toBeLessThanOrEqual(255);
    expect(fs.existsSync(file)).toBe(true);
  });

  it("reports a font directory it cannot write into as a write failure, not as a name that exists", async () => {
    const blocked = path.join(home, "blocked");
    fs.writeFileSync(blocked, "a file where a directory should be");
    setEnv("ASSETS_SCRAPER_FONT_DIR", path.join(blocked, "Fonts"));
    served.set("https://cdn.example.com/inter.ttf", ttf);

    const report = await installFonts([oneFile("Inter", { url: "https://cdn.example.com/inter.ttf", format: "ttf" })], { fetchBytes });

    expect(report.installed).toEqual([]);
    expect(report.skipped).toMatchObject([{ family: "Inter", reason: "write-failed" }]);
    expect(report.skipped[0].detail).toContain("Inter-Regular.ttf");
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
    expect(await uninstallFonts(["Nope"])).toEqual({ removed: [], missing: ["Nope"], stillInstalled: [] });
  });

  it("reads an empty list when nothing was ever installed, and ignores a corrupt manifest", async () => {
    expect(await listInstalledFonts()).toEqual([]);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(fontManifestPath(), "{ not json");
    expect(await listInstalledFonts()).toEqual([]);
  });

  /** A manifest written by hand, the way an edit or a restore from another machine could leave one. */
  const recordInstall = (family: string, files: string[]): void => {
    fs.mkdirSync(stateDir, { recursive: true });
    const install = { family, files, license: { kind: "unknown" }, sourceHost: "example.com", installedAt: new Date().toISOString(), converted: false };
    fs.writeFileSync(fontManifestPath(), JSON.stringify({ version: 1, installs: [install] }));
  };

  it("never removes a recorded path outside the font directory", async () => {
    const outside = path.join(home, "keep-me.ttf");
    fs.writeFileSync(outside, "not ours");
    recordInstall("Inter", [outside]);

    const removal = await uninstallFonts(["Inter"]);

    // Regression: this answered `removed: [{ family: "Inter", files: [] }]`, so the CLI printed "removed Inter" and the
    // MCP tool reported success while the font was still installed and still recorded (review issue 20).
    expect(removal.removed).toEqual([]);
    expect(removal.stillInstalled).toEqual([{ family: "Inter", files: [outside] }]);
    expect(fs.existsSync(outside)).toBe(true);
    expect(await listInstalledFonts()).toMatchObject([{ family: "Inter", files: [outside] }]);
  });

  it("removes the files it can when a recorded path is a directory", async () => {
    const directory = path.join(fontDir, "Inter-Regular.ttf");
    const file = path.join(fontDir, "Inter-Bold.ttf");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(file, "ours");
    recordInstall("Inter", [directory, file]);

    const removal = await uninstallFonts(["Inter"]);

    expect(removal.removed).toMatchObject([{ family: "Inter", files: [file] }]);
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(directory)).toBe(true);
  });
});

describe("toSfnt", () => {
  it("copies each conversion out before the next one starts", async () => {
    // wawoff2 answers with a view of its heap, which the next decompression reuses before an awaiting caller copies it:
    // without the chain the middle call here comes back holding another font's bytes, and its licence with them.
    const sequentialInter = await toSfnt(woff2);
    const sequentialSource = await toSfnt(sourceWoff2);
    expect(sequentialInter).not.toBeNull();
    expect(sequentialSource).not.toBeNull();

    const concurrent = await Promise.all([toSfnt(woff2), toSfnt(sourceWoff2), toSfnt(woff2)]);

    expect(concurrent).toEqual([sequentialInter, sequentialSource, sequentialInter]);
    // Five WOFF2 decompressions, over two seconds on a CI runner: the default 5 second timeout left little room
  }, 30_000);

  it("answers null for bytes it cannot decompress", async () => {
    expect(await toSfnt(Buffer.from("wOF2 not really a font"))).toBeNull();
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
