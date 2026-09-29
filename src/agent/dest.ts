import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sanitizeHost } from "./names";

/**
 * Where a download lands, and the guard that keeps every write inside it (spec 2 destination, spec 10).
 *
 * The rule, strongest first: an explicit `dest`, then `ASSETS_SCRAPER_OUT`, then `<project root>/scrap/<host>` where
 * the project root is the git root of the working directory or the nearest directory holding `package.json`,
 * `pyproject.toml` or `.claude`, and finally `~/Downloads/assets-scraper/<host>` when there is no project. The home
 * directory itself is never a project root, so a session started outside one lands in the fallback rather than writing
 * into the top of the user's home. A `dest` that came from an agent goes through `restrictToProject`, which confines it
 * to the scrap directory.
 */

/** The directory name a download writes into inside a project. */
export const SCRAP_DIR_NAME = "scrap";

/** Where the fallback lands, relative to the home directory. */
export const FALLBACK_SEGMENTS = ["Downloads", "assets-scraper"] as const;

const PROJECT_MARKERS = ["package.json", "pyproject.toml", ".claude"] as const;

export interface Destination {
  /** Absolute directory the files go in. Every write is checked against it with `assertInside`. */
  dir: string;
  /** Absolute directory `dir` was derived from: the project root, the explicit dest, or the fallback directory. */
  projectRoot: string;
  /** The sanitized host, as it appears in `dir` under the project rule. */
  host: string;
  /** True when there was no project and the fallback directory was used. */
  fallback: boolean;
}

export interface DestinationOptions {
  /** The scanned host, sanitized before it becomes a directory name. */
  host?: string;
  /** Working directory the project rule walks up from, and relative paths resolve against. Defaults to `process.cwd()`. */
  cwd?: string;
  /** An explicit destination directory. Used as is, with no host segment appended. */
  dest?: string;
  /**
   * Refuses an explicit `dest` that is not inside `<project root>/scrap`, or inside the fallback directory when there is
   * no project. Every caller that takes a `dest` from an agent (the MCP `download_assets` tool, the ZIP endpoint) sets
   * this. The project root itself is not enough: it would let an agent-supplied path drop scraped files into `src/`, and
   * the destination this tool offers is the scrap folder. The CLI leaves it off, because a `--out` the user typed is the
   * user's own choice of where their files go.
   */
  restrictToProject?: boolean;
}

/**
 * The home directory is never a project, whatever it holds. `~/.claude` exists on every machine Claude Code has run on,
 * and a dotfiles checkout puts `.git` there too, so without this any working directory under home that is not itself in
 * a project resolved to home: files landed in `~/scrap/<host>` instead of the documented `~/Downloads` fallback, and the
 * guard on an agent-supplied `dest` widened from a real project to the whole home directory (review issue 9).
 */
const isHome = (dir: string): boolean => dir === path.resolve(os.homedir());

/** The git root of `cwd`, or the nearest directory above it holding a project marker, or null. */
export function findProjectRoot(cwd: string): string | null {
  const start = path.resolve(cwd);
  for (const dir of ancestors(start)) if (!isHome(dir) && fs.existsSync(path.join(dir, ".git"))) return dir;
  for (const dir of ancestors(start)) {
    if (isHome(dir)) continue;
    for (const marker of PROJECT_MARKERS) if (fs.existsSync(path.join(dir, marker))) return dir;
  }
  return null;
}

function* ancestors(from: string): Generator<string> {
  let dir = from;
  for (;;) {
    yield dir;
    const parent = path.dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

/** The one directory an agent-supplied `dest` may write inside: the project's scrap folder, or the fallback directory. */
function scrapRoot(cwd: string): string {
  const projectRoot = findProjectRoot(cwd);
  return projectRoot ? path.join(projectRoot, SCRAP_DIR_NAME) : path.join(os.homedir(), ...FALLBACK_SEGMENTS);
}

export function resolveDestination(options: DestinationOptions = {}): Destination {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const host = sanitizeHost(options.host ?? "");

  if (options.dest !== undefined && options.dest !== "") {
    const dir = path.resolve(cwd, options.dest);
    if (options.restrictToProject === true) assertInside(scrapRoot(cwd), dir);
    return { dir, projectRoot: dir, host, fallback: false };
  }

  const out = process.env.ASSETS_SCRAPER_OUT?.trim();
  if (out) {
    const projectRoot = path.resolve(cwd, out);
    return { dir: path.join(projectRoot, host), projectRoot, host, fallback: false };
  }

  const projectRoot = findProjectRoot(cwd);
  if (projectRoot) return { dir: path.join(projectRoot, SCRAP_DIR_NAME, host), projectRoot, host, fallback: false };

  const fallbackRoot = path.join(os.homedir(), ...FALLBACK_SEGMENTS);
  return { dir: path.join(fallbackRoot, host), projectRoot: fallbackRoot, host, fallback: true };
}

/** True when `target` itself is a symbolic link, whatever it points at. */
const isSymbolicLink = (target: string): boolean => {
  try {
    return fs.lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
};

/**
 * The real path of `target`: the deepest ancestor that exists resolved through its symlinks, with the missing tail
 * appended. A path that does not exist yet is still checked against the links that lead to it.
 *
 * A component `realpathSync` cannot resolve but that does exist as a link is a dangling symlink, and it is refused:
 * treating it as a plain missing name would rejoin it under the resolved parent and hand back a path that reads as
 * inside the root while a write through it lands wherever the link points.
 */
function realExisting(target: string): string {
  const tail: string[] = [];
  let dir = path.resolve(target);
  for (;;) {
    try {
      return path.join(fs.realpathSync(dir), ...tail.reverse());
    } catch {
      if (isSymbolicLink(dir)) throw new Error(`refusing to follow the symlink ${dir}`);
      const parent = path.dirname(dir);
      if (parent === dir) return path.resolve(target);
      tail.push(path.basename(dir));
      dir = parent;
    }
  }
}

/**
 * The absolute real path of `target` inside `root`, or an error. A relative `target` is taken as relative to `root`.
 * `..` segments, an absolute path elsewhere and a symlink anywhere on the way, resolvable or dangling, are all refused.
 *
 * What it does not give a caller: the check is a check at one instant, so a link planted between this call and the
 * write would still be followed. Anything that creates a file uses `createFileInside`, which opens the path with
 * `O_EXCL | O_NOFOLLOW`, rather than trusting the string this returns.
 */
export function assertInside(root: string, target: string): string {
  const resolvedRoot = realExisting(root);
  const resolved = realExisting(path.resolve(root, target));
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`refusing to write outside ${resolvedRoot}: ${target}`);
  }
  return resolved;
}

/** Mode a downloaded file is created with: readable, and writable only by its owner. */
const FILE_MODE = 0o644;

/**
 * Creates `target` inside `root` for writing and returns the open descriptor, which the caller closes. The parent
 * directories are created as needed. `O_EXCL` refuses a name that already exists, so nothing is ever overwritten, and
 * `O_NOFOLLOW` refuses a symlink at the final component, whether or not it resolves, so a link planted after
 * `assertInside` checked cannot redirect the file. A parent directory swapped for a link in that same window is not
 * covered: the destination is a directory this tool made, so that is a race with whoever can already write there.
 */
export function createFileInside(root: string, target: string): { path: string; fd: number } {
  const resolved = assertInside(root, target);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;
  return { path: resolved, fd: fs.openSync(resolved, flags, FILE_MODE) };
}
