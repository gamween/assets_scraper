// Bundles the agent entry points into dist/cli.mjs and dist/mcp.mjs (agent access spec section 3).
//   node scripts/build-agent.mjs
// Native and heavy packages stay external, so both bundles run from the repo with its node_modules present. An entry
// point that is not written yet is skipped with a warning, so the build works while the tracks land one by one.
import { chmod, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = path.join(ROOT, "dist");

const entries = [
  { name: "cli", entry: "src/agent/cli.ts" },
  { name: "mcp", entry: "src/agent/mcp.ts" },
];

/**
 * Packages the bundle must not inline: native bindings (sharp, wawoff2), the browser driver and its Chromium, and the
 * MCP SDK, which ships its own ESM. They resolve from node_modules at run time.
 */
const external = [
  "playwright-core",
  "@sparticuz/chromium",
  "sharp",
  "fontkit",
  "css-tree",
  "undici",
  "ipaddr.js",
  "wawoff2",
  "@modelcontextprotocol/sdk",
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

const exists = async (file) => {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
};

const alias = await aliasFromTsconfig();
await mkdir(OUT, { recursive: true });

let built = 0;
for (const { name, entry } of entries) {
  const entryPoint = path.join(ROOT, entry);
  if (!(await exists(entryPoint))) {
    console.warn(`build-agent: skipping ${entry}, it is not written yet`);
    continue;
  }
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
      external,
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
  built += 1;
}

if (built === 0) console.warn("build-agent: nothing to build yet");
