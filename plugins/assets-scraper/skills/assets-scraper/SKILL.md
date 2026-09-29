---
name: assets-scraper
description: Use when you need the real assets of a web page: its logo, SVGs, images, web fonts or brand colors. Scans the page, reports a short summary, downloads only the usable files into scrap/ inside the current project, and installs the page fonts with their licence. Triggers on "get the logo from", "grab the assets of", "what fonts does this site use", "brand colors of", "download the images from this page", "rebuild this landing page with their own assets".
---

# Assets Scraper

Assets Scraper opens a page in a headless Chromium, walks the DOM, the CSSOM and the network capture, and reports what the page actually paints: SVGs (inline and from sprite sheets), images with their CDN originals, web fonts grouped by family with their licence, and the brand palette.

## When to use it

- The user wants a logo, an icon set, product shots, a font or the brand colors of a site.
- You are rebuilding or mimicking a page and need its own assets instead of placeholders.
- You need to know which fonts a site loads, and under which licence.

Do not use it to read a page's text or structure: fetch the page for that. Do not use it on a page behind a login: the scan runs unauthenticated.

## Tools

The plugin runs the MCP server. Match the tools by the names below, not by a prefix: the prefix depends on how the
server was installed (`mcp__assets-scraper__scan_page` for a server added by hand, `mcp__plugin_assets-scraper_assets-scraper__scan_page`
for the plugin), so looking for one exact prefix and finding nothing does not mean the plugin is missing.

| Tool | Use it for |
| --- | --- |
| `scan_page` | One scan. Returns a `scanId`, the counts, the palette, one row per font family and the logos. Never the full asset list |
| `list_assets` | Paging through the assets with filters (`kind`, `role`, `minLongSide`, `nameContains`, `limit`, `offset`) |
| `download_assets` | Writing files to disk, from a selection or from explicit `ids`. Takes the same `kind` and `role` filters |
| `read_svg` | The markup of one SVG, when you need to inline or edit it |
| `get_palette` | The palette hexes with their roles |
| `install_fonts` | Installing the page fonts locally, with the licence of each family |
| `list_installed_fonts`, `uninstall_fonts` | What this tool installed, and undoing it |

A scan is cached for one hour, so `list_assets`, `download_assets` and `install_fonts` reuse it. Pass `refresh: true` to `scan_page` only when the page has changed.

## Workflow

1. `scan_page` with the URL. Read the summary: it tells you the counts, the logos, the fonts and the palette.
2. Answer from the summary when that is enough. A question about colors or fonts is usually over at this step.
3. `list_assets` with filters when you need to pick specific files. Filter, never page through everything.
4. `download_assets` with the `scanId`. The default `deck` profile keeps what is usable and drops the rest.
5. `install_fonts` when the user wants to use the fonts, not just know their names. Report the licence it returns.
6. Tell the user the destination directory and what was dropped, in one or two lines.

## What a download takes

The `deck` profile, in order: icons (48 px and under) and sprite symbols out, only the largest favicon kept, rasters whose longest side is under 600 px out unless they are a logo or a favicon, files over 8 MB out, the raster dropped when an SVG of the same name exists, exact and near duplicates collapsed to one file, then a cap of 60 files sorted by relevance and a budget of 25 MB spent on the best scoring of them. SVG is never dropped for size.

Every drop is counted by reason (`icon`, `small`, `duplicate`, `near-duplicate`, `vector-preferred`, `extra-favicon`, `filter`, `cap`, `too-large`, `over-budget`), so you can say why a file is not there. When the user really wants everything, pass `profile: "all"`, and when they want one specific file, pass its `ids`.

A download the byte budget cut reports `over-budget` and `too-large`. Raise `maxTotalBytes` or `maxFileBytes` when the user asked for the big files, or pass 0 to take the selection whatever it weighs. An asset named by `ids` is written whatever its size, so a 30 MB hero the user asked for by id is never refused.

The cap gives each kind its share of the 60 files, so a page whose vectors outrank its photos still yields both. `download_assets` answers the paths relative to `dir` plus the counts, and the full row per file (source URL included) is in `manifest.json` on disk.

## Where the files go

Files land in `scrap/<host>/` inside the current project: `svg/`, `images/`, and a `manifest.json` recording every file with its source URL, dimensions, bytes, role and why it was kept. The project root is the git root of the working directory, or the nearest directory holding `package.json`, `pyproject.toml` or `.claude`. The home directory itself never counts as a project, so a session started outside one writes to `~/Downloads/assets-scraper/<host>/`.

Leave `dest` unset unless the user names a directory. A `dest` you pass has to stay inside `scrap/`, so scraped files never land in the source tree. Existing files are never overwritten: identical bytes are skipped, different bytes get a `-2` suffix.

## Fonts

`install_fonts` converts WOFF2 and WOFF to TTF and copies the files into the user font directory (`~/Library/Fonts` on macOS, `~/.local/share/fonts` on Linux), so the font is usable in Figma, Keynote or a local app right away. It records every install, so `uninstall_fonts` can undo it.

It installs commercial families too, and it always reports the licence read from the font binary. Pass that licence on to the user verbatim: using a commercial font is their call, not yours. Adobe Fonts kit families cannot be installed, and the tool says so.

## Keeping the context small

- Never list every asset. The summary and filtered `list_assets` calls are the whole point.
- Never ask for bytes. Files go to disk, tools return paths. The only content you ever read is SVG markup through `read_svg` and the palette hexes.
- Never paste a `manifest.json` into the conversation. Say how many files landed where.
- One scan per page. The `scanId` is what every other call needs.

## Examples

### The user wants the logo

> Get me the Stripe logo.

`scan_page` with `https://stripe.com`, read the `logos` rows in the summary, then `download_assets` with the id of the SVG site logo. Each row carries its `format` and `bytes`: prefer the `svg` row, and treat a multi-megabyte raster of photographic dimensions as a picture the scan called a logo rather than as the mark. Report the path: `scrap/stripe.com/svg/stripe-logo.svg`.

### The user is rebuilding a page

> Rebuild this pricing page with their own assets: https://linear.app/pricing

`scan_page`, then `download_assets` with the `scanId` and no filters (the `deck` profile is the right default), then `get_palette` for the colors and `install_fonts` for the typefaces. Use the written paths in the code you generate, and tell the user the palette and the font licences.

### The user asks about fonts only

> What fonts does vercel.com use, and can I use them?

`scan_page`, then answer from the `fonts` rows of the summary: family, licence kind, whether it is used on the page and whether it is installable. Install nothing until the user asks, then `install_fonts` and report each licence.

## Setup

The MCP server runs the bundle in the repository: `pnpm install && pnpm build:agent` in the Assets Scraper checkout, with Google Chrome present for the local scan. If a tool call fails saying the build or the dependencies are missing, run those two commands and retry. `docs/agents.md` in that repository covers the CLI and the hosted HTTP API for agents that cannot use MCP.
