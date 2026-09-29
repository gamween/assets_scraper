# Assets Scraper

Paste a URL, get every SVG, image and font on the page, plus the brand color palette. Select what you need and download it as a ZIP.

Live: https://assets-scraper.vercel.app

## What it does

A scan opens the page in a headless Chromium behind an egress proxy, walks the DOM, the CSSOM and the network capture, and streams its results as NDJSON while they are ready:

- SVGs, inline or from sprite sheets, normalized so the file looks like the page.
- Images from `img`, `srcset`, `picture`, CSS backgrounds, `image-set()`, icons, manifests and Open Graph tags, with the CDN original behind a transformed URL when there is one.
- Web fonts, grouped by family, with the files each family loads and a TTF conversion for the ones whose licence allows it.
- The brand color palette, read from what the page actually paints.

Selected assets are zipped in the browser. Images load straight from their host, with no cookies and no referrer, and through a signed, rate-limited proxy when that fails or the URL is plain `http:`. Font files go through the proxy first, because font hosts do not allow cross-origin reads.

## Use it from an agent

Claude Code and other agents can scan a page, download only the assets that are usable into `scrap/<host>/` inside the current project, and install the page fonts. Three ways in, all on the same core: the MCP server shipped as a Claude Code plugin, the `assets-scraper` CLI, and the hosted `/api/v1` endpoints.

```bash
pnpm install && pnpm build:agent
claude plugin marketplace add "$PWD"
claude plugin install assets-scraper
```

`docs/agents.md` covers all three, the selection rules, the font install and the limits.

## Running it locally

Requirements: Node 22.19 or later on the 22 line, or Node 24 (production and CI run 24, and CI also runs the unit tests on 22.19), pnpm 10.33, Google Chrome. `pnpm install` refuses any other Node: the range is `engines` in `package.json`, enforced by `engineStrict` in `pnpm-workspace.yaml`.

```bash
pnpm install
pnpm dev            # http://localhost:3000
pnpm lint
pnpm typecheck
pnpm test           # unit tests
pnpm test:integration   # needs Google Chrome
pnpm test:e2e           # builds the app and runs Playwright
```

Every value in the table below is optional in development; copy `.env.example` to `.env.local` to set any of them. Only `next dev` and `next start` read `.env.local`: the tests, the CLI and the MCP server read the shell environment, so export `CHROME_EXECUTABLE_PATH` there when Chrome is not where it installs itself.

## Environment

| Variable | Purpose |
| --- | --- |
| `ASSET_URL_SECRET` | HMAC key for signed `/api/asset` URLs, at least 32 characters. Required in production; a random per-process key is used without it. |
| `SCAN_DISABLED` | `1` turns scanning off. |
| `ACCESS_CODE` | When set, a scan requires this code in the `x-access-code` header. |
| `OPS_TOKEN` | Operator token, at least 32 characters, sent as `x-ops-token` to skip BotID and the scan budget. |
| `AGENT_TOKENS` | Bearer tokens for `/api/v1`, one per client, comma separated, each at least 24 characters (a shorter one is ignored). Without one, every `/api/v1` call answers 401. |
| `AGENT_ZIP_MAX_BYTES` | Bytes one `/api/v1/assets.zip` response may serve (64 MB). |
| `SCANS_PER_DAY`, `SCANS_PER_MONTH` | Shared scan budget (80 and 800). |
| `SCANS_PER_IP_PER_DAY` | Scans one client address may take per day (20). Raise it for a shared NAT. |
| `PROXY_BYTES_PER_DAY` | Bytes the asset proxy may serve per day (300 MB). |
| `APP_HOSTS` | Extra hosts of this app that scans and fetches refuse. |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Shared budget store with atomic counters. Without them: the Vercel Runtime Cache on Vercel, shared but not atomic, so concurrent scans on several instances can undercount, though no single instance goes past a limit; in-memory counters elsewhere. |
| `CHROME_EXECUTABLE_PATH` | Chrome for local scans (the dev server, the CLI, the MCP server and the integration tests), when it is not where Google Chrome installs itself. Ignored on Vercel, which runs `@sparticuz/chromium`. |
| `SCAN_TEST_ALLOW_HOSTS` | Tests only: `host:port` pairs that may reach private addresses. Never set in production. |

Every limit in `src/server/config/limits.ts` can be overridden the same way, by the SCREAMING_SNAKE_CASE of its key. So can every limit in `src/agent/limits.ts`, with an `AGENT_` prefix (`maxFiles` reads `AGENT_MAX_FILES`): they bound the CLI and the MCP server, and `/api/v1` on the server.

The platform sets the rest itself: `NODE_ENV` (Next), `VERCEL`, `VERCEL_ENV`, `VERCEL_URL`, `VERCEL_BRANCH_URL`, `VERCEL_PROJECT_PRODUCTION_URL` and `VERCEL_GIT_COMMIT_SHA` (Vercel), `AWS_LAMBDA_FUNCTION_NAME` (Lambda). The app reads them for the production rules, to choose the browser and the budget store, to refuse its own hosts and to report its version. The CLI and the MCP server read their own variables on the machine they run on: see `docs/agents.md`.

## Limits

- One scan per instance, 15 s in the queue, then `busy`. 90 s for the whole scan, 120 s of function time.
- 8 s preflight, 20 s to launch Chromium, 25 s to navigate, 8 s of scrolling, 15 s of collection.
- At most 1,500 assets and 2,000 signed URLs per scan; 1 MB per SVG; 25 MB per proxied file.
- The scan budget above, and the per-day proxy byte budget, shared across the deployment.
- A page that stops the scan early still returns what is ready, with `partial: true`.

## Layout

- `src/app` route handlers and pages, thin adapters over `src/server`.
- `src/server/scan` the engine: preflight, browser, capture, in-page collection, post-processing.
- `src/server/security` the gate, the signed asset proxy and the budgets.
- `src/lib/contract.ts` the single source of truth for everything that crosses the network.
- `docs/superpowers/specs` the design spec, `docs/superpowers/plans` the build plan.
- `src/agent` the agent core: scan sources, selection, download, fonts, the CLI and the MCP server.
- `plugins/assets-scraper` the Claude Code plugin, `.claude-plugin/marketplace.json` the marketplace that lists it.
