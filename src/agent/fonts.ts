import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FontFaceInfo, FontFamily, FontFile, FontLicense } from "@/lib/contract";
import { sniffFontFormat } from "@/server/scan/fonts/binary";
import { parseFontBinary } from "@/server/scan/fonts/index";
import { classifyLicense } from "@/server/scan/fonts/license";
import { type FontCandidate, fontCandidates, isItalic, type NoCandidateReason, WEIGHT_NAMES, weightOf } from "./font-candidates";
import {
  fontManifestPath,
  type InstallRecord,
  publicInstall,
  readInstallRecords,
  removeRecordedFile,
  withFontStateLock,
  type WrittenFile,
  writeManifest,
  writtenFile,
} from "./font-manifest";
import { agentLimits } from "./limits";
import type { FontInstall } from "./types";
import { woffToSfnt } from "./woff";

/**
 * Installing the fonts a page uses, not just downloading them (spec section 5): one file per family, WOFF2 and WOFF
 * decompressed to the sfnt they wrap, written into the user font directory under a predictable name, and recorded in a manifest so
 * `listInstalledFonts` and `uninstallFonts` can work.
 *
 * Two rules the implementation is built around. A file this tool did not write is never touched: the target is opened
 * with `O_EXCL | O_NOFOLLOW`, and a name is only replaced or removed when the manifest says this same family wrote it
 * and the file there is still the one it wrote (`removeRecordedFile`). And the licence always comes from the bytes that
 * were installed, whatever the scan believed, because that is the notice the
 * user is agreeing to; a commercial font installs too, with its licence reported (spec 5.5).
 */

/** Why a family was not installed. Every one of these is reported, never thrown. */
export type FontSkipReason =
  | NoCandidateReason
  | "fetch-failed"
  | "too-large"
  | "conversion-failed"
  /** The name is taken by something this tool did not write, or by another family that folds to the same name. */
  | "exists"
  /** The font directory would not take the file: no permission, a name the file system refuses, a full disk. */
  | "write-failed"
  | "unknown-family";

