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

Google Chrome has to be installed for a local scan. Set `CHROME_EXECUTABLE_PATH` if it is not in the default location. Chrome runs headless with its sandbox on, behind the scan's egress proxy: the pages an agent scans are pages nobody vetted, and the sandbox is what contains one that exploits the renderer. On a Linux host where the sandbox cannot start (running as root, or a container without user namespaces), the launch fails and says so; `ASSETS_SCRAPER_NO_SANDBOX=1` runs Chrome without it there, and nowhere else is it worth setting. The plugin starts the server through `scripts/mcp-launcher.mjs`, which runs `dist/mcp.mjs` and fails with a clear message when the build or the dependencies are missing.

The marketplace stays pointed at the clone, and the bundle the launcher runs, `dist/mcp.mjs`, is not committed. The launcher rebuilds it whenever it is missing or older than any source file under `src/agent`, `src/server` or `src/lib`, so a `git pull` no longer leaves the MCP server serving the bundle of an older commit. The generated in-page bundles under `src/server/scan/inpage/generated` are build output, not sources, so a `pnpm test` that rewrote them is not a reason to rebuild. Restart Claude Code to pick up a rebuilt bundle. A rebuild it cannot do, node_modules not installed for instance, is reported on stderr and the server does not start. `claude mcp list` shows the server as `plugin:assets-scraper:assets-scraper` with the path it runs.

Tools, all returning compact JSON, never bytes:

| Tool | Input | Output |
| --- | --- | --- |
| `scan_page` | `url`, optional `refresh` | `scanId`, the page, counts per kind, the palette, one row per font family, the logos, and how many other assets there are |
| `list_assets` | `scanId`, optional `kind`, `role`, `minLongSide`, `nameContains`, `limit` (40), `offset` | Compact rows: id, name, kind, role, dimensions, bytes |
| `download_assets` | `scanId`, optional `ids`, `profile`, filters, `maxTotalBytes`, `maxFileBytes`, `dest` | The written paths, total bytes, the drop reasons, the destination |
| `read_svg` | `scanId`, `id` | `{ id, name, filename, markup }`, the markup as text, refused past 256 KB |
| `get_palette` | `scanId` | The palette hexes with their roles |
| `install_fonts` | `scanId`, optional `families` | Installed families with their licence and paths, and what could not be installed and why |
| `list_installed_fonts` | | What this tool installed, with dates and sources |
| `uninstall_fonts` | `families` | What was removed |

A cached scan is stamped with the build that produced it, the package version plus a digest of the bundles in `dist/`, and only that build reads it back. A rebuild or an upgrade therefore starts from a cold cache rather than serving an hour of results from the code you just replaced. `ASSETS_SCRAPER_BUILD_ID` names the identity yourself when you need two runs to share, or not share, a cache.

A scan is cached in `~/.cache/assets-scraper/<scanId>.json` for one hour, so `download_assets` and `install_fonts` never rescan. `scan_page` on the same URL inside the hour reuses the cache unless `refresh` is true. Reuse is scoped to where the scan ran: a run only reuses a scan of the same source, which for a remote run means the same hosted app (`--remote-url`, `ASSETS_SCRAPER_REMOTE`). A local run never reads a remote scan, a remote run never reads a local one, and a run against staging never reads a scan of production. A second remote run of the same URL inside the hour is still answered from the cache rather than by the hosted app, so use `refresh` when the answer has to be a new scan. Reading a scan back needs no token: an MCP server started with `ASSETS_SCRAPER_REMOTE` set and `ASSETS_SCRAPER_TOKEN` unset still answers `scan_page` from a fresh scan of that same app, and asks for the token on the call that has to run a scan.

The plugin also ships the `assets-scraper` skill, which tells the agent the workflow and the context rules: scan, read the summary, filter, download, install fonts, and never list every asset or paste bytes.

## 2. CLI

```bash
pnpm build:agent
node dist/cli.mjs scan stripe.com
```

`package.json` declares the `assets-scraper` command (`bin`, pointing at `dist/cli.mjs`), so after `pnpm build:agent` a `pnpm link --global` in the clone puts it on your PATH, and every example below works as written. `dist/` is not committed: build it first, and again after a pull.

`assets-scraper --help` is the reference:

```
assets-scraper scan <url> [options]
assets-scraper get <url> [options]
assets-scraper fonts install <url> [options]
assets-scraper fonts list [options]
assets-scraper fonts uninstall <family> [options]

--out DIR             Where to write. Default: <project root>/scrap/<host>, or ~/Downloads/assets-scraper/<host>
--profile deck|all    deck (default) drops icons, thumbnails, small images and duplicates. all keeps everything
--kind svg,image      Only these kinds
--role logo,site-logo Only these roles
--min-long-side 600   Drop a raster whose longest side is under this, logos and favicons excepted
--max 60              Files one download writes, highest scoring first
--max-bytes N         Bytes one download writes, best scoring first. 0 takes the selection whatever it weighs
--max-file-bytes N    Bytes one file may take under the deck profile, 0 to lift it
--name-contains TEXT  Only assets whose name holds TEXT
--include-icons       Keep icons the deck profile would drop, at any size. --role icon does the same
--families "A,B"      Font families to install or remove, as scan reported them
--json                Print JSON instead of a report
--refresh             Scan again instead of reusing a scan of the last hour
--remote              Scan on the hosted app. Needs ASSETS_SCRAPER_TOKEN
--remote-url URL      The hosted app to use. Default: ASSETS_SCRAPER_REMOTE, then https://assets-scraper.vercel.app
--token TOKEN         Agent token for the hosted app. Prefer ASSETS_SCRAPER_TOKEN
--help, --version
```

