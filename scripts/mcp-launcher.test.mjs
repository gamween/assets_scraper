import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { ensureBundle, GENERATED_DIRS, LauncherError, missingPackage, newestSource, RUNTIME_PACKAGES, staleness } from "./mcp-launcher.mjs";

const run = promisify(execFile);
const launcher = fileURLToPath(new URL("./mcp-launcher.mjs", import.meta.url));

/** A stand-in for dist/mcp.mjs: it only speaks when node was started on it, which is the guard the real bundle uses. */
const BUNDLE_SOURCE = [
  'const { pathToFileURL } = await import("node:url");',
  'if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) process.stderr.write("server up\\n");',
].join("\n");

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** A repo shaped like this one: a source file, node_modules, and a bundle whose mtime is `bundleAt` when given. */
async function fakeRepo({ bundle = true, packages = true, bundleAt = 2_000_000, sourceAt = 1_000_000 } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "mcp-launcher-"));
  roots.push(root);
  await mkdir(path.join(root, "src/agent"), { recursive: true });
  await mkdir(path.join(root, "src/server"), { recursive: true });
  const source = path.join(root, "src/agent/mcp.ts");
  await writeFile(source, "export const version = 1;\n");
  await utimes(source, sourceAt / 1000, sourceAt / 1000);
  if (packages) {
    for (const name of ["esbuild", "@modelcontextprotocol/sdk"]) await mkdir(path.join(root, "node_modules", name), { recursive: true });
  }
  if (bundle) {
    await mkdir(path.join(root, "dist"), { recursive: true });
    const file = path.join(root, "dist/mcp.mjs");
    await writeFile(file, "// bundle\n");
    await utimes(file, bundleAt / 1000, bundleAt / 1000);
  }
  return root;
}

/** A build that writes a bundle newer than every source, and records the steps it was asked to run. */
const fakeBuild = (root, { write = true } = {}) => {
  const steps = [];
  const build = async (buildRoot, step) => {
    steps.push(step);
    if (!write) return;
    await mkdir(path.join(buildRoot, "dist"), { recursive: true });
    await writeFile(path.join(buildRoot, "dist/mcp.mjs"), "// rebuilt\n");
  };
  return Object.assign(build, { steps, root });
};

