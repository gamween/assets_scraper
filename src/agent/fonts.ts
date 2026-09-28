import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FontFaceInfo, FontFamily, FontFile, FontFormat, FontLicense } from "@/lib/contract";
import { sniffFontFormat } from "@/server/scan/fonts/binary";
import { parseFontBinary } from "@/server/scan/fonts/index";
import { classifyLicense } from "@/server/scan/fonts/license";
import { fontManifestPath, listInstalledFonts, removeRecordedFile, withFontStateLock, writeManifest } from "./font-manifest";
import { agentLimits } from "./limits";
import type { FontInstall } from "./types";

/**
 * Installing the fonts a page uses, not just downloading them (spec section 5): one file per family, WOFF2 decompressed
 * to the sfnt it wraps, written into the user font directory under a predictable name, and recorded in a manifest so
 * `listInstalledFonts` and `uninstallFonts` can work.
 *
 * Two rules the implementation is built around. A file this tool did not write is never touched: the target is opened
 * with `O_EXCL | O_NOFOLLOW`, and a name is only replaced when the manifest says this same family wrote it. And the
 * licence always comes from the bytes that were installed, whatever the scan believed, because that is the notice the
 * user is agreeing to; a commercial font installs too, with its licence reported (spec 5.5).
 */

/** Why a family was not installed. Every one of these is reported, never thrown. */
export type FontSkipReason =
  | "adobe-fonts"
  | "not-downloadable"
  | "no-latin-file"
  | "unsupported-format"
  | "fetch-failed"
  | "too-large"
  | "conversion-failed"
  /** The name is taken by something this tool did not write, or by another family that folds to the same name. */
  | "exists"
  /** The font directory would not take the file: no permission, a name the file system refuses, a full disk. */
  | "write-failed"
  | "unknown-family";

export interface FontSkipped {
  family: string;
  reason: FontSkipReason;
  /** The path, the message or the format that explains the reason, when there is one worth printing. */
  detail?: string;
}

export interface FontInstallReport {
  fontDir: string;
  manifestPath: string;
  installed: FontInstall[];
  skipped: FontSkipped[];
}

export interface InstallFontsOptions {
  /** The bytes of one font file. The CLI and the MCP server pass `ScanSource.fetchBytes`. */
  fetchBytes: (file: FontFile, options?: { signal?: AbortSignal }) => Promise<Buffer>;
  /** Family names to install, matched case insensitively. Every installable family when it is left out. */
  only?: string[];
  /** The host the page was scanned from, recorded when the family does not name its own. */
  pageHost?: string;
  signal?: AbortSignal;
}

/** Formats the installer can write: a WOFF or WOFF2 is decompressed, a TTF or OTF is installed as it is (spec 5.2). */
const INSTALLABLE_FORMATS = new Set<FontFormat>(["woff2", "woff", "ttf", "otf"]);
/** Formats that need no conversion, best first: installing them costs nothing and cannot fail. */
const NATIVE_FORMATS: FontFormat[] = ["ttf", "otf"];

/**
 * Where a font is installed so the system picks it up: `~/Library/Fonts` on macOS, `~/.local/share/fonts` elsewhere
 * (spec 5.3). `ASSETS_SCRAPER_FONT_DIR` overrides it, which is how the tests keep out of the real one.
 */
export function userFontDir(): string {
  const override = process.env.ASSETS_SCRAPER_FONT_DIR?.trim();
  if (override) return path.resolve(override);
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Fonts");
  return path.join(os.homedir(), ".local", "share", "fonts");
}

/**
 * Deletes the files of `families` (matched case insensitively) and forgets them. It never touches a file it did not
 * record, and never one outside the font directory, so a manifest that was edited or restored from elsewhere cannot turn
 * an uninstall into a delete of something else. A file it refuses stays recorded, because it is still installed.
 */
export function uninstallFonts(families: string[]): Promise<{ removed: FontInstall[]; missing: string[] }> {
  return withFontStateLock(() => removeFamilies(families));
}

