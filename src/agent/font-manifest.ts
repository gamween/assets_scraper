import crypto from "node:crypto";
import type { Stats } from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { FontInstall } from "./types";

/**
 * The record of every file the font installer wrote (spec 5.4). It is what lets `uninstallFonts` clean up, and what says
 * a name in the font directory is ours to replace, so it has to survive two calls that arrive at once, two server
 * processes that do, and a manifest that was edited by hand.
 *
 * Three rules live here. Every read-modify-write of the file runs inside `withFontStateLock`, which holds the calls of
 * this process in line and a lock file against every other process: two Claude Code sessions each run their own MCP
 * server, and two installs that read the same manifest and wrote it back in turn used to drop one side's entries,
 * leaving a font in the font directory that nothing could list or uninstall. A recorded path is only ever deleted when
 * it sits inside the font directory. And it is only deleted while it still holds the file this tool wrote, which the
 * manifest records the identity of: a user who removed the font in Font Book and later installed the official release
 * under the same name would otherwise have had it deleted by the next uninstall.
 */

/** Where the manifest lives: `~/.local/state/assets-scraper`, or `ASSETS_SCRAPER_STATE_DIR` or `XDG_STATE_HOME`. */
function stateDir(): string {
  const override = process.env.ASSETS_SCRAPER_STATE_DIR?.trim();
  if (override) return path.resolve(override);
  const xdg = process.env.XDG_STATE_HOME?.trim();
  return xdg ? path.join(xdg, "assets-scraper") : path.join(os.homedir(), ".local", "state", "assets-scraper");
}

export const fontManifestPath = (): string => path.join(stateDir(), "installed-fonts.json");

/** The lock file every process takes before it reads the manifest to change it. */
export const fontLockPath = (): string => `${fontManifestPath()}.lock`;

/**
 * What a file this tool wrote looked like right after the write. A path still holds that file when its size, its
 * modification time and its inode on its device all match: a file put there since, even one with the same bytes, is a
 * new inode.
 */
export interface WrittenFile {
  path: string;
  size: number;
  mtimeMs: number;
  ino: number;
  dev: number;
}

export const writtenFile = (file: string, stats: Pick<Stats, "size" | "mtimeMs" | "ino" | "dev">): WrittenFile => ({
  path: file,
  size: stats.size,
  mtimeMs: stats.mtimeMs,
  ino: stats.ino,
  dev: stats.dev,
});

/**
 * One install as the manifest keeps it: what `listInstalledFonts` shows, plus the identity of each file written. An
 * entry a version before this one recorded has no identities, so none of its files can be proven to be ours.
 */
export interface InstallRecord extends FontInstall {
  written: WrittenFile[];
}

