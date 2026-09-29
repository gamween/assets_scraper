# Assets Scraper

- Spec: docs/superpowers/specs/2026-09-16-assets-scraper-design.md. Plan: docs/superpowers/plans/2026-09-16-assets-scraper-v1.md.
- Agent access (CLI, MCP server, `/api/v1`): spec docs/superpowers/specs/2026-09-27-agent-access-design.md, plan docs/superpowers/plans/2026-09-27-agent-access.md. The shared core is `src/agent/*`, and `pnpm build:agent` bundles `src/agent/cli.ts` and `src/agent/mcp.ts` into `dist/`.
- Deploying: merging to `main` deploys nothing. Production is deployed from the Vercel CLI: see the Deploy section of README.md.
- Commands: `pnpm dev`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration` (needs Google Chrome), `pnpm test:e2e`, `pnpm bench` (the wall-clock font benchmarks, which the gating suite skips because a timing ratio flakes; CI runs them in a job that reports and does not block).
- Gate a new performance guarantee by counting operations, not by comparing wall time: see `opGrowth` in `src/server/scan/fonts/testing.ts`, and give the counter a seam it can see, an exported helper on the hot path rather than a module-local one. The wall-clock ratios left in the font tests (`growthFactor`, `fastestMs`) are the exception, not the pattern to copy: one of them failed CI on a timing ratio, and `src/server/scan/fonts/perf-convention.test.ts` holds the list so it does not grow.
- `src/lib/contract.ts` is the single source of truth for everything that crosses the network. Change it only together with server and client.
- `src/server/scan` must not import from `next`. The route handlers are thin adapters.
- Every server-side request to a URL that came from a user or a scraped page goes through `safeFetch`. Chromium always runs behind the egress proxy.
- Never insert scraped SVG markup into the DOM. Preview through blob URLs in `<img>`, show code as text.
- UI copy: English, sentence case, no em dash, no en dash, no exclamation marks, no emojis.
- In-page code lives in `src/server/scan/inpage/*.src.ts` and is bundled by `pnpm build:inpage` (`pnpm dev` rebuilds it on change). It must not import runtime code from the app: the bundler rejects imports from outside that folder, `import type` is fine.
- Run `pnpm build:cn` after a `cn` upgrade or a change to `src/components/common/cn-config.mjs`: it compiles the committed `src/components/common/cn-tables.ts`, and `scripts/build-cn-tables.test.mjs` fails while that file is out of date.
- `pnpm knip` must stay clean, and CI runs it: drop the export of a symbol nothing outside its module uses, and name an entry point knip cannot see in `knip.config.ts` rather than ignoring files.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