async function removeFamilies(families: string[]): Promise<{ removed: FontInstall[]; missing: string[] }> {
  const fontDir = userFontDir();
  const installs = await listInstalledFonts();
  const wanted = new Map(families.map((family) => [family.trim().toLowerCase(), family]));
  const removed: FontInstall[] = [];
  const kept: FontInstall[] = [];

  for (const install of installs) {
    if (!wanted.has(install.family.toLowerCase())) {
      kept.push(install);
      continue;
    }
    const gone: string[] = [];
    const left: string[] = [];
    for (const file of install.files) {
      if (await removeRecordedFile(file, fontDir)) gone.push(file);
      else left.push(file);
    }
    removed.push({ ...install, files: gone });
    if (left.length > 0) kept.push({ ...install, files: left });
    wanted.delete(install.family.toLowerCase());
  }

  if (removed.length > 0) await writeManifest(kept);
  return { removed, missing: [...wanted.values()] };
}

/**
 * The longest a family may be in a file name. A CSS family name is allowed 1024 characters (`MAX_FAMILY_CHARS` in
 * `src/server/scan/fonts/css.ts`), and `<Family>-<Style>.ttf` has to fit the 255 byte limit of a file name, so it is cut
 * here rather than at the `open` call, the way `sanitizeHost` cuts a host.
 */
export const MAX_FAMILY_FILE_CHARS = 100;

/** `Söhne VF` to `SohneVF`: diacritics folded, everything that is not a letter or a digit dropped (spec 5.3). */
export function fileSafeFamily(name: string): string {
  const folded = name.normalize("NFKD").replace(/\p{Mn}+/gu, "");
  return folded.replace(/[^A-Za-z0-9]+/g, "").slice(0, MAX_FAMILY_FILE_CHARS) || "Font";
}

const WEIGHT_NAMES = new Map([
  [100, "Thin"], [200, "ExtraLight"], [300, "Light"], [400, "Regular"], [500, "Medium"],
  [600, "SemiBold"], [700, "Bold"], [800, "ExtraBold"], [900, "Black"],
]);

/** The numbers a `font-weight` names, or null for a range or a keyword this does not know. */
function weightOf(weight: string): number | null {
  const words = weight.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length !== 1) return null; // a variable range ("100 900"): the family installs as its regular face
  const [word] = words;
  if (word === "normal") return 400;
  if (word === "bold") return 700;
  const value = Number(word);
  if (!Number.isFinite(value)) return null;
  return [...WEIGHT_NAMES.keys()].reduce((best, step) => (Math.abs(step - value) < Math.abs(best - value) ? step : best), 400);
}

const isItalic = (style: string): boolean => /italic|oblique/i.test(style);

/** `Inter-Regular.ttf`, `Inter-BoldItalic.ttf`: the style the file name carries, from the face the installer picked. */
export function styleName(face: Pick<FontFaceInfo, "weight" | "style">): string {
  const weight = WEIGHT_NAMES.get(weightOf(face.weight) ?? 400) ?? "Regular";
  const italic = isItalic(face.style);
  if (!italic) return weight;
  return weight === "Regular" ? "Italic" : `${weight}Italic`;
}

/** Whether the bytes of a file can be had at all: they travel inline, or there is a URL to fetch them from. */
const hasBytes = (file: FontFile): boolean => file.inline !== undefined || file.url !== "";

interface Candidate {
  face: FontFaceInfo;
  file: FontFile;
}

/** The one file a family installs, or the reason there is none (spec 5.1). */
function pickFile(family: FontFamily): { candidate: Candidate } | { reason: FontSkipReason } {
  const latin: Candidate[] = family.faces.flatMap((face) =>
    face.files.filter((file) => file.coversLatin).map((file) => ({ face, file })),
  );
  if (latin.length === 0) return { reason: "no-latin-file" };
  const supported = latin.filter(({ file }) => INSTALLABLE_FORMATS.has(file.format));
  if (supported.length === 0) return { reason: "unsupported-format" };
  const reachable = supported.filter(({ file }) => hasBytes(file));
  if (reachable.length === 0) return { reason: "not-downloadable" };

  /** Best first: a loaded face, then the variable font, then upright, then the weight nearest regular, then no conversion. */
  const rank = ({ face, file }: Candidate): number[] => [
    face.loaded ? 0 : 1,
    weightOf(face.weight) === null ? 0 : 1,
    isItalic(face.style) ? 1 : 0,
    Math.abs((weightOf(face.weight) ?? 400) - 400),
    NATIVE_FORMATS.includes(file.format) ? 0 : 1,
  ];
  const sorted = [...reachable].sort((a, b) => {
    const left = rank(a);
    const right = rank(b);
    for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return left[index] - right[index];
    return 0;
  });
  return { candidate: sorted[0] };
}

