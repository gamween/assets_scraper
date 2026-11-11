import zlib from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ArchiveLimits, type ArchiveSkipReason, ArchiveError, logoFilesIn, looksLike } from "./archive";
import { buildZip, TEST_PNG, TEST_SVG } from "./testing";

const MB = 1024 * 1024;
const LIMITS: ArchiveLimits = { maxEntries: 2_000, maxFiles: 500, maxFileBytes: 4 * MB, maxTotalBytes: 8 * MB };

/** Every file the archive gives, by path, and what it skipped. */
function read(archive: Buffer, limits: ArchiveLimits = LIMITS) {
  const skipped: Partial<Record<ArchiveSkipReason, number>> = {};
  const files = [...logoFilesIn(archive, limits, skipped)];
  return { files, paths: files.map((file) => file.path), skipped };
}

const PDF = Buffer.from("%PDF-1.7\n%\u00e2\u00e3\n1 0 obj\n<<>>\nendobj\n%%EOF\n", "latin1");
const EPS = Buffer.from("%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 10 10\n", "latin1");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("logoFilesIn", () => {
  it("gives the logo files of a kit as macOS zips one, and nothing else", () => {
    // The shape of monad.xyz's and stellar.org's kits: one folder, macOS metadata beside every file, a font archive.
    const { files, paths, skipped } = read(
      buildZip([
        { name: "Fixture Brand Kit/", data: "" },
        { name: "__MACOSX/._Fixture Brand Kit", data: "metadata" },
        { name: "Fixture Brand Kit/.DS_Store", data: "metadata" },
        { name: "Fixture Brand Kit/Logos/Full Logo Black.svg", data: TEST_SVG },
        { name: "Fixture Brand Kit/Logos/._Full Logo Black.svg", data: "metadata" },
        { name: "Fixture Brand Kit/Logos/Avatar 1024x1024.png", data: TEST_PNG, method: 0 },
        { name: "Fixture Brand Kit/Fixture Brand Guidelines \u2014 Public.pdf", data: PDF },
        { name: "Fixture Brand Kit/Print/Logo.eps", data: EPS },
        { name: "Fixture Brand Kit/Print/Logo.ai", data: PDF },
        { name: "Fixture Brand Kit/Fonts.zip", data: buildZip([{ name: "font.otf", data: "font" }]) },
        { name: "Fixture Brand Kit/README.txt", data: "Use the logo with care." },
      ]),
    );
    expect(paths).toEqual([
      "Logos/Full Logo Black.svg",
      "Logos/Avatar 1024x1024.png",
      "Fixture Brand Guidelines \u2014 Public.pdf",
      "Print/Logo.eps",
      "Print/Logo.ai",
    ]);
    expect(files.map((file) => file.type)).toEqual(["svg", "png", "pdf", "eps", "ai"]);
    expect(files[0].bytes.toString("utf8")).toBe(TEST_SVG);
    expect(skipped).toEqual({ metadata: 3, "nested-archive": 1, "other-type": 1 });
  });

  it("keeps the top folder when the files do not share one", () => {
    expect(read(buildZip([{ name: "Logo.svg", data: TEST_SVG }, { name: "Dark/Logo.svg", data: TEST_SVG }])).paths).toEqual(["Logo.svg", "Dark/Logo.svg"]);
  });

  it("refuses every name that could leave the folder, and writes nothing for it", () => {
    const names = ["../../evil.svg", "/etc/evil.svg", "kit/../../evil.svg", "C:\\Windows\\evil.svg", "..\\evil.svg", "kit/./evil.svg", "kit/ev\u0001il.svg", `${"a/".repeat(12)}deep.svg`];
    const { paths, skipped } = read(buildZip([...names.map((name) => ({ name, data: TEST_SVG })), { name: "kit\\Logo.svg", data: TEST_SVG }]));
    // A backslash is a separator, as Windows archivers write it, and the one name that stays inside is kept, out of the
    // folder it shares with nothing else.
    expect(paths).toEqual(["Logo.svg"]);
    expect(skipped).toEqual({ "unsafe-path": names.length });
  });

  it("never writes a symbolic link, whatever it is named", () => {
    const { paths, skipped } = read(buildZip([{ name: "kit/Logo.svg", data: "/etc/passwd", symlink: true }, { name: "kit/Mark.svg", data: TEST_SVG }]));
    expect(paths).toEqual(["Mark.svg"]);
    expect(skipped).toEqual({ symlink: 1 });
  });

  it("stops a zip bomb at its declared size, before it fills memory", () => {
    // 32 MB of zeros deflate to 32 KB. The entry claims 1,000 bytes: zlib is told so, and stops there.
    const inflate = vi.spyOn(zlib, "inflateRawSync");
    const bomb = zlib.deflateRawSync(Buffer.alloc(32 * MB));
    const { paths, skipped } = read(buildZip([{ name: "kit/Logo.svg", stream: bomb, declaredSize: 1_000, data: TEST_SVG }]));
    expect(paths).toEqual([]);
    expect(skipped).toEqual({ corrupt: 1 });
    expect(inflate).toHaveBeenCalledTimes(1);
    expect(inflate.mock.calls[0][1]).toMatchObject({ maxOutputLength: 1_000 });
  });

  it("refuses a file declared over the per-file cap without inflating it", () => {
    const inflate = vi.spyOn(zlib, "inflateRawSync");
    const big = Buffer.from(`${TEST_SVG.slice(0, -6)}<!--${" ".repeat(5 * MB)}--></svg>`);
    const { skipped } = read(buildZip([{ name: "kit/Huge.svg", data: big }, { name: "kit/Logo.svg", data: TEST_SVG }]));
    expect(skipped).toEqual({ "too-large": 1 });
    expect(inflate.mock.calls.map((call) => (call[1] as zlib.ZlibOptions).maxOutputLength)).toEqual([TEST_SVG.length]);
  });

  it("bounds the work of entries that share one stream by the total budget, a zip bomb in breadth", () => {
    // David Fifield's overlapping-file bomb: hundreds of directory records pointing at one compressed stream.
    const inflate = vi.spyOn(zlib, "inflateRawSync");
    const padded = Buffer.from(`${TEST_SVG.slice(0, -6)}<!--${" ".repeat(MB - 200)}--></svg>`);
    const specs = Array.from({ length: 300 }, (_, index) => ({ name: `kit/Logo ${index}.svg`, data: padded, pointsAt: 0 }));
    const { paths, skipped } = read(buildZip(specs), { ...LIMITS, maxTotalBytes: 3 * MB });
    const fit = Math.floor((3 * MB) / padded.length);
    expect(paths).toHaveLength(fit);
    expect(skipped).toEqual({ "over-budget": 300 - fit });
    const inflated = inflate.mock.calls.reduce((total, call) => total + ((call[1] as zlib.ZlibOptions).maxOutputLength ?? 0), 0);
    expect(inflated).toBeLessThanOrEqual(3 * MB);
  });

  it("refuses an archive with more entries than it may list, and caps the files it gives", () => {
    const tiny = Array.from({ length: 30 }, (_, index) => ({ name: `kit/${index}.svg`, data: TEST_SVG }));
    expect(() => read(buildZip(tiny), { ...LIMITS, maxEntries: 29 })).toThrow(ArchiveError);
    expect(() => read(buildZip(tiny), { ...LIMITS, maxEntries: 29 })).toThrow(/30 entries, more than the 29/);
    const { paths, skipped } = read(buildZip(tiny), { ...LIMITS, maxFiles: 25 });
    expect(paths).toHaveLength(25);
    expect(skipped).toEqual({ cap: 5 });
  });

  it("skips what it cannot or must not read: encrypted, other methods, a wrong CRC, the wrong bytes, an empty file", () => {
    const { paths, skipped } = read(
      buildZip([
        { name: "kit/Secret.svg", data: TEST_SVG, encrypted: true },
        { name: "kit/Bzip.svg", data: TEST_SVG, method: 12, stream: Buffer.from("BZh9") },
        { name: "kit/Broken.svg", data: TEST_SVG, stream: zlib.deflateRawSync(Buffer.from(TEST_SVG.replace("10", "11"))) },
        { name: "kit/Png.svg", data: TEST_PNG },
        { name: "kit/Html.svg", data: "<!doctype html><script>alert(1)</script>" },
        { name: "kit/Empty.svg", data: "" },
        { name: "kit/Logo.svg", data: TEST_SVG },
      ]),
    );
    expect(paths).toEqual(["Logo.svg"]);
    expect(skipped).toEqual({ encrypted: 1, "unsupported-compression": 1, corrupt: 2, mismatch: 2 });
  });

  it("reads a ZIP64 directory", () => {
    const { paths } = read(buildZip([{ name: "Kit/Logo.svg", data: TEST_SVG }, { name: "Kit/Mark.png", data: TEST_PNG }], { zip64: true }));
    expect(paths).toEqual(["Logo.svg", "Mark.png"]);
  });

  it("decodes a name as UTF-8 with or without the flag, and as Latin-1 when it is not UTF-8", () => {
    const latin = buildZip([{ name: "kit/x.svg", data: TEST_SVG }]);
    // Patch the name bytes in both headers to Latin-1 "\u00e9" (one byte, 0xe9), not valid UTF-8 on its own.
    const patched = Buffer.from(latin.toString("latin1").replaceAll("kit/x.svg", "kit/\u00e9.svg"), "latin1");
    expect(read(patched).paths).toEqual(["\u00e9.svg"]);
    expect(read(buildZip([{ name: "kit/\u00e9.svg", data: TEST_SVG, utf8: true }])).paths).toEqual(["\u00e9.svg"]);
  });

  it("refuses what is not one whole single-file ZIP", () => {
    const archive = buildZip([{ name: "Logo.svg", data: TEST_SVG }]);
    expect(() => read(Buffer.from("<!DOCTYPE html><title>Just a moment...</title>"))).toThrow(/not a ZIP archive/);
    expect(() => read(archive.subarray(0, archive.length - 30))).toThrow(ArchiveError);
    const split = Buffer.from(archive);
    split.writeUInt16LE(1, split.length - 22 + 4);
    expect(() => read(split)).toThrow(/split over several files/);
    const pastEnd = Buffer.from(archive);
    pastEnd.writeUInt32LE(archive.length, archive.length - 22 + 16);
    expect(() => read(pastEnd)).toThrow(/points past its end/);
  });
});

describe("looksLike", () => {
  it("tells each brand file type by its first bytes", () => {
    const zip = buildZip([{ name: "a.svg", data: TEST_SVG }]);
    expect(looksLike("zip", zip)).toBe(true);
    expect(looksLike("zip", PDF)).toBe(false);
    expect(looksLike("pdf", PDF)).toBe(true);
    expect(looksLike("ai", PDF)).toBe(true);
    expect(looksLike("ai", EPS)).toBe(true);
    expect(looksLike("eps", EPS)).toBe(true);
    expect(looksLike("eps", Buffer.from("c5d0d3c6000000", "hex"))).toBe(true);
    expect(looksLike("eps", PDF)).toBe(false);
    expect(looksLike("svg", Buffer.from(TEST_SVG))).toBe(true);
    expect(looksLike("svg", Buffer.from("<!doctype html><html>"))).toBe(false);
    expect(looksLike("png", TEST_PNG)).toBe(true);
    expect(looksLike("png", Buffer.from(TEST_SVG))).toBe(false);
  });
});