describe("staleness", () => {
  it("reports a missing bundle", async () => {
    expect(await staleness(await fakeRepo({ bundle: false }))).toBe("dist/mcp.mjs is missing");
  });

  it("reports the newest source that is younger than the bundle", async () => {
    const root = await fakeRepo({ bundleAt: 1_000_000, sourceAt: 2_000_000 });
    expect(await staleness(root)).toBe("dist/mcp.mjs is older than src/agent/mcp.ts");
  });

  it("is null when the bundle is newer than every source, and when they share a timestamp", async () => {
    expect(await staleness(await fakeRepo({ bundleAt: 2_000_000, sourceAt: 1_000_000 }))).toBeNull();
    expect(await staleness(await fakeRepo({ bundleAt: 1_000_000, sourceAt: 1_000_000 }))).toBeNull();
  });

  it("walks the source directories, so a file in a subdirectory counts", async () => {
    const root = await fakeRepo({ bundleAt: 1_500_000, sourceAt: 1_000_000 });
    const nested = path.join(root, "src/server/scan/fonts");
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(nested, "index.ts"), "// edited\n");
    await utimes(path.join(nested, "index.ts"), 2_000, 2_000);
    expect((await newestSource(root))?.file).toBe(path.join(nested, "index.ts"));
    expect(await staleness(root)).toBe("dist/mcp.mjs is older than src/server/scan/fonts/index.ts");
  });

  /**
   * Regression: `scripts/build-inpage.mjs` rewrites `src/server/scan/inpage/generated/*.ts` on every one-shot run, so
   * any `pnpm test`, `pnpm typecheck` or `pnpm build` left files there newer than the bundle and the next start
   * rebuilt, reporting the bundle as older than its sources. Generated output is not a source.
   */
  it("does not count the generated in-page bundles as sources", async () => {
    const root = await fakeRepo({ bundleAt: 1_500_000, sourceAt: 1_000_000 });
    const generated = path.join(root, GENERATED_DIRS[0]);
    await mkdir(generated, { recursive: true });
    const written = path.join(generated, "collector.ts");
    await writeFile(written, "export const COLLECTOR_SOURCE = \"\";\n");
    await utimes(written, 2_000, 2_000);

    expect(await staleness(root)).toBeNull();
    expect((await newestSource(root))?.file).toBe(path.join(root, "src/agent/mcp.ts"));

    // The source those files are generated from is a source, so editing it still asks for a rebuild
    const src = path.join(root, "src/server/scan/inpage/collector.src.ts");
    await mkdir(path.dirname(src), { recursive: true });
    await writeFile(src, "export const x = 1;\n");
    await utimes(src, 2_000, 2_000);
    expect(await staleness(root)).toBe("dist/mcp.mjs is older than src/server/scan/inpage/collector.src.ts");
  });

  /**
   * Regression: test files counted as bundle sources, so editing or running one rebuilt the bundle and the launcher
   * said `dist/mcp.mjs is older than src/agent/cache.test.ts`, naming a file the bundle does not contain. The rebuild
   * cost little; the line saying something untrue cost the next reader an investigation.
   */
  it("does not count test files as sources, so the staleness line names a file the bundle holds", async () => {
    const root = await fakeRepo({ bundleAt: 1_500_000, sourceAt: 1_000_000 });
    for (const name of ["cache.test.ts", "mcp.test.tsx", "helpers.test.mjs"]) {
      const file = path.join(root, "src/agent", name);
      await writeFile(file, "// a test\n");
      await utimes(file, 2_000, 2_000);
    }

    expect(await staleness(root)).toBeNull();
    expect((await newestSource(root))?.file).toBe(path.join(root, "src/agent/mcp.ts"));

    // Only `*.test.*` is dropped, so a file whose name merely mentions tests is still a source
    const testing = path.join(root, "src/agent/testing.ts");
    await writeFile(testing, "export const x = 1;\n");
    await utimes(testing, 2_000, 2_000);
    expect(await staleness(root)).toBe("dist/mcp.mjs is older than src/agent/testing.ts");
  });
});

