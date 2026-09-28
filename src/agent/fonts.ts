import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FontFaceInfo, FontFamily, FontFile, FontFormat, FontLicense } from "@/lib/contract";
import { sniffFontFormat } from "@/server/scan/fonts/binary";
import { parseFontBinary } from "@/server/scan/fonts/index";
import { classifyLicense } from "@/server/scan/fonts/license";
import { agentLimits } from "./limits";
import type { FontInstall } from "./types";

/**
 * Installing the fonts a page uses, not just downloading them (spec section 5): one file per family, WOFF2 decompressed
 * to the sfnt it wraps, written into the user font directory under a predictable name, and recorded in a manifest so
 * `listInstalledFonts` and `uninstallFonts` can work.
 *
 * Two rules the implementation is built around. A file this tool did not write is never touched: the target is opened
 * with `O_EXCL | O_NOFOLLOW`, and a name that already exists is only replaced when the manifest says it is ours. And the
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
  | "exists"
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

/** Where the manifest lives: `~/.local/state/assets-scraper`, or `ASSETS_SCRAPER_STATE_DIR` or `XDG_STATE_HOME`. */
export function stateDir(): string {
  const override = process.env.ASSETS_SCRAPER_STATE_DIR?.trim();
  if (override) return path.resolve(override);
  const xdg = process.env.XDG_STATE_HOME?.trim();
  return xdg ? path.join(xdg, "assets-scraper") : path.join(os.homedir(), ".local", "state", "assets-scraper");
}

export const fontManifestPath = (): string => path.join(stateDir(), "installed-fonts.json");

/** The manifest on disk. `version` is there so a later shape can be recognized rather than guessed at. */
interface FontManifest {
  version: 1;
  installs: FontInstall[];
}

const isFontInstall = (value: unknown): value is FontInstall => {
  if (typeof value !== "object" || value === null) return false;
  const install = value as Partial<FontInstall>;
  return (
    typeof install.family === "string" &&
    Array.isArray(install.files) &&
    install.files.every((file) => typeof file === "string") &&
    typeof install.license === "object" &&
    install.license !== null &&
    typeof install.sourceHost === "string" &&
    typeof install.installedAt === "string" &&
    typeof install.converted === "boolean"
  );
};

/**
 * Every install this tool recorded, newest last. A manifest that is missing, unreadable or not ours reads as empty: it
 * only guards files, so a bad one must never stop an install, and the `O_EXCL` write is what actually protects them.
 */
export async function listInstalledFonts(): Promise<FontInstall[]> {
  try {
    const parsed: unknown = JSON.parse(await fsp.readFile(fontManifestPath(), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return [];
    const installs = (parsed as Partial<FontManifest>).installs;
    return Array.isArray(installs) ? installs.filter(isFontInstall) : [];
  } catch {
    return [];
  }
}

async function writeManifest(installs: FontInstall[]): Promise<string> {
  const file = fontManifestPath();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const manifest: FontManifest = { version: 1, installs };
  const temporary = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await fsp.rename(temporary, file);
  return file;
}

/** Deletes the files of `families` (matched case insensitively) and forgets them. Never touches a file it did not record. */
export async function uninstallFonts(families: string[]): Promise<{ removed: FontInstall[]; missing: string[] }> {
  const installs = await listInstalledFonts();
  const wanted = new Map(families.map((family) => [family.trim().toLowerCase(), family]));
  const removed: FontInstall[] = [];
  const kept: FontInstall[] = [];

  for (const install of installs) {
    if (!wanted.has(install.family.toLowerCase())) {
      kept.push(install);
      continue;
    }
    for (const file of install.files) await fsp.rm(file, { force: true });
    removed.push(install);
    wanted.delete(install.family.toLowerCase());
  }

  if (removed.length > 0) await writeManifest(kept);
  return { removed, missing: [...wanted.values()] };
}

/** `Söhne VF` to `SohneVF`: diacritics folded, everything that is not a letter or a digit dropped (spec 5.3). */
export function fileSafeFamily(name: string): string {
  const folded = name.normalize("NFKD").replace(/\p{Mn}+/gu, "");
  return folded.replace(/[^A-Za-z0-9]+/g, "") || "Font";
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

/**
 * The sfnt bytes a WOFF or WOFF2 file wraps, or null when they cannot be had. wawoff2 answers with a view of its
 * WebAssembly heap that the next decompression overwrites, so the copy happens here, before anything else awaits, and
 * installs run one family at a time. WOFF (version 1) goes through the same call and is simply refused by it, which is
 * the documented behavior: that family is reported as not installable rather than installed wrong.
 */
async function toSfnt(source: Buffer): Promise<Buffer | null> {
  try {
    const { decompress } = await import("wawoff2");
    return Buffer.from(await decompress(source));
  } catch {
    return null;
  }
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 200);

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
 * Families are installed one at a time, which is what keeps the WOFF2 decompression safe (see `toSfnt`).
 */
export async function installFonts(families: FontFamily[], options: InstallFontsOptions): Promise<FontInstallReport> {
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
  /** Files this tool wrote, so a name it owns is replaced and a name it does not own is left alone (spec 5.3). */
  const ours = new Set(installs.flatMap((install) => install.files));
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

    const target = path.join(fontDir, `${fileSafeFamily(family.name)}-${styleName(face)}.${format}`);
    if (written.has(target) || (!ours.has(target) && fs.existsSync(target))) {
      skip(family.name, "exists", target);
      continue;
    }

    // The licence of the bytes on disk, not of the scan: that is the notice the user is agreeing to (spec 5.5). It falls
    // back to what the scan read from the CSS and the network only when the binary carries no licence record at all.
    const meta = parseFontBinary(bytes);
    const fromBinary = meta ? classifyLicense(meta, family.source) : { kind: "unknown" as const };
    const license: FontLicense = fromBinary.kind === "unknown" ? family.license : fromBinary;

    // `O_EXCL | O_NOFOLLOW` is what actually guards the directory: the name is only removed first when the manifest says
    // this tool wrote it, and anything else already sitting there (a file, a symlink, a dangling one) refuses the open.
    try {
      await fsp.mkdir(fontDir, { recursive: true });
      if (ours.has(target)) await fsp.rm(target, { force: true });
      const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;
      const handle = await fsp.open(target, flags, 0o644);
      try {
        await handle.writeFile(bytes);
      } finally {
        await handle.close();
      }
    } catch (error) {
      skip(family.name, "exists", `${target}: ${message(error)}`);
      continue;
    }
    ours.add(target);
    written.add(target);

    const install: FontInstall = {
      family: family.name,
      files: [target],
      license,
      sourceHost: family.sourceHost ?? options.pageHost ?? hostOf(file.url),
      installedAt: new Date().toISOString(),
      converted,
    };
    installed.push(install);
    const previous = installs.findIndex((entry) => entry.family.toLowerCase() === family.name.toLowerCase());
    if (previous === -1) installs.push(install);
    else installs[previous] = install;
  }

  for (const name of unknown.values()) skip(name, "unknown-family");

  return { fontDir, manifestPath: installed.length > 0 ? await writeManifest(installs) : fontManifestPath(), installed, skipped };
}
