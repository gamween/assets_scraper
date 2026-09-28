#!/usr/bin/env node
// Starts the MCP server for the Claude Code plugin (agent access spec section 9).
//   node scripts/mcp-launcher.mjs
// dist/ is gitignored and built by `pnpm build:agent`, so a clone can have no dist/mcp.mjs at all, or one built before
// the last edit to src/. Starting it as it is serves old behavior in silence, which is the worst answer a tool can
// give. This launcher rebuilds the bundle when it is older than the sources it is bundled from, says on stderr why it
// could not when it could not, and only then hands over to the server.
//
// Nothing here ever writes to stdout: that is the MCP stdio transport, and one stray line makes the whole session
// unreadable. Build output is forwarded to stderr.
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The repo, from this file rather than from the working directory: the plugin starts the launcher from anywhere. */
export const ROOT = fileURLToPath(new URL("..", import.meta.url));

export const BUNDLE = "dist/mcp.mjs";

/**
 * Everything the bundle is built from. `src/agent` and `src/server` are the server itself and the scan engine it
 * drives; `src/lib` holds `contract.ts`, which both sides of every shape come from, so an edit there changes the
 * bundle as surely as an edit to the other two.
 */
export const SOURCE_DIRS = ["src/agent", "src/server", "src/lib"];

/**
 * Directories under `SOURCE_DIRS` that are build output, not source. `scripts/build-inpage.mjs` rewrites
 * `src/server/scan/inpage/generated/*.ts` on every one-shot run, whatever it produced last time (its dedupe map only
 * applies in watch mode), so `pnpm test`, `pnpm typecheck` and `pnpm build` all leave files there newer than the
 * bundle. Counting them made the launcher rebuild after any of those, and say the bundle was older than its sources
 * when the only thing that had moved was output regenerated from unchanged `*.src.ts` files.
 */
export const GENERATED_DIRS = ["src/server/scan/inpage/generated"];

/** What `pnpm build:agent` runs, as plain node scripts: pnpm is not on the PATH of every agent that starts a plugin. */
export const BUILD_STEPS = ["scripts/build-inpage.mjs", "scripts/build-agent.mjs"];

/** What a rebuild needs. Only checked when there is one to run: a current bundle starts without esbuild. */
export const BUILD_PACKAGES = ["esbuild"];

/** What the bundle itself imports at run time. Missing means the server cannot start, however fresh the bundle is. */
export const RUNTIME_PACKAGES = ["@modelcontextprotocol/sdk"];

/** Everything a rebuild and a start need together. All are missing together when node_modules is not installed. */
export const REQUIRED_PACKAGES = [...BUILD_PACKAGES, ...RUNTIME_PACKAGES];

/** A reason the server cannot start, already written for the person reading stderr. */
export class LauncherError extends Error {
  name = "LauncherError";
}

/** The newest file under `dir`, as `{ file, mtimeMs }`, or null when the directory has none. Unreadable files count as absent. */
async function newestUnder(dir, skip) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  let newest = null;
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    let found = null;
    if (entry.isDirectory()) found = skip.has(full) ? null : await newestUnder(full, skip);
    else if (entry.isFile()) {
      try {
        found = { file: full, mtimeMs: (await stat(full)).mtimeMs };
      } catch {
        found = null;
      }
    }
    if (found && (!newest || found.mtimeMs > newest.mtimeMs)) newest = found;
  }
  return newest;
}

/** The newest source file under `dirs` of `root`, as `{ file, mtimeMs }`, or null. `GENERATED_DIRS` are not sources. */
export async function newestSource(root, dirs = SOURCE_DIRS) {
  const skip = new Set(GENERATED_DIRS.map((dir) => path.join(root, dir)));
  let newest = null;
  for (const dir of dirs) {
    const found = await newestUnder(path.join(root, dir), skip);
    if (found && (!newest || found.mtimeMs > newest.mtimeMs)) newest = found;
  }
  return newest;
}

/**
 * Why the bundle has to be rebuilt, or null when it does not: it exists and no source file is newer than it. Equal
 * timestamps are up to date, since a build writes the bundle after the sources it read.
 */
