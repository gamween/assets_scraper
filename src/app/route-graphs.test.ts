import { readdirSync } from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

/**
 * What each route loads, as a bundler resolves it. The deployment ships what Next's tracer finds from these graphs, and
 * one module with a file system call on a path built at runtime is enough for the tracer to take the whole repository
 * into the function: `src/agent/dest.ts` did, and through the ZIP builder it put the docs, the tests, the e2e fixtures and
 * the lockfile into `/api/v1/scan`, `/api/v1/assets.zip` and `llms.txt` (with sharp and the budget store in `llms.txt`,
 * a page of text). A regression here is silent in every other test, so this reads the graphs themselves.
 */

const ROOT = path.resolve(import.meta.dirname, "../..");

/** The modules that write downloads to disk: their file system calls on runtime paths make the tracer ship the repository. */
const DISK_WRITERS = ["src/agent/dest.ts", "src/agent/download.ts"];

const routes = readdirSync(path.join(ROOT, "src/app"), { recursive: true, encoding: "utf8" })
  .filter((file) => /(^|\/)route\.ts$/.test(file))
  .map((file) => `src/app/${file}`);

async function graphOf(entry: string): Promise<{ modules: string[]; packages: string[] }> {
  const result = await build({
    entryPoints: [path.join(ROOT, entry)],
    absWorkingDir: ROOT,
    bundle: true,
    write: false,
    metafile: true,
    platform: "node",
    format: "esm",
    packages: "external",
    logLevel: "silent",
  });
  const inputs = Object.values(result.metafile.inputs);
  return {
    modules: Object.keys(result.metafile.inputs),
    packages: [...new Set(inputs.flatMap((input) => input.imports.filter((entry) => entry.external).map((entry) => entry.path)))],
  };
}

describe("route import graphs", () => {
  it("finds every route handler", () => {
    expect(routes).toEqual(expect.arrayContaining(["src/app/llms.txt/route.ts", "src/app/api/v1/assets.zip/route.ts", "src/app/api/scan/route.ts"]));
  });

  it.each(routes)("%s never loads the modules that write downloads to disk", async (route) => {
    const { modules } = await graphOf(route);
    expect(modules).toContain(route);
    for (const writer of DISK_WRITERS) expect(modules, writer).not.toContain(writer);
  });

  it.each(["src/app/llms.txt/route.ts", "src/app/api/openapi.json/route.ts"])("%s, a page of text, loads no ZIP builder, image codec or budget store", async (route) => {
    const { modules, packages } = await graphOf(route);
    expect(modules).not.toContain("src/app/api/v1/zip.ts");
    for (const heavy of ["sharp", "client-zip", "@upstash/redis"]) expect(packages, heavy).not.toContain(heavy);
  });
});
