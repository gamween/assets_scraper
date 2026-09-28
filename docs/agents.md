# Use Assets Scraper from an agent

An agent can scan a page, read a short summary of what is on it, download only the files that are usable, and install the page fonts. There are three ways in, all on the same core (`src/agent/*`): the MCP server, the CLI, and the hosted HTTP API.

Design: `docs/superpowers/specs/2026-09-27-agent-access-design.md`.

## Which one to use

| Way in | Use it when | Where the scan runs |
| --- | --- | --- |
| MCP server | The agent is Claude Code, or any MCP client | Locally, in your Chrome, unless `ASSETS_SCRAPER_REMOTE` is set |
| CLI | The agent has a shell, or you are doing this by hand | Same |
| HTTP API | The agent only speaks HTTP, or has no machine of its own | On the hosted app |

Local is the default everywhere: nothing leaves the machine, and it does not spend the hosted scan budget.

## 1. MCP server (Claude Code plugin)

```bash
git clone https://github.com/gamween/assets_scraper
cd assets_scraper
pnpm install
pnpm build:agent
claude plugin marketplace add "$PWD"
claude plugin install assets-scraper
```

Google Chrome has to be installed for a local scan. Set `CHROME_EXECUTABLE_PATH` if it is not in the default location. The plugin starts the server through `scripts/mcp-launcher.mjs`, which runs `dist/mcp.mjs` and fails with a clear message when the build or the dependencies are missing.

The marketplace stays pointed at the clone, and the bundle the launcher runs, `dist/mcp.mjs`, is not committed. The launcher rebuilds it whenever it is missing or older than any source file under `src/agent`, `src/server` or `src/lib`, so a `git pull` no longer leaves the MCP server serving the bundle of an older commit. The generated in-page bundles under `src/server/scan/inpage/generated` are build output, not sources, so a `pnpm test` that rewrote them is not a reason to rebuild. Restart Claude Code to pick up a rebuilt bundle. A rebuild it cannot do, node_modules not installed for instance, is reported on stderr and the server does not start. `claude mcp list` shows the server as `plugin:assets-scraper:assets-scraper` with the path it runs.

Tools, all returning compact JSON, never bytes:

| Tool | Input | Output |
| --- | --- | --- |
| `scan_page` | `url`, optional `refresh` | `scanId`, the page, counts per kind, the palette, one row per font family, the logos, and how many other assets there are |
| `list_assets` | `scanId`, optional `kind`, `role`, `minLongSide`, `nameContains`, `limit` (40), `offset` | Compact rows: id, name, kind, role, dimensions, bytes |
| `download_assets` | `scanId`, optional `ids`, `profile`, filters, `dest` | The written paths, total bytes, the drop reasons, the destination |
| `read_svg` | `scanId`, `id` | `{ id, name, filename, markup }`, the markup as text, refused past 256 KB |
| `get_palette` | `scanId` | The palette hexes with their roles |
| `install_fonts` | `scanId`, optional `families` | Installed families with their licence and paths, and what could not be installed and why |
| `list_installed_fonts` | | What this tool installed, with dates and sources |
| `uninstall_fonts` | `families` | What was removed |

A scan is cached in `~/.cache/assets-scraper/<scanId>.json` for one hour, so `download_assets` and `install_fonts` never rescan. `scan_page` on the same URL inside the hour reuses the cache unless `refresh` is true. Reuse is scoped to where the scan ran: a run only reuses a scan of the same source, which for a remote run means the same hosted app (`--remote-url`, `ASSETS_SCRAPER_REMOTE`). A local run never reads a remote scan, a remote run never reads a local one, and a run against staging never reads a scan of production. A second remote run of the same URL inside the hour is still answered from the cache rather than by the hosted app, so use `refresh` when the answer has to be a new scan.

The plugin also ships the `assets-scraper` skill, which tells the agent the workflow and the context rules: scan, read the summary, filter, download, install fonts, and never list every asset or paste bytes.

## 2. CLI

```bash
pnpm build:agent
node dist/cli.mjs scan stripe.com
```

```
assets-scraper scan <url> [--json] [--remote]
assets-scraper get <url> [--out DIR] [--profile deck|all] [--kind svg,image] [--role logo]
                         [--min-long-side 600] [--max 60] [--name-contains x] [--json] [--remote]
assets-scraper fonts install <url> [--families "Inter,Roboto"] [--json]
assets-scraper fonts list [--json]
assets-scraper fonts uninstall <family> [--json]
```

Human output by default, `--json` for agents, exit code 1 on failure, every path printed absolute.

## 3. Hosted HTTP API

Ask the owner for a token, then:

```bash
curl -s https://assets-scraper.vercel.app/api/v1/scan \
  -H "Authorization: Bearer $ASSETS_SCRAPER_TOKEN" \
  -H "content-type: application/json" \
  -d '{"url":"stripe.com","view":"summary"}'
```

```bash
curl -s -o assets.zip \
  -H "Authorization: Bearer $ASSETS_SCRAPER_TOKEN" \
  "https://assets-scraper.vercel.app/api/v1/assets.zip?url=stripe.com&profile=deck&kinds=svg&max=20"
```

- `POST /api/v1/scan` takes `{ "url": "...", "view": "summary" | "full" }` and returns one JSON document. `summary` is what `scan_page` returns; `full` adds every asset and font.
- `GET /api/v1/assets.zip?url=...&profile=deck&kinds=svg,image&roles=logo&max=60` streams a ZIP with the same selection rules and a `manifest.json` inside.
- `GET /llms.txt` and `GET /api/openapi.json` describe both endpoints for machines.

