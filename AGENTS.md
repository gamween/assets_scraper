# Assets Scraper

- Spec: docs/superpowers/specs/2026-09-16-assets-scraper-design.md. Plan: docs/superpowers/plans/2026-09-16-assets-scraper-v1.md.
- Commands: `pnpm dev`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration` (needs Google Chrome), `pnpm test:e2e`.
- `src/lib/contract.ts` is the single source of truth for everything that crosses the network. Change it only together with server and client.
- `src/server/scan` must not import from `next`. The route handlers are thin adapters.
- Every server-side request to a URL that came from a user or a scraped page goes through `safeFetch`. Chromium always runs behind the egress proxy.
- Never insert scraped SVG markup into the DOM. Preview through blob URLs in `<img>`, show code as text.
- UI copy: English, sentence case, no em dash, no en dash, no exclamation marks, no emojis.
- In-page code lives in `src/server/scan/inpage/*.src.ts` and is bundled by `pnpm build:inpage`. It must not import runtime code from the app.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