/** Settles once the last decompression queued is done, without holding its output; see `toSfnt`. */
let decompressing: Promise<void> = Promise.resolve();

/**
 * The sfnt bytes a WOFF or WOFF2 file wraps, or null when they cannot be had. wawoff2 answers with a view of its
 * WebAssembly heap, which the next decompression overwrites (or detaches when the heap grows), and hands it over through
 * an `await`, so two conversions that reach it in the same turn corrupt each other before either copies: the bytes of one
 * family would be written under another family's name, with another font's licence read from them. Decompressions
 * therefore run one at a time, each copied out before the next starts, the same chain as `decompressWoff2` in
 * `src/server/security/font-convert.ts`. They block the main thread anyway, so this costs no throughput.
 *
 * WOFF (version 1) goes through the same call and is simply refused by it, which is the documented behavior: that family
 * is reported as not installable rather than installed wrong.
 *
 * Exported so the chain itself is tested, the way `font-convert.test.ts` tests the one it mirrors: with installs already
 * serialized, nothing else would notice if it were dropped.
 */
export function toSfnt(source: Buffer): Promise<Buffer | null> {
  const run = decompressing.then(async () => {
    try {
      const { decompress } = await import("wawoff2");
      return Buffer.from(await decompress(source));
    } catch {
      return null;
    }
  });
  decompressing = run.then(() => {});
  return run;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 200);

/**
 * Whether a failed open means the name is already taken, rather than the directory refusing the write. `ELOOP` is what a
 * symbolic link gives on a system that checks `O_NOFOLLOW` before `O_EXCL`, and `EISDIR` what a directory of that name
 * gives. Anything else (no permission, a name the file system refuses, a full disk) is a write failure and says so.
 */
const isNameTaken = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "EEXIST" || code === "ELOOP" || code === "EISDIR";
};

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
};

/**
 * Installs one file per family into the user font directory and records it (spec section 5). Nothing throws for a family
 * that cannot be installed: it lands in `skipped` with a reason, so an agent can report every family in one answer.
 *
 * One call runs at a time (`withFontStateLock`), which is what keeps the manifest whole when an agent installs the fonts
 * of two pages at once and what keeps the WOFF2 decompression safe (see `toSfnt`).
 */
export function installFonts(families: FontFamily[], options: InstallFontsOptions): Promise<FontInstallReport> {
  return withFontStateLock(() => installFamilies(families, options));
}