describe("ensureBundle", () => {
  it("rebuilds a stale bundle with the repo's own build, and says so", async () => {
    const root = await fakeRepo({ bundleAt: 1_000_000, sourceAt: 2_000_000 });
    const build = fakeBuild(root);
    const lines = [];
    const result = await ensureBundle({ root, run: build, log: (line) => lines.push(line) });
    expect(result.rebuilt).toBe(true);
    expect(result.bundle).toBe(path.join(root, "dist/mcp.mjs"));
    expect(build.steps).toEqual(["scripts/build-inpage.mjs", "scripts/build-agent.mjs"]);
    expect(lines[0]).toContain("older than src/agent/mcp.ts");
    expect(await staleness(root)).toBeNull();
  });

  it("builds a bundle that is not there at all", async () => {
    const root = await fakeRepo({ bundle: false });
    const build = fakeBuild(root);
    expect((await ensureBundle({ root, run: build, log: () => {} })).rebuilt).toBe(true);
    expect(build.steps).toHaveLength(2);
  });

  it("leaves an up to date bundle alone and runs nothing", async () => {
    const root = await fakeRepo({ bundleAt: 2_000_000, sourceAt: 1_000_000 });
    const build = fakeBuild(root);
    const lines = [];
    const result = await ensureBundle({ root, run: build, log: (line) => lines.push(line) });
    expect(result).toEqual({ bundle: path.join(root, "dist/mcp.mjs"), rebuilt: false, reason: null });
    expect(build.steps).toEqual([]);
    expect(lines).toEqual([]);
  });

  it("reports missing dependencies instead of running a build that cannot work", async () => {
    const root = await fakeRepo({ bundle: false, packages: false });
    const build = fakeBuild(root);
    expect(await missingPackage(root)).toBe("esbuild");
    await expect(ensureBundle({ root, run: build, log: () => {} })).rejects.toThrow(LauncherError);
    await expect(ensureBundle({ root, run: build, log: () => {} })).rejects.toThrow(/esbuild is not installed/);
    await expect(ensureBundle({ root, run: build, log: () => {} })).rejects.toThrow(/pnpm install/);
    expect(build.steps).toEqual([]);
  });

  /**
   * Regression: `missingPackage` was only consulted when a rebuild was needed, so a current bundle with no node_modules
   * fell through to the import and printed node's `Cannot find package ...` with no "run pnpm install". Both paths say
   * what to do now.
   */
  it("names the install to run when the bundle is current but its dependencies are not there", async () => {
    const root = await fakeRepo({ bundleAt: 2_000_000, sourceAt: 1_000_000, packages: false });
    // esbuild is not needed here, only what the bundle imports
    await mkdir(path.join(root, "node_modules/esbuild"), { recursive: true });
    const build = fakeBuild(root);

    expect(await missingPackage(root, RUNTIME_PACKAGES)).toBe("@modelcontextprotocol/sdk");
    await expect(ensureBundle({ root, run: build, log: () => {} })).rejects.toThrow(LauncherError);
    await expect(ensureBundle({ root, run: build, log: () => {} })).rejects.toThrow(/@modelcontextprotocol\/sdk is not installed/);
    await expect(ensureBundle({ root, run: build, log: () => {} })).rejects.toThrow(/pnpm install/);
    expect(build.steps).toEqual([]);
  });

  it("starts a current bundle without esbuild, which only a rebuild needs", async () => {
    const root = await fakeRepo({ bundleAt: 2_000_000, sourceAt: 1_000_000, packages: false });
    await mkdir(path.join(root, "node_modules/@modelcontextprotocol/sdk"), { recursive: true });
    const build = fakeBuild(root);

    expect(await ensureBundle({ root, run: build, log: () => {} })).toEqual({ bundle: path.join(root, "dist/mcp.mjs"), rebuilt: false, reason: null });
    expect(build.steps).toEqual([]);
  });

  it("reports a build that ran but wrote no bundle", async () => {
    const root = await fakeRepo({ bundle: false });
    const build = fakeBuild(root, { write: false });
    await expect(ensureBundle({ root, run: build, log: () => {} })).rejects.toThrow(/wrote no dist\/mcp\.mjs/);
  });
});

describe("the launcher process", () => {
  /** The launcher copied into a fake repo, so it reads that repo rather than this one. */
  async function repoWithLauncher(options) {
    const root = await fakeRepo(options);
    await mkdir(path.join(root, "scripts"), { recursive: true });
    await copyFile(launcher, path.join(root, "scripts/mcp-launcher.mjs"));
    return root;
  }

  it("rebuilds, starts the bundle, and keeps stdout for the transport", async () => {
    const root = await repoWithLauncher({ bundle: false });
    for (const [step, writes] of [
      ["build-inpage", "process.stderr.write('inpage\\n');"],
      // The bundle only speaks when node was started on it, the guard dist/mcp.mjs uses
      ["build-agent", `const fs = await import("node:fs/promises"); await fs.mkdir("dist", { recursive: true }); await fs.writeFile("dist/mcp.mjs", ${JSON.stringify(BUNDLE_SOURCE)});`],
    ]) {
      await writeFile(path.join(root, `scripts/${step}.mjs`), writes);
    }
    const { stdout, stderr } = await run(process.execPath, [path.join(root, "scripts/mcp-launcher.mjs")], { cwd: tmpdir() });
    expect(stdout).toBe("");
    expect(stderr).toContain("dist/mcp.mjs is missing, rebuilding it");
    expect(stderr).toContain("inpage");
    expect(stderr).toContain("server up");
  }, 30_000);

  it("writes the reason to stderr and exits 1 when it cannot build, with nothing on stdout", async () => {
    const root = await repoWithLauncher({ bundle: false, packages: false });
    const failure = await run(process.execPath, [path.join(root, "scripts/mcp-launcher.mjs")], { cwd: tmpdir() }).catch((error) => error);
    expect(failure.code).toBe(1);
    expect(failure.stdout).toBe("");
    expect(failure.stderr).toContain("esbuild is not installed");
  }, 30_000);
});