Human output by default, `--json` for agents, exit code 1 on failure, every path printed absolute. The human report is terminal safe: page titles and font family names are page text, and their control characters are replaced before they are printed. Pass the token through `ASSETS_SCRAPER_TOKEN` rather than `--token`: other users of the machine can read a command line with `ps`, and the shell keeps it in its history.

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

A token skips the bot check and nothing else: the access code, the rate limit, the scan budget, the SSRF guards and every v1 cap still apply. On a deployment the owner put behind `ACCESS_CODE`, send the code in `x-access-code` next to the token; the CLI and the MCP server send `ASSETS_SCRAPER_ACCESS_CODE` when it is set. Tokens live in the `AGENT_TOKENS` environment variable of the deployment, comma separated, and are never logged.

A client the hosting firewall challenges gets `403` with an HTML page and `x-vercel-mitigated: challenge` on every path until it expires, which only a browser can pass. The CLI and the MCP server say so in words (`the firewall of ... stopped this client`) rather than as a refused token: wait a few minutes, or scan locally.

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

A `dest` that came from an agent is held to the narrower rule: it is read relative to `<project root>/scrap` (`dest: "stripe-brand"` is `scrap/stripe-brand`) and has to stay inside it, so an agent cannot drop scraped files into the source tree. The project rule and the fallback are held the same way once symbolic links are resolved: a `scrap` or `scrap/<host>` that links out of the project is refused rather than followed. A `--out` you type yourself, or `ASSETS_SCRAPER_OUT`, is your own choice and is not restricted.

Existing files are never silently overwritten: identical bytes are skipped, different bytes get a `-2` suffix, and names that differ only in case count as the same name, as they do on macOS. A file takes the extension of its format, whatever name the scan gave it, and bytes an asset carries inline are checked against that format like fetched ones. Every file is created with `O_EXCL | O_NOFOLLOW`.

`manifest.json` lists every file the tool wrote into the folder that is still there, so a second download into it extends the listing; the counts and drops describe the latest download. A `manifest.json` the tool did not write (a web app's `public/manifest.json`, a browser extension's) is never touched: the manifest goes to `assets-scraper-manifest.json` next to it instead, and the answer's `manifestPath` names it.

## Fonts

`install_fonts` (and `assets-scraper fonts install`) does not just download a font, it installs it:

1. One file per family: a loaded face covering Basic Latin, preferring the variable font. When that file cannot be fetched or converted, the next best one is tried.
2. WOFF2 and WOFF are converted to the TrueType (or, for a CFF font, OpenType) font they wrap. TTF and OTF install as they are. EOT and other formats are not installable, and neither is a family with no file covering Basic Latin (an icon font): the `installable` column of the scan summary follows the same rule.
3. The file is written to `~/Library/Fonts` on macOS, `~/.local/share/fonts` on Linux (`ASSETS_SCRAPER_FONT_DIR` overrides it), as `<Family>-<Style>.ttf`, and a file the tool did not install is never overwritten.
4. Every install is recorded in `installed-fonts.json` under `~/.local/state/assets-scraper` (`$XDG_STATE_HOME/assets-scraper` when that is set, `ASSETS_SCRAPER_STATE_DIR` over both): family, files, source host, licence kind and text, date, and the size, modification time and inode of each file written. `list_installed_fonts` and `uninstall_fonts` work from it, so an install is reversible, and a file is only ever removed while it is still the one the tool wrote: a font you installed yourself under the same name is left in place and reported, and the record of it forgotten. Installs from two sessions at once wait for each other through a lock file next to the manifest.

The licence read from the font binary is reported every time, including for commercial families, which do install. Whether you may use a commercial font is your call, not the tool's, so the licence text is printed rather than the install being refused. Adobe Fonts kit families cannot be installed: the scan never exposes their bytes.

## Limits and environment

Agent limits live in `src/agent/limits.ts` and each one is overridden by the SCREAMING_SNAKE_CASE of its key with an `AGENT_` prefix (`minLongSide` reads `AGENT_MIN_LONG_SIDE`):

| Limit | Default |
| --- | --- |
| `minLongSide` | 600 px |
| `maxFiles` | 60 files |
| `maxTotalBytes` | 25 MB per download |
| `maxFileBytes` | 8 MB per file, deck profile |
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
| `ASSETS_SCRAPER_ACCESS_CODE` | The access code of that app, when its owner set `ACCESS_CODE` |
| `ASSETS_SCRAPER_OUT` | Destination root, host appended, overriding the project rule |
| `CHROME_EXECUTABLE_PATH` | Chrome, when it is not in the default location |
| `ASSETS_SCRAPER_NO_SANDBOX` | `1` runs Chrome without its sandbox, only for a host where it cannot start one |
| `XDG_CACHE_HOME` | Where the scan cache goes, `~/.cache` by default |