interface FontSkipped {
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

/** Families an `unknown-family` skip names back, so the detail stays one readable line on a page with dozens. */
const MAX_NAMED_FAMILIES = 12;

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

/** What an uninstall says: what went, what was never installed, what is recorded but still on disk, and what is not ours. */
export interface FontUninstallReport {
  removed: FontInstall[];
  /** Families this tool never installed. */
  missing: string[];
  /** Families it records but could not remove a single file of, with the files still there. They stay in the manifest. */
  stillInstalled: { family: string; files: string[] }[];
  /**
   * Recorded files that no longer hold what this tool wrote, or that a version before this one recorded without the
   * identity that would prove it: another font now sits at that path. They are left on disk and forgotten.
   */
  changed: { family: string; files: string[] }[];
}

/**
 * Deletes the files of `families` (matched case insensitively) and forgets them. It never touches a file it did not
 * record, never one outside the font directory, and never one that is no longer the file it wrote, so a manifest that
 * was edited or restored from elsewhere, or a font the user installed under a name this tool once used, cannot turn an
 * uninstall into a delete of something else. A file it refuses stays recorded, because it is still installed; a file
 * that is not ours any more is forgotten and left where it is.
 *
 * A family none of whose files could be removed is reported under `stillInstalled` rather than as removed with an empty
 * file list: with `ASSETS_SCRAPER_FONT_DIR` pointing elsewhere, or a manifest restored from another machine, every path
 * fails the `isInside` check and the answer used to read `removed` while the font was still installed (review issue 20).
 */
export function uninstallFonts(families: string[]): Promise<FontUninstallReport> {
  return withFontStateLock(() => removeFamilies(families));
}

/** The identity the record kept for `file`, if it kept one. */
const writtenOf = (record: InstallRecord, file: string): WrittenFile | undefined => record.written.find((entry) => entry.path === file);

/** A record narrowed to `files`, with only their identities. */
const narrowed = (record: InstallRecord, files: string[]): InstallRecord => ({
  ...record,
  files,
  written: record.written.filter((entry) => files.includes(entry.path)),
});

async function removeFamilies(families: string[]): Promise<FontUninstallReport> {
  const fontDir = userFontDir();
  const records = await readInstallRecords();
  const wanted = new Map(families.map((family) => [family.trim().toLowerCase(), family]));
  const report: FontUninstallReport = { removed: [], missing: [], stillInstalled: [], changed: [] };
  const kept: InstallRecord[] = [];

  for (const record of records) {
    if (!wanted.has(record.family.toLowerCase())) {
      kept.push(record);
      continue;
    }
    const gone: string[] = [];
    const left: string[] = [];
    const changed: string[] = [];
    for (const file of record.files) {
      const outcome = await removeRecordedFile(file, fontDir, writtenOf(record, file));
      (outcome === "removed" ? gone : outcome === "changed" ? changed : left).push(file);
    }
    if (gone.length > 0) report.removed.push({ ...publicInstall(record), files: gone });
    else if (left.length > 0) report.stillInstalled.push({ family: record.family, files: left });
    if (changed.length > 0) report.changed.push({ family: record.family, files: changed });
    if (left.length > 0) kept.push(narrowed(record, left));
    wanted.delete(record.family.toLowerCase());
  }

  report.missing = [...wanted.values()];
  if (report.removed.length > 0 || report.changed.length > 0) await writeManifest(kept);
  return report;
}

/**
 * The longest a family may be in a file name. A CSS family name is allowed 1024 characters (`MAX_FAMILY_CHARS` in
 * `src/server/scan/fonts/css.ts`), and `<Family>-<Style>.ttf` has to fit the 255 byte limit of a file name, so it is cut
 * here rather than at the `open` call, the way `sanitizeHost` cuts a host.
 */
const MAX_FAMILY_FILE_CHARS = 100;

/** `Söhne VF` to `SohneVF`: diacritics folded, everything that is not a letter or a digit dropped (spec 5.3). */
function fileSafeFamily(name: string): string {
  const folded = name.normalize("NFKD").replace(/\p{Mn}+/gu, "");
  return folded.replace(/[^A-Za-z0-9]+/g, "").slice(0, MAX_FAMILY_FILE_CHARS) || "Font";
}


/** `Inter-Regular.ttf`, `Inter-BoldItalic.ttf`: the style the file name carries, from the face the installer picked. */
function styleName(face: Pick<FontFaceInfo, "weight" | "style">): string {
  const weight = WEIGHT_NAMES.get(weightOf(face.weight) ?? 400) ?? "Regular";
  const italic = isItalic(face.style);
  if (!italic) return weight;
  return weight === "Regular" ? "Italic" : `${weight}Italic`;
}

/** Settles once the last decompression queued is done, without holding its output; see `toSfnt`. */
let decompressing: Promise<void> = Promise.resolve();

/**
 * The sfnt bytes a WOFF2 or WOFF file wraps, or null when they cannot be had. WOFF (version 1) is plain zlib per table
 * and converts here (`woffToSfnt`), up to `maxBytes` of sfnt. WOFF2 goes to wawoff2, which answers with a view of its
 * WebAssembly heap, which the next decompression overwrites (or detaches when the heap grows), and hands it over through
 * an `await`, so two conversions that reach it in the same turn corrupt each other before either copies: the bytes of one
 * family would be written under another family's name, with another font's licence read from them. Decompressions
 * therefore run one at a time, each copied out before the next starts, the same chain as `decompressWoff2` in
 * `src/server/security/font-convert.ts`. They block the main thread anyway, so this costs no throughput.
 *
 * Exported so the chain itself is tested, the way `font-convert.test.ts` tests the one it mirrors: with installs already
 * serialized, nothing else would notice if it were dropped.
 */
export function toSfnt(source: Buffer, maxBytes: number = agentLimits.fontInstallMaxBytes): Promise<Buffer | null> {
  if (sniffFontFormat(source) === "woff") return Promise.resolve(woffToSfnt(source, maxBytes));
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

/** A font file fetched and converted, ready to write: the face it came from names the file. */
interface AcquiredFont extends FontCandidate {
  bytes: Buffer;
  format: "ttf" | "otf";
  converted: boolean;
}

/**
 * The first candidate whose bytes can be fetched and turned into an installable sfnt, or why none could. A family whose
 * best file is broken, or served as a format that turns out not to convert, still installs from the next one; only when
 * every candidate failed is the family skipped, with the reason its best candidate gave.
 */
async function acquireFont(candidates: FontCandidate[], options: InstallFontsOptions): Promise<AcquiredFont | { reason: FontSkipReason; detail: string }> {
  const limit = agentLimits.fontInstallMaxBytes;
  let first: { reason: FontSkipReason; detail: string } | null = null;
  const failed = (reason: FontSkipReason, detail: string): void => {
    first ??= { reason, detail };
  };
  for (const { face, file } of candidates) {
    if (options.signal?.aborted === true) break;
    let source: Buffer;
    try {
      source = await options.fetchBytes(file, options.signal ? { signal: options.signal } : undefined);
    } catch (error) {
      failed("fetch-failed", message(error));
      continue;
    }
    if (source.length > limit) {
      failed("too-large", `${source.length} bytes`);
      continue;
    }
    const sniffed = sniffFontFormat(source);
    let bytes = source;
    const converted = sniffed === "woff2" || sniffed === "woff";
    if (converted) {
      const sfnt = await toSfnt(source, limit);
      if (!sfnt) {
        failed("conversion-failed", sniffed);
        continue;
      }
      if (sfnt.length > limit) {
        failed("too-large", `${sfnt.length} bytes after conversion`);
        continue;
      }
      bytes = sfnt;
    }
    const format = sniffFontFormat(bytes);
    if (format !== "ttf" && format !== "otf") {
      failed("conversion-failed", format);
      continue;
    }
    return { face, file, bytes, format, converted };
  }
  return first ?? { reason: "fetch-failed", detail: "cancelled" };
}

/**
 * Installs one file per family into the user font directory and records it (spec section 5). Nothing throws for a family
 * that cannot be installed: it lands in `skipped` with a reason, so an agent can report every family in one answer.
 *
 * One call runs at a time (`withFontStateLock`), across processes too, which is what keeps the manifest whole when an
 * agent installs the fonts of two pages at once, or two sessions do, and what keeps the WOFF2 decompression safe (see
 * `toSfnt`).
 */
export function installFonts(families: FontFamily[], options: InstallFontsOptions): Promise<FontInstallReport> {
  return withFontStateLock(() => installFamilies(families, options), options.signal);
}

async function installFamilies(families: FontFamily[], options: InstallFontsOptions): Promise<FontInstallReport> {
  const fontDir = userFontDir();
  const records = await readInstallRecords();
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

  /**
   * The family each recorded file belongs to, lower cased. A name is only replaced for the family that holds it: a name
   * this tool never wrote is left alone (spec 5.3), and so is one another family folded to (`Sohne` and `Söhne` both
   * become `Sohne-Regular.ttf`), which would otherwise leave two manifest entries pointing at one file.
   */
  const ownerOf = new Map<string, string>();
  for (const entry of records) {
    for (const file of entry.files) if (!ownerOf.has(file)) ownerOf.set(file, entry.family.toLowerCase());
  }
  /** Files this call wrote, so two families that fold to the same file name do not silently overwrite each other. */
  const written = new Set<string>();
  /** Whether the manifest has something to say that it did not: an install, or a recorded file found not to be ours. */
  let dirty = false;
  /** Drops a recorded path whose file is not the one this tool wrote any more: it is not ours to remove or to keep. */
  const forget = (file: string): void => {
    const remaining = records
      .map((record) => (record.files.includes(file) ? narrowed(record, record.files.filter((entry) => entry !== file)) : record))
      .filter((record) => record.files.length > 0);
    records.splice(0, records.length, ...remaining);
    ownerOf.delete(file);
    dirty = true;
  };
  const recordOf = (familyKey: string): InstallRecord | undefined => records.find((entry) => entry.family.toLowerCase() === familyKey);

  const cancelled = (): boolean => options.signal?.aborted === true;
  for (const family of chosen) {
    if (cancelled()) break;
    const picked = fontCandidates(family);
    if ("reason" in picked) {
      skip(family.name, picked.reason);
      continue;
    }
    const acquired = await acquireFont(picked.candidates, options);
    if ("reason" in acquired) {
      if (cancelled()) break;
      skip(family.name, acquired.reason, acquired.detail);
      continue;
    }
    const { face, file, bytes, format, converted } = acquired;

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
    // family wrote it and the file there is still that one, and anything else sitting there (a file, a directory, a
    // symbolic link, a dangling one) refuses the open. Nothing checks the name for existence ahead of it on purpose, so a
    // file that appears while the bytes are being fetched cannot slip through the window between a check and a write.
    let identity: WrittenFile;
    try {
      await fsp.mkdir(fontDir, { recursive: true });
      const own = owner === familyKey ? recordOf(familyKey) : undefined;
      if (own && (await removeRecordedFile(target, fontDir, writtenOf(own, target))) === "changed") forget(target);
      const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;
      const handle = await fsp.open(target, flags, 0o644);
      try {
        await handle.writeFile(bytes);
        identity = writtenFile(target, await handle.stat());
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
    // can reach. One that cannot be removed stays recorded instead, so a later uninstall still knows about it, and one
    // that is not the file this tool wrote any more is forgotten and left alone.
    const orphans: WrittenFile[] = [];
    const orphanPaths: string[] = [];
    const before = recordOf(familyKey);
    if (before) {
      for (const recorded of before.files) {
        if (recorded === target) continue;
        const outcome = await removeRecordedFile(recorded, fontDir, writtenOf(before, recorded));
        if (outcome === "kept") {
          orphanPaths.push(recorded);
          const kept = writtenOf(before, recorded);
          if (kept) orphans.push(kept);
        } else {
          ownerOf.delete(recorded);
        }
      }
    }

    const record: InstallRecord = {
      family: family.name,
      files: [target, ...orphanPaths],
      license,
      sourceHost: family.sourceHost ?? options.pageHost ?? hostOf(file.url),
      installedAt: new Date().toISOString(),
      converted,
      written: [identity, ...orphans],
    };
    installed.push(publicInstall(record));
    const previous = before ? records.indexOf(before) : -1;
    if (previous === -1) records.push(record);
    else records[previous] = record;
    dirty = true;
  }

  // Naming the families the scan does hold, so an agent that slipped on a diacritic can correct itself from the answer
  // rather than having to call scan_page again (review issue 14).
  const available = families.map((family) => family.name).slice(0, MAX_NAMED_FAMILIES).join(", ");
  const detail =
    families.length === 0 ? "this page declares no font family"
    : `this page has ${available}${families.length > MAX_NAMED_FAMILIES ? ` and ${families.length - MAX_NAMED_FAMILIES} more` : ""}`;
  for (const name of unknown.values()) skip(name, "unknown-family", detail);

  return { fontDir, manifestPath: dirty ? await writeManifest(records) : fontManifestPath(), installed, skipped };
}