async function installFamilies(families: FontFamily[], options: InstallFontsOptions): Promise<FontInstallReport> {
  const fontDir = userFontDir();
  const installs = await listInstalledFonts();
  const installed: FontInstall[] = [];
  const skipped: FontSkipped[] = [];
  const skip = (family: string, reason: FontSkipReason, detail?: string): void => {
    skipped.push(detail === undefined ? { family, reason } : { family, reason, detail });
  };

  const requested = options.only?.map((name) => name.trim()).filter((name) => name !== "");
  const unknown = new Map(requested?.map((name) => [name.toLowerCase(), name]));
  const chosen =
    requested === undefined ? families
    : families.filter((family) => {
        const key = family.name.toLowerCase();
        if (!unknown.has(key)) return false;
        unknown.delete(key);
        return true;
      });

  const limit = agentLimits.fontInstallMaxBytes;
  /**
   * The family each recorded file belongs to, lower cased. A name is only replaced for the family that holds it: a name
   * this tool never wrote is left alone (spec 5.3), and so is one another family folded to (`Sohne` and `Söhne` both
   * become `Sohne-Regular.ttf`), which would otherwise leave two manifest entries pointing at one file.
   */
  const ownerOf = new Map<string, string>();
  for (const entry of installs) {
    for (const file of entry.files) if (!ownerOf.has(file)) ownerOf.set(file, entry.family.toLowerCase());
  }
  /** Files this call wrote, so two families that fold to the same file name do not silently overwrite each other. */
  const written = new Set<string>();

  for (const family of chosen) {
    if (options.signal?.aborted === true) break;
    // Adobe Fonts kits are excluded before anything else: the scan never exposes their bytes (spec 5).
    if (family.source === "adobe-fonts") {
      skip(family.name, "adobe-fonts");
      continue;
    }
    if (!family.downloadable) {
      skip(family.name, "not-downloadable");
      continue;
    }
    const picked = pickFile(family);
    if ("reason" in picked) {
      skip(family.name, picked.reason);
      continue;
    }
    const { face, file } = picked.candidate;

    let source: Buffer;
    try {
      source = await options.fetchBytes(file, options.signal ? { signal: options.signal } : undefined);
    } catch (error) {
      skip(family.name, "fetch-failed", message(error));
      continue;
    }
    if (source.length > limit) {
      skip(family.name, "too-large", `${source.length} bytes`);
      continue;
    }

    const sniffed = sniffFontFormat(source);
    let bytes = source;
    let converted = false;
    if (sniffed === "woff2" || sniffed === "woff") {
      const sfnt = await toSfnt(source);
      if (!sfnt) {
        skip(family.name, "conversion-failed", sniffed);
        continue;
      }
      bytes = sfnt;
      converted = true;
      if (bytes.length > limit) {
        skip(family.name, "too-large", `${bytes.length} bytes after conversion`);
        continue;
      }
    }
    const format = sniffFontFormat(bytes);
    if (format !== "ttf" && format !== "otf") {
      skip(family.name, "conversion-failed", format);
      continue;
    }

    const familyKey = family.name.toLowerCase();
    const target = path.join(fontDir, `${fileSafeFamily(family.name)}-${styleName(face)}.${format}`);
    const owner = ownerOf.get(target);
    if (written.has(target) || (owner !== undefined && owner !== familyKey)) {
      skip(family.name, "exists", target);
      continue;
    }

    // The licence of the bytes on disk, not of the scan: that is the notice the user is agreeing to (spec 5.5). It falls
    // back to what the scan read from the CSS and the network only when the binary carries no licence record at all.
    const meta = parseFontBinary(bytes);
    const fromBinary = meta ? classifyLicense(meta, family.source) : { kind: "unknown" as const };
    const license: FontLicense = fromBinary.kind === "unknown" ? family.license : fromBinary;

    // The exclusive open is the whole guard on the directory: the name is only removed first when the manifest says this
    // family wrote it, and anything else sitting there (a file, a directory, a symbolic link, a dangling one) refuses the
    // open. Nothing checks the name for existence ahead of it on purpose, so a file that appears while the bytes are being
    // fetched cannot slip through the window between a check and a write.
    try {
      await fsp.mkdir(fontDir, { recursive: true });
      if (owner === familyKey) await removeRecordedFile(target, fontDir);
      const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;
      const handle = await fsp.open(target, flags, 0o644);
      try {
        await handle.writeFile(bytes);
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (isNameTaken(error)) skip(family.name, "exists", target);
      else skip(family.name, "write-failed", `${target}: ${message(error)}`);
      continue;
    }
    ownerOf.set(target, familyKey);
    written.add(target);

    // A family installed before may have written another name (another style, or another extension). That file is this
    // tool's and it is no longer part of the family's install, so it goes now: left behind it would be a font no uninstall
    // can reach. One that cannot be removed stays recorded instead, so a later uninstall still knows about it.
    const previous = installs.findIndex((entry) => entry.family.toLowerCase() === familyKey);
    const orphans: string[] = [];
    if (previous !== -1) {
      for (const file of installs[previous].files) {
        if (file === target) continue;
        if (await removeRecordedFile(file, fontDir)) ownerOf.delete(file);
        else orphans.push(file);
      }
    }

    const install: FontInstall = {
      family: family.name,
      files: [...new Set([target, ...orphans])],
      license,
      sourceHost: family.sourceHost ?? options.pageHost ?? hostOf(file.url),
      installedAt: new Date().toISOString(),
      converted,
    };
    installed.push(install);
    if (previous === -1) installs.push(install);
    else installs[previous] = install;
  }

  for (const name of unknown.values()) skip(name, "unknown-family");

  return { fontDir, manifestPath: installed.length > 0 ? await writeManifest(installs) : fontManifestPath(), installed, skipped };
}
