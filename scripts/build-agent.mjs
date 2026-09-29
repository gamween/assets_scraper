// Bundles the agent entry points into dist/cli.mjs and dist/mcp.mjs (agent access spec section 3).
//   node scripts/build-agent.mjs
// Native and heavy packages stay external, so both bundles run from the repo with its node_modules present. A missing
// entry point fails the build, like any other broken import: CI builds the bundles, and a warning there went unseen.
import { chmod, mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { AGENT_EXTERNALS } from "./agent-externals.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = path.join(ROOT, "dist");

const entries = [
  { name: "cli", entry: "src/agent/cli.ts" },
  { name: "mcp", entry: "src/agent/mcp.ts" },
];


/** The `@/` alias, read from tsconfig.json so it cannot drift from the one TypeScript uses. */
const aliasFromTsconfig = async () => {
  const tsconfig = JSON.parse(await readFile(path.join(ROOT, "tsconfig.json"), "utf8"));
  const paths = tsconfig.compilerOptions?.paths ?? {};
  const alias = {};
  for (const [pattern, targets] of Object.entries(paths)) {
    if (!pattern.endsWith("/*") || !targets[0]?.endsWith("/*")) continue;
    alias[pattern.slice(0, -2)] = path.resolve(ROOT, targets[0].slice(0, -2));
  }
  return alias;
};

/**
 * A shebang, plus `require` for the CommonJS dependencies that ask for it at run time: the output is ESM, where
 * `require` does not exist.
 */
const banner = `#!/usr/bin/env node
import { createRequire as __createRequire } from "node:module";
const require = __createRequire(import.meta.url);
`;

const alias = await aliasFromTsconfig();
await mkdir(OUT, { recursive: true });

for (const { name, entry } of entries) {
  const entryPoint = path.join(ROOT, entry);
  const outfile = path.join(OUT, `${name}.mjs`);
  // Built under a temporary name and renamed into place, so the bundle is never half written: two MCP launchers can
  // start inside the build window and both run this, and one importing dist/mcp.mjs while the other's esbuild is still
  // writing it reads a truncated module. A rename is atomic on the same filesystem, so a reader sees one version or
  // the other and never part of both.
  const temporary = `${outfile}.${process.pid}.tmp`;
  try {
    await build({
      entryPoints: [entryPoint],
      outfile: temporary,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      external: AGENT_EXTERNALS,
      alias,
      banner: { js: banner },
      logLevel: "warning",
    });
    await chmod(temporary, 0o755);
    await rename(temporary, outfile);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  console.log(`build-agent: wrote ${path.relative(ROOT, outfile)}`);
}