export async function staleness(root, dirs = SOURCE_DIRS) {
  let bundle;
  try {
    bundle = await stat(path.join(root, BUNDLE));
  } catch {
    return `${BUNDLE} is missing`;
  }
  if (!bundle.isFile()) return `${BUNDLE} is not a file`;
  const newest = await newestSource(root, dirs);
  if (!newest || newest.mtimeMs <= bundle.mtimeMs) return null;
  return `${BUNDLE} is older than ${path.relative(root, newest.file)}`;
}

/** The first of `names` that is not installed under `root`, or null when they all are. */
export async function missingPackage(root, names = REQUIRED_PACKAGES) {
  for (const name of names) {
    try {
      await stat(path.join(root, "node_modules", name));
    } catch {
      return name;
    }
  }
  return null;
}

/** Runs one build step with this node, its output on stderr. Rejects with a `LauncherError` on a non-zero exit. */
export function runBuildStep(root, script) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, script)], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let tail = "";
    const keep = (chunk) => {
      process.stderr.write(chunk);
      tail = `${tail}${chunk}`.slice(-2000);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("error", (error) => reject(new LauncherError(`could not run ${script}: ${error.message}`)));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new LauncherError(`${script} failed with exit code ${code}${tail.trim() ? `:\n${tail.trim()}` : ""}`));
    });
  });
}

/**
 * The path to a bundle that is not older than its sources, building it first when it is. Reports what it did through
 * `log` and throws a `LauncherError` when the bundle is stale and cannot be built.
 */
export async function ensureBundle({ root = ROOT, dirs = SOURCE_DIRS, run = runBuildStep, log = () => {} } = {}) {
  const bundle = path.join(root, BUNDLE);
  const reason = await staleness(root, dirs);
  if (!reason) {
    // A current bundle still imports its dependencies. Saying so here rather than letting the import fail is what makes
    // this path read like the one below: node's own ERR_MODULE_NOT_FOUND names the package and not what to do about it.
    const uninstalled = await missingPackage(root, RUNTIME_PACKAGES);
    if (uninstalled) {
      throw new LauncherError(
        `assets-scraper: ${BUNDLE} is up to date but ${uninstalled} is not installed in ${root}. ` +
          "Run pnpm install there, then start the server again.",
      );
    }
    return { bundle, rebuilt: false, reason: null };
  }

  const missing = await missingPackage(root);
  if (missing) {
    throw new LauncherError(
      `assets-scraper: ${reason} and it cannot be built: ${missing} is not installed in ${root}. ` +
        "Run pnpm install and pnpm build:agent there, then start the server again.",
    );
  }

  log(`assets-scraper: ${reason}, rebuilding it with pnpm build:agent`);
  for (const step of BUILD_STEPS) await run(root, step);
  try {
    await stat(bundle);
  } catch {
    throw new LauncherError(`assets-scraper: the build ran but wrote no ${BUNDLE} in ${root}. Run pnpm build:agent there to see why.`);
  }
  log(`assets-scraper: ${BUNDLE} rebuilt`);
  return { bundle, rebuilt: true, reason };
}

/** Whether node was started on this file. Both sides are resolved: a temporary directory reaches it through a symlink. */
const isEntryPoint = () => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (isEntryPoint()) {
  try {
    const { bundle } = await ensureBundle({ log: (line) => process.stderr.write(`${line}\n`) });
    // The bundle starts its server only when node was started on it, which it reads from `process.argv[1]`. Running it
    // here has to look exactly like `node dist/mcp.mjs`, so the launcher takes its own name out of the way first.
    process.argv = [process.argv[0], bundle, ...process.argv.slice(2)];
    await import(pathToFileURL(bundle).href);
  } catch (error) {
    const message = error instanceof LauncherError ? error.message : `assets-scraper: the MCP server could not start: ${error?.message ?? error}`;
    // `process.exitCode`, not `process.exit`: stderr can be a pipe, and exiting on the spot truncates the reason.
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