A token skips the bot check and nothing else: the rate limit, the scan budget, the SSRF guards and every v1 cap still apply. Tokens live in the `AGENT_TOKENS` environment variable of the deployment, comma separated, and are never logged.

Running the deployment: `AGENT_TOKENS` is set for production and preview in the Vercel project, and adding a client means appending its token to that variable and redeploying. The owner's own token is kept out of the repo, in `~/.config/assets-scraper/agent.env` (mode 600, key `AGENT_TOKEN`), so a shell reads it with `set -a; . ~/.config/assets-scraper/agent.env; set +a` and then uses `$AGENT_TOKEN`. The CLI and the MCP server read a token from `ASSETS_SCRAPER_TOKEN`, not from that file.

## What a download takes

The point of the `deck` profile (the default) is that a download does not take everything blindly. In order:

1. Roles: `icon` (48 px and under) and `sprite-symbol` out, `site-logo`, `logo`, `social`, `illustration` and `image` in, and only the largest `favicon`.
2. Size: a raster whose longest side is under 600 px is dropped unless its role is `site-logo`, `logo` or `favicon`. SVG has no size gate.
3. Vector wins: when an SVG and a raster normalize to the same name (`@2x`, `-1024x512`, `_large` and similar suffixes off), the raster goes.
4. Exact duplicates: same bytes, one file kept, preferring SVG, then the larger pixel area, then `svg`, `png`, `webp`, `avif`, `jpg`, `gif`.
5. Near duplicates: a perceptual fingerprint per raster groups `logo.png`, `logo@2x.png` and the same photo from two CDNs, without merging two different wordmarks.
6. Cap: 60 files, after sorting by relevance.

Every drop is counted by reason (`icon`, `small`, `duplicate`, `near-duplicate`, `vector-preferred`, `extra-favicon`, `filter`, `cap`, `unavailable`), so an agent can say why a file is not there. `profile: "all"` plus explicit filters override the whole thing, and explicit `ids` win over every rule except the cap and path safety.

## Where the files go

Files land in `scrap/<host>/` inside the current project, as `svg/`, `images/` and a `manifest.json` recording every file with its name, source URL, dimensions, bytes, role and why it was kept.

The destination rule, strongest first:

1. An explicit destination (`--out` on the CLI, `dest` on `download_assets`).
2. `ASSETS_SCRAPER_OUT`, with the host appended.
3. `<project root>/scrap/<host>`, where the project root is the git root of the working directory, or the nearest directory above it holding `package.json`, `pyproject.toml` or `.claude`.
4. `~/Downloads/assets-scraper/<host>` when there is no project.

A `dest` that came from an agent is held to the narrower rule: it has to be inside `<project root>/scrap`, so an agent cannot drop scraped files into the source tree. A `--out` you type yourself is your own choice and is not restricted. Existing files are never silently overwritten: identical bytes are skipped, different bytes get a `-2` suffix. Symlinks on the way to a destination are refused, and every file is created with `O_EXCL | O_NOFOLLOW`.

## Fonts

`install_fonts` (and `assets-scraper fonts install`) does not just download a font, it installs it:

1. One file per family: a loaded face covering Basic Latin, preferring the variable font.
2. WOFF2 is converted to TTF. TTF and OTF install as they are. A format that does not convert is reported as not installable.
3. The file is written to `~/Library/Fonts` on macOS, `~/.local/share/fonts` on Linux, as `<Family>-<Style>.ttf`, and a file the tool did not install is never overwritten.
4. Every install is recorded in `~/.local/state/assets-scraper/installed-fonts.json` (family, files, source host, licence kind and text, date), so `list_installed_fonts` and `uninstall_fonts` work and an install is reversible.

The licence read from the font binary is reported every time, including for commercial families, which do install. Whether you may use a commercial font is your call, not the tool's, so the licence text is printed rather than the install being refused. Adobe Fonts kit families cannot be installed: the scan never exposes their bytes.

## Limits and environment

Agent limits live in `src/agent/limits.ts` and each one is overridden by the SCREAMING_SNAKE_CASE of its key with an `AGENT_` prefix (`minLongSide` reads `AGENT_MIN_LONG_SIDE`):

| Limit | Default |
| --- | --- |
| `minLongSide` | 600 px |
| `maxFiles` | 60 files |
| `nearDuplicateDistance` | 20 |
| `scanCacheTtlMs` | 1 hour |
| `downloadConcurrency` | 6 |
| `maxDownloadBytes` | 300 MB per download |
| `fontInstallMaxBytes` | 8 MB per font file |

Every v1 limit still applies to the scan itself: 90 s for the whole scan, at most 1,500 assets, 1 MB per SVG, 25 MB per proxied file. See the limits section of the README.

| Variable | Purpose |
| --- | --- |
| `ASSETS_SCRAPER_REMOTE` | Base URL of a hosted app to scan against instead of locally |
| `ASSETS_SCRAPER_TOKEN` | Bearer token for that app |
| `ASSETS_SCRAPER_OUT` | Destination root, host appended, overriding the project rule |
| `CHROME_EXECUTABLE_PATH` | Chrome, when it is not in the default location |
| `XDG_CACHE_HOME` | Where the scan cache goes, `~/.cache` by default |
