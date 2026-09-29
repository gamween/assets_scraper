import type { KnipConfig } from "knip";

// The entry points knip cannot see. The rest come from its Next, vitest, Playwright and ESLint plugins and from the
// package.json scripts. Run it with `pnpm knip`, which builds the in-page bundles first: the engine imports them, and
// they are gitignored.
const config: KnipConfig = {
  entry: [
    // Bundled by scripts/build-inpage.mjs, which names them in a list rather than importing them.
    "src/server/scan/inpage/*.src.ts",
    // scripts/build-cn-tables.mjs hands its path to cn's compiler (pnpm build:cn), which loads it.
    "src/components/common/cn-config.mjs",
    // The fixture site tests/fixtures/serve.ts serves over HTTP: its pages load these files, nothing imports them.
    "tests/fixtures/site/**",
  ],
  // A system binary: tests/integration/engine/launch.test.ts checks with it that no Chrome process was left behind.
  ignoreBinaries: ["pgrep"],
};

export default config;
