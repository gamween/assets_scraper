# Agent access: design

- Date: 2026-09-27
- Status: approved
- Builds on: `docs/superpowers/specs/2026-09-16-assets-scraper-design.md` (v1)

## 1. Purpose

Let Claude Code and other agents use Assets Scraper directly: scan a page, see what is on it without flooding the context, pull only the files that are actually usable, and install the page's fonts so they can be used in Figma or a deck.

Today an agent cannot use the app at all: `POST /api/scan` is protected by BotID (curl is refused), the response is an NDJSON event stream meant for the UI, and the ZIP is built in the browser.

## 2. Decisions

| Topic | Decision |
|---|---|
| Where the scan runs | Both. Local by default (the user's Chrome, no Vercel quota, nothing leaves the machine), remote against the hosted app when `--remote` or `ASSETS_SCRAPER_REMOTE` is set |
| Distribution | A Claude Code plugin living in this repo (MCP server plus a skill). The CLI and the HTTP API cover every other agent |
| Download policy | Selective by default: a `deck` profile that keeps what is usable and drops duplicates, thumbnails, icons and near-duplicates. `all` stays available |
| Destination | `<project root>/scrap/<host>/` where the project root is the git root of the working directory (or the nearest directory holding `package.json`, `pyproject.toml` or `.claude`). Fallback when there is no project: `~/Downloads/assets-scraper/<host>/` |
| Fonts | Installed, not just downloaded: converted to TTF and copied into the user's font directory, with the licence read from the binary printed every time. Commercial licences install too, with the warning |
| Context cost | Files go to disk. Tools return paths, counts and short summaries, never asset bytes (the only text returned is SVG markup on request and palette hexes) |

## 3. Shape

```
Claude Code ──stdio──> MCP server ─┐
Any agent ────shell──> CLI ────────┼─> agent core ──local──> scan engine (src/server/scan) + local Chrome
                                   │                └─remote─> https://assets-scraper.vercel.app /api/v1
Any LLM ──────HTTP───> /api/v1 ────┘
```

New code:

| Path | Responsibility |
|---|---|
| `src/agent/backend.ts` | `ScanSource`: `local` (drives the v1 engine in process) and `remote` (calls `/api/v1/scan`), same return shape |
| `src/agent/select.ts` | Selection profiles, quality gate and de-duplication |
| `src/agent/dest.ts` | Destination resolution and path safety |
| `src/agent/download.ts` | Fetching bytes (direct, then signed proxy in remote mode), writing files, naming, manifest |
| `src/agent/fonts.ts` | Font conversion, install, list, uninstall, licence reporting |
| `src/agent/summary.ts` | Compact summaries for agents (the token-cost rule) |
| `src/agent/cli.ts` | The `assets-scraper` command |
| `src/agent/mcp.ts` | The MCP server |
| `src/app/api/v1/scan/route.ts` | Agent JSON scan endpoint |
| `src/app/api/v1/assets.zip/route.ts` | Server-side ZIP of a selection |
| `src/app/llms.txt/route.ts`, `src/app/api/openapi.json/route.ts` | Machine-readable description of the API |
| `plugins/assets-scraper/**`, `.claude-plugin/marketplace.json` | Claude Code plugin: MCP server plus skill |

`pnpm build:agent` bundles `src/agent/cli.ts` and `src/agent/mcp.ts` with esbuild into `dist/cli.mjs` and `dist/mcp.mjs`, keeping the native and heavy packages external (`playwright-core`, `@sparticuz/chromium`, `sharp`, `fontkit`, `css-tree`, `undici`, `ipaddr.js`, `wawoff2`), so both run from the repo with its `node_modules` present.

## 4. Selection: what a download actually takes

The complaint this solves: the same image comes back several times, and many images are too small to use.

`selectAssets(assets, options)` with `profile: "deck" | "all"`, applied in this order:

1. **Role filter.** `deck` drops `icon` (longest rendered side <= 48 px) and `sprite-symbol`, keeps `site-logo`, `logo`, `social`, `illustration`, `image`, and keeps only the single largest `favicon`.
2. **Size gate.** A raster whose longest side is under `minLongSide` (default 600 px) is dropped unless its role is `site-logo`, `logo` or `favicon`. SVG has no size gate (it is vector and tiny). The exemption holds wherever the number came from, so a caller passing `minLongSide` gets the same gate rather than a plain filter; `profile: "all"` applies the gate only when the caller names a number.
3. **Prefer vector.** When an SVG and a raster normalize to the same name (extension, `@2x`, `-1024x512`, `_large` and similar suffixes removed), the raster is dropped.
4. **Exact duplicates.** Same SHA-1 of the downloaded bytes: keep one, preferring SVG, then the larger pixel area, then the format order `svg`, `png`, `webp`, `avif`, `jpg`, `gif`.
5. **Near duplicates.** A perceptual fingerprint per raster: alpha flattened onto white, a 17x16 greyscale field for a 256 bit difference hash, plus the aspect ratio and a 64x64 greyscale thumbnail. Two rasters are one group when the hashes are within a Hamming distance of 20, the aspect ratios agree to within 15 percent and the thumbnails agree (root mean square difference at most 3 of 255); a hash with too little horizontal contrast to carry a visual groups with nothing. Keep the same preference order as above. This is what removes a logo that appears as `logo.png`, `logo@2x.png` and `logo-dark.png` variants of the same visual, and the same photo served by two CDNs, without merging two different wordmarks or two cards cut from one template: a 64 bit hash of a graphic set 4 to 6 of its bits, so unrelated marks landed inside any useful distance, and dropping alpha rather than flattening it made every transparent mark the same empty field. The hash only says which pairs are worth comparing, never which pairs are the same picture: sibling assets from one template sit 2 to 5 bits apart, closer than a genuine resize, so the thumbnail comparison is the whole answer and it is read at 64x64 because 16x16 (duplicates up to 4.60, distinct siblings from 3.33) and 32x32 (6.70 against 4.24) both overlap while 64x64 (1.52 against 5.38) does not. The gate sits below the distinct band, so a harsh re-encode is kept as a second file rather than a distinct asset being merged away.
6. **Cap.** `max` (default 60) applied after sorting by relevance, so the useful assets survive.

Every dropped asset is counted by reason and reported (`dropped: { icon: 12, small: 31, duplicate: 9, vector-preferred: 4, cap: 0 }`), so an agent can say why it did not take something, and `profile: "all"` plus explicit filters override the whole thing.

Files land as `scrap/<host>/svg/`, `scrap/<host>/images/`, and a `scrap/<host>/manifest.json` recording, per file, its name, source URL, dimensions, bytes, role and why it was kept. Existing files are never silently overwritten: identical bytes are skipped, different bytes get `-2`.

## 5. Fonts: install, do not just download

`installFonts(families, options)`:

1. Pick one file per family: a loaded face covering Basic Latin, preferring the variable font when there is one.
2. Convert WOFF2 to TTF with `wawoff2` (WOFF through the same path when it decodes; otherwise the family is reported as not installable). TTF and OTF install as they are.
3. Write to `~/Library/Fonts/` on macOS (`~/.local/share/fonts/` on Linux), named `<Family>-<Style>.ttf`, never overwriting a file the tool did not install.
4. Record every install in `~/.local/state/assets-scraper/installed-fonts.json`: family, files, source host, licence kind and text, date, so `listInstalledFonts` and `uninstallFonts` can work.
5. Always report the licence read from the binary, including for commercial fonts, which install too (the owner's decision): `Söhne VF: commercial licence ("Copyright Klim Type Foundry"). Installed at ~/Library/Fonts/SohneVF-Regular.ttf`.

Adobe Fonts kit files stay excluded: the scan never exposes their bytes.

## 6. MCP server

Tools, all returning compact JSON:

| Tool | Input | Output |
|---|---|---|
| `scan_page` | `url`, optional `refresh` | `scanId`, page title and host, counts per kind, palette hexes with roles, fonts (family, licence kind, used on page), the logos (id, name, kind, dimensions), and the number of other assets. Never the full list |
| `list_assets` | `scanId`, optional `kind`, `role`, `minLongSide`, `nameContains`, `limit` (default 40), `offset` | Compact rows: id, name, kind, role, dimensions, bytes |
| `download_assets` | `scanId`, optional `ids`, `profile` (default `deck`), filters, `dest` | Written paths, total bytes, the drop reasons, and the destination directory |
| `read_svg` | `scanId`, `id` | The SVG markup as text |
| `get_palette` | `scanId` | Hexes with roles |
| `install_fonts` | `scanId`, optional `families` | Installed families with their licence, the paths, and what could not be installed and why |
| `list_installed_fonts` | | What this tool installed, with dates and sources |
| `uninstall_fonts` | `families` | What was removed |

A scan is cached in `~/.cache/assets-scraper/<scanId>.json` for one hour, so `download_assets` never rescans. `scan_page` on the same URL inside the hour reuses the cache unless `refresh` is true.

## 7. CLI

```
assets-scraper scan <url> [--json] [--remote]
assets-scraper get <url> [--out DIR] [--profile deck|all] [--kind svg,image] [--role logo]
                         [--min-long-side 600] [--max 60] [--name-contains x] [--json] [--remote]
assets-scraper fonts install <url> [--families "Inter,Söhne"] [--json]
assets-scraper fonts list [--json]
assets-scraper fonts uninstall <family> [--json]
```

Human output by default, `--json` for agents, exit code 1 on failure, every path printed absolute.

## 8. Hosted API for agents

- Auth: `Authorization: Bearer <token>` against `AGENT_TOKENS` (comma-separated). An agent token skips BotID, and nothing else: the WAF rate limit, the scan budget, the SSRF guards and every cap from v1 still apply. It is not the ops token, which keeps its own bypass.
- `POST /api/v1/scan` with `{ "url": "stripe.com", "view": "summary" | "full" }` returns one JSON document. `summary` (default) is the same shape the MCP `scan_page` returns; `full` adds every asset and font. Errors use the v1 error codes with the right HTTP status.
- `GET /api/v1/assets.zip?url=…&profile=deck&kinds=svg,image&roles=logo&max=60` streams a ZIP built on the server, with the same selection rules as section 4 and a `manifest.json` inside. Bytes count against the proxy daily budget.
- `GET /llms.txt` describes the tool, the endpoints, the auth, the limits and two copy-paste examples.
- `GET /api/openapi.json` is the OpenAPI 3.1 document for the same endpoints.
- `robots.txt` keeps disallowing everything; `llms.txt` is for agents that are told the URL, not for crawlers.

## 9. Claude Code plugin

`.claude-plugin/marketplace.json` at the repo root and `plugins/assets-scraper/` holding:

- `.claude-plugin/plugin.json` declaring the MCP server: `node ${CLAUDE_PLUGIN_ROOT}/../../dist/mcp.mjs`, passing `ASSETS_SCRAPER_REMOTE` and `ASSETS_SCRAPER_TOKEN` through when they are set.
- `skills/assets-scraper/SKILL.md`: when to use it, the workflow (scan, look at the summary, download the selection, install fonts), how to keep the context small, and the destination rule.

Install: `claude plugin marketplace add ~/Development/tools/assets_scraper` then `claude plugin install assets-scraper`. The README documents `pnpm install && pnpm build:agent` as the prerequisite, and the MCP entry fails with a clear message when the build or the dependencies are missing.

## 10. Security

- Local mode inherits every v1 guard: the scan engine runs Chromium behind the egress proxy, and every fetch goes through `safeFetch`.
- The CLI and MCP write only inside the resolved destination directory: the path is resolved, symlinks are refused, and anything outside the project root or the fallback directory is an error.
- Font installs write only into the user font directory, only files this tool created, and are reversible through the manifest.
- Agent tokens are compared in constant time, are never logged, and live only in env.
- The ZIP endpoint applies the v1 asset caps, the proxy byte budget and the content-type allowlist.

## 11. Out of scope

Publishing to npm, a hosted MCP endpoint, per-user accounts or quotas, image conversion or resizing, Lottie and video, and writing into a design tool (Figma plugin).
