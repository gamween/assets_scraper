import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FontInstall } from "./types";

/**
 * The record of every file the font installer wrote (spec 5.4). It is what lets `uninstallFonts` clean up, and what says
 * a name in the font directory is ours to replace, so it has to survive two calls that arrive at once and a manifest
 * that was edited by hand.
 *
 * Two rules live here. Every read-modify-write of the file runs inside `withFontStateLock`: the MCP SDK dispatches each
 * request as it arrives, so an agent asked to install the fonts of two pages issues both calls at once, and a plain
 * read-then-write would drop one call's entries (or fail its rename). And a recorded path is only ever deleted when it
 * sits inside the font directory, so the promise that this tool only removes files it created holds even for a manifest
 * that came from somewhere else.
 */

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

/**
 * Replaces the manifest atomically. The temporary name carries a random suffix as well as the pid, because two writers
 * in one process would otherwise pick the same path and the loser of the rename would fail with ENOENT after its font
 * was already written, leaving a file nothing can uninstall.
 */
export async function writeManifest(installs: FontInstall[]): Promise<string> {
  const file = fontManifestPath();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const manifest: FontManifest = { version: 1, installs };
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    await fsp.writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await fsp.rename(temporary, file);
  } catch (error) {
    await fsp.rm(temporary, { force: true });
    throw error;
  }
  return file;
}

/** Settles once every job queued before it is done, whether that job resolved or rejected. */
let pending: Promise<unknown> = Promise.resolve();

/**
 * Runs `job` after every job already queued, so an install or an uninstall reads the manifest, writes the font files and
 * writes the manifest back without another call interleaving. It also keeps the WOFF2 decompression one at a time, which
 * is what `toSfnt` needs. In process only: a second server process is still on its own, and the atomic rename plus the
 * `O_EXCL` open are what keep that case from corrupting anything.
 */
export function withFontStateLock<T>(job: () => Promise<T>): Promise<T> {
  const next = pending.then(job, job);
  pending = next.then(
    () => {},
    () => {},
  );
  return next;
}

/** Whether `file` sits under `dir`, by path alone: a symbolic link inside the directory is removed as the link it is. */
const isInside = (dir: string, file: string): boolean => {
  const root = path.resolve(dir);
  const target = path.resolve(file);
  return target !== root && target.startsWith(root + path.sep);
};

/**
 * Deletes one file the manifest records and says whether it is gone. It refuses a path outside `insideDir`, and the
 * removal is deliberately not recursive, so a recorded directory throws EISDIR instead of taking its contents with it.
 * Either way the caller learns the file is still there and can keep recording it, rather than forgetting a font that is
 * still installed and letting the whole uninstall fail.
 */
export async function removeRecordedFile(file: string, insideDir: string): Promise<boolean> {
  if (!isInside(insideDir, file)) return false;
  try {
    await fsp.rm(file, { force: true });
    return true;
  } catch {
    return false;
  }
}