/** The manifest on disk. `version` is there so a later shape can be recognized rather than guessed at. */
interface FontManifest {
  version: 2;
  installs: InstallRecord[];
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

const isWrittenFile = (value: unknown): value is WrittenFile => {
  if (typeof value !== "object" || value === null) return false;
  const file = value as Partial<WrittenFile>;
  return typeof file.path === "string" && [file.size, file.mtimeMs, file.ino, file.dev].every((number) => typeof number === "number");
};

/** The public part of a record: what an agent or a person is shown. */
export const publicInstall = ({ family, files, license, sourceHost, installedAt, converted }: InstallRecord): FontInstall => ({
  family,
  files,
  license,
  sourceHost,
  installedAt,
  converted,
});

/**
 * Every install this tool recorded, newest last, with the identity of each file. A manifest that is missing, unreadable
 * or not ours reads as empty: it only guards files, so a bad one must never stop an install, and the `O_EXCL` write is
 * what actually protects them.
 */
export async function readInstallRecords(): Promise<InstallRecord[]> {
  try {
    const parsed: unknown = JSON.parse(await fsp.readFile(fontManifestPath(), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return [];
    const installs = (parsed as { installs?: unknown }).installs;
    if (!Array.isArray(installs)) return [];
    return installs.filter(isFontInstall).map((install) => {
      const written = (install as Partial<InstallRecord>).written;
      return { ...publicInstall(install as InstallRecord), written: Array.isArray(written) ? written.filter(isWrittenFile) : [] };
    });
  } catch {
    return [];
  }
}

/** Every install this tool recorded, newest last, as it is shown. */
export async function listInstalledFonts(): Promise<FontInstall[]> {
  return (await readInstallRecords()).map(publicInstall);
}

/**
 * Replaces the manifest atomically. The temporary name carries a random suffix as well as the pid, because two writers
 * in one process would otherwise pick the same path and the loser of the rename would fail with ENOENT after its font
 * was already written, leaving a file nothing can uninstall.
 */
export async function writeManifest(installs: InstallRecord[]): Promise<string> {
  const file = fontManifestPath();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const manifest: FontManifest = { version: 2, installs };
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

/**
 * How long a lock file may go without its holder touching it before another process takes it over. The holder
 * touches it every `LOCK_HEARTBEAT_MS` for as long as the job runs, so only a holder that stopped (killed, or frozen)
 * lets it age this far.
 */
export const LOCK_STALE_MS = 30_000;
const LOCK_HEARTBEAT_MS = 5_000;
const LOCK_POLL_MS = 50;

interface LockOwner {
  pid: number;
  token: string;
}

const readLockOwner = async (file: string): Promise<Partial<LockOwner> | null> => {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8")) as Partial<LockOwner>;
  } catch {
    return null;
  }
};

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * Whether the lock at `file` was left behind: its holder is a process that no longer exists, or it has not been touched
 * for `LOCK_STALE_MS`. A lock whose content cannot be read yet (a holder between its create and its write) is judged
 * by its age alone.
 */
async function isStaleLock(file: string): Promise<boolean> {
  let stats: Stats;
  try {
    stats = await fsp.stat(file);
  } catch {
    return false; // Gone already: the next create decides.
  }
  if (Date.now() - stats.mtimeMs > LOCK_STALE_MS) return true;
  const owner = await readLockOwner(file);
  return typeof owner?.pid === "number" && Number.isSafeInteger(owner.pid) && owner.pid > 0 && !isAlive(owner.pid);
}

/**
 * Takes the lock file with an exclusive create, waiting while another live process holds it, and returns its release.
 * A lock left by a process that died is taken over. Two waiters that find the same stale lock at the same instant can
 * both take it; that needs a crash and a race together, and the atomic rename of the manifest still keeps the file whole.
 */
async function takeFileLock(signal?: AbortSignal): Promise<() => Promise<void>> {
  const file = fontLockPath();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const owner: LockOwner = { pid: process.pid, token: crypto.randomBytes(8).toString("hex") };
  for (;;) {
    signal?.throwIfAborted();
    try {
      await fsp.writeFile(file, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (await isStaleLock(file)) {
      await fsp.rm(file, { force: true });
      continue;
    }
    await sleep(LOCK_POLL_MS, undefined, signal ? { signal } : undefined);
  }
  const heartbeat = setInterval(() => {
    const now = new Date();
    void fsp.utimes(file, now, now).catch(() => {});
  }, LOCK_HEARTBEAT_MS);
  heartbeat.unref();
  return async () => {
    clearInterval(heartbeat);
    // Only our own lock goes: one taken over after this holder stalled belongs to someone else now.
    if ((await readLockOwner(file))?.token === owner.token) await fsp.rm(file, { force: true });
  };
}

/** Settles once every job queued before it is done, whether that job resolved or rejected. */
let pending: Promise<unknown> = Promise.resolve();

/**
 * Runs `job` after every job already queued in this process and while holding the lock file against every other one,
 * so an install or an uninstall reads the manifest, writes the font files and writes the manifest back without another
 * call interleaving. The in-process line also keeps the WOFF2 decompression one at a time, which `toSfnt` needs.
 * Aborting `signal` stops the wait for another process's lock.
 */
export function withFontStateLock<T>(job: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const locked = async (): Promise<T> => {
    const release = await takeFileLock(signal);
    try {
      return await job();
    } finally {
      await release();
    }
  };
  const next = pending.then(locked, locked);
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
 * What became of a recorded file: `removed` (deleted, or already gone), `changed` (something else holds the path now,
 * or the record cannot prove what it held, so it is left on disk and should be forgotten) or `kept` (it is ours but
 * could not be removed: outside the font directory, or refused by the file system, so it stays recorded).
 */
export type RecordedFileOutcome = "removed" | "changed" | "kept";

/**
 * Deletes one file the manifest records, when it is still the file this tool wrote. It refuses a path outside
 * `insideDir`, anything but a regular file (a directory is never removed with its contents, a symbolic link is never
 * followed), and a file whose identity is not `written`: the user's own font under a name this tool once used stays.
 */
export async function removeRecordedFile(file: string, insideDir: string, written: WrittenFile | undefined): Promise<RecordedFileOutcome> {
  if (!isInside(insideDir, file)) return "kept";
  let stats: Stats;
  try {
    stats = await fsp.lstat(file);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "removed" : "kept";
  }
  if (!stats.isFile() || !written || !sameFile(stats, written)) return "changed";
  try {
    await fsp.rm(file);
    return "removed";
  } catch {
    return "kept";
  }
}

const sameFile = (stats: Stats, written: WrittenFile): boolean =>
  stats.size === written.size && stats.mtimeMs === written.mtimeMs && stats.ino === written.ino && stats.dev === written.dev;
