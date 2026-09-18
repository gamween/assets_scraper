# Assets Scraper

Paste a URL, get every SVG, image and font on the page, plus the brand color palette. Select what you need and download it as a ZIP.

Live: https://assets-scraper.vercel.app

## What it does

A scan opens the page in a headless Chromium behind an egress proxy, walks the DOM, the CSSOM and the network capture, and streams its results as NDJSON while they are ready:

- SVGs, inline or from sprite sheets, normalized so the file looks like the page.
- Images from `img`, `srcset`, `picture`, CSS backgrounds, `image-set()`, icons, manifests and Open Graph tags, with the CDN original behind a transformed URL when there is one.
- Web fonts, grouped by family, with the files each family loads and a TTF conversion for the ones whose licence allows it.
- The brand color palette, read from what the page actually paints.

Selected assets are zipped in the browser. Remote files load through a signed, rate-limited proxy, never straight from the page's origin.

## Running it locally

Requirements: Node 22+ (production and CI run Node 24), pnpm 10.33, Google Chrome.

```bash
pnpm install
pnpm dev            # http://localhost:3000
pnpm lint
pnpm typecheck
pnpm test           # unit tests
pnpm test:integration   # needs Google Chrome
pnpm test:e2e           # builds the app and runs Playwright
```

Set `CHROME_EXECUTABLE_PATH` if Chrome is not in the default location. Every value is optional in development; copy `.env.example` to `.env.local` to set any of them.

## Environment

| Variable | Purpose |
| --- | --- |
| `ASSET_URL_SECRET` | HMAC key for signed `/api/asset` URLs, at least 32 characters. Required in production; a random per-process key is used without it. |
| `SCAN_DISABLED` | `1` turns scanning off. |
| `ACCESS_CODE` | When set, a scan requires this code in the `x-access-code` header. |
| `OPS_TOKEN` | Operator token, at least 32 characters, sent as `x-ops-token` to skip BotID and the scan budget. |
| `SCANS_PER_DAY`, `SCANS_PER_MONTH` | Shared scan budget (80 and 800). |
| `SCANS_PER_IP_PER_DAY` | Scans one client address may take per day (20). Raise it for a shared NAT. |
| `PROXY_BYTES_PER_DAY` | Bytes the asset proxy may serve per day (300 MB). |
| `APP_HOSTS` | Extra hosts of this app that scans and fetches refuse. |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Shared budget store. Without them the counters are in memory, per instance. |
| `SCAN_TEST_ALLOW_HOSTS` | Tests only: `host:port` pairs that may reach private addresses. Never set in production. |

Every limit in `src/server/config/limits.ts` can be overridden the same way, by the SCREAMING_SNAKE_CASE of its key.

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
