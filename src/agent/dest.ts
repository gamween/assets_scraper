import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Where a download lands, and the guard that keeps every write inside it (spec 2 destination, spec 10).
 *
 * The rule, strongest first: an explicit `dest`, then `ASSETS_SCRAPER_OUT`, then `<project root>/scrap/<host>` where
 * the project root is the git root of the working directory or the nearest directory holding `package.json`,
 * `pyproject.toml` or `.claude`, and finally `~/Downloads/assets-scraper/<host>` when there is no project.
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
}

/**
 * A host as a directory name: `www.` off, lower case, punycode kept as it is, and nothing that could leave the
 * directory (path separators, colons, `..`). Empty after that, it becomes `site`.
 */
export function sanitizeHost(host: string): string {
  const safe = host
    .trim()
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[.-]+|[.-]+$/g, "");
  return safe || "site";
}

/** The git root of `cwd`, or the nearest directory above it holding a project marker, or null. */
export function findProjectRoot(cwd: string): string | null {
  const start = path.resolve(cwd);
  for (const dir of ancestors(start)) if (fs.existsSync(path.join(dir, ".git"))) return dir;
  for (const dir of ancestors(start)) {
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

export function resolveDestination(options: DestinationOptions = {}): Destination {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const host = sanitizeHost(options.host ?? "");

  if (options.dest !== undefined && options.dest !== "") {
    const dir = path.resolve(cwd, options.dest);
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

/**
 * The real path of `target`: the deepest ancestor that exists resolved through its symlinks, with the missing tail
 * appended. A path that does not exist yet is still checked against the links that lead to it.
 */
function realExisting(target: string): string {
  const tail: string[] = [];
  let dir = path.resolve(target);
  for (;;) {
    try {
      return path.join(fs.realpathSync(dir), ...tail.reverse());
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return path.resolve(target);
      tail.push(path.basename(dir));
      dir = parent;
    }
  }
}

/**
 * The absolute real path of `target` inside `root`, or an error. A relative `target` is taken as relative to `root`.
 * `..` segments, an absolute path elsewhere and a symlink pointing out of `root` are all refused, so callers can write
 * to the returned path with nothing left to check.
 */
export function assertInside(root: string, target: string): string {
  const resolvedRoot = realExisting(root);
  const resolved = realExisting(path.resolve(root, target));
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`refusing to write outside ${resolvedRoot}: ${target}`);
  }
  return resolved;
}
