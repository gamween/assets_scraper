# Agent access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build what `docs/superpowers/specs/2026-09-27-agent-access-design.md` describes: an agent core with smart selection, a CLI, an MCP server with font installation, a hosted JSON and ZIP API for agents, and a Claude Code plugin.

**Architecture:** One shared core (`src/agent/*`) on top of the v1 scan engine, with a local source (Chromium in process) and a remote source (the hosted `/api/v1`). The CLI, the MCP server and the hosted routes are thin adapters over that core.

**Tech Stack:** The v1 stack plus `@modelcontextprotocol/sdk` for the MCP server, `sharp` for perceptual hashing, `wawoff2` for font conversion, `esbuild` for the two bundles.

---

## 0. How this plan is executed

- **G1 (sequential):** agent core contracts, selection, destination, summary, cache, local source, build script. Merged before the rest.
- **G2 to G5 (parallel, one worktree and branch each):** CLI and download, MCP and fonts, hosted API v1, plugin and docs. Each track owns its files, never edits another track's files, and never edits `src/lib/contract.ts`, `src/server/**` (except the routes it owns) or `src/agent/{types,select,dest,summary,cache}.ts`.
- **Integration:** merge in order G2, G3, G4, G5, then wire, run everything, review, deploy.

Conventions are the v1 ones: TDD, conventional commits, PR per branch, CI green before merge, no em dash or en dash in copy, files under 400 lines where possible, every limit in `src/server/config/limits.ts` or a new `src/agent/limits.ts` for agent-only values.

---

## Phase G1: Agent core (branch `feat/agent-core`)

### Task G1.1: Contracts and limits

**Files:** Create `src/agent/types.ts`, `src/agent/limits.ts`.

- [ ] **Step 1: Write `src/agent/types.ts`** with exactly these exports (other tracks code against them):

```ts
import type { Asset, AssetKind, AssetRole, AssetSource, Diagnostics, FontFamily, FontFile, FontLicense, Palette, ScanStats } from "@/lib/contract";

export interface AgentScan {
  scanId: string;
  scannedAt: string;                    // ISO 8601
  source: "local" | "remote";
  page: { url: string; finalUrl: string; host: string; title: string; siteName?: string };
  assets: Asset[];
  fonts: FontFamily[];
  palette: Palette | null;
  stats: ScanStats;
  warnings: string[];
  diagnostics?: Diagnostics;
}

export interface ScanSourceOptions { remote?: string; token?: string }

export interface ScanSource {
  readonly kind: "local" | "remote";
  scan(url: string, options?: { signal?: AbortSignal; onStep?: (step: string) => void }): Promise<AgentScan>;
  fetchBytes(target: AssetSource | FontFile, options?: { signal?: AbortSignal }): Promise<Buffer>;
}

export type SelectionProfile = "deck" | "all";

export interface SelectionOptions {
  profile?: SelectionProfile;           // default "deck"
  ids?: string[];                       // explicit ids win over every other filter except path safety
  kinds?: AssetKind[];
  roles?: AssetRole[];
  minLongSide?: number;                 // default from limits
  nameContains?: string;
  includeIcons?: boolean;
  max?: number;                         // default from limits
}

export type DropReason = "icon" | "sprite" | "small" | "duplicate" | "near-duplicate" | "vector-preferred" | "extra-favicon" | "filter" | "cap" | "unavailable";

export interface Selection {
  keep: Asset[];
  dropped: Partial<Record<DropReason, number>>;
  duplicates: { keptId: string; droppedIds: string[] }[];
}

export interface DownloadedFile {
  id: string; name: string; path: string; bytes: number; kind: AssetKind; role: AssetRole;
  width?: number; height?: number; url: string;
}

export interface DownloadResult {
  dir: string;
  files: DownloadedFile[];
  totalBytes: number;
  dropped: Partial<Record<DropReason, number>>;
  failed: { id: string; name: string; reason: string }[];
  manifestPath: string;
}

export interface FontInstall {
  family: string; files: string[]; license: FontLicense; sourceHost: string; installedAt: string; converted: boolean;
}

export interface ScanSummary {
  scanId: string;
  page: AgentScan["page"];
  counts: { assets: number; svg: number; images: number; fonts: number; hidden: number };
  palette: { hex: string; role?: string }[];
  fonts: { family: string; license: FontLicense["kind"]; usedOnPage: boolean; installable: boolean }[];
  logos: { id: string; name: string; kind: AssetKind; width?: number; height?: number }[];
  otherAssets: number;
  warnings: string[];
  durationMs: number;
}
```

- [ ] **Step 2: `src/agent/limits.ts`** in the shape of `src/server/config/limits.ts` (getters reading env, whole numbers only): `minLongSide` 600, `maxFiles` 60, `nearDuplicateDistance` 5, `scanCacheTtlMs` 3_600_000, `downloadConcurrency` 6, `maxDownloadBytes` 300 * MB, `fontInstallMaxBytes` 8 * MB. Env names `AGENT_MIN_LONG_SIDE` and so on.

- [ ] **Step 3: Commit** `feat(agent): add agent core contracts and limits`

### Task G1.2: Destination resolution

**Files:** `src/agent/dest.ts`, `src/agent/dest.test.ts`

- [ ] **Step 1: Failing tests** (build temp trees with `fs.mkdtemp`):
  - a cwd inside a git repo gives `<repo>/scrap/<host>` and `projectRoot` the repo root;
  - a cwd inside a directory with `package.json` but no git gives the same rule from that directory;
  - a cwd with neither gives `~/Downloads/assets-scraper/<host>` and `fallback: true`;
  - an explicit relative dest resolves against cwd; an explicit absolute dest is used as is;
  - `ASSETS_SCRAPER_OUT` wins over the project rule and loses to an explicit dest;
  - the host is sanitized (`www.` kept off, punycode kept, no path separators, no `..`);
  - `assertInside(root, target)` throws for `..` escapes, for an absolute path outside the root, and for a symlink pointing outside; it passes for a nested path.
- [ ] **Step 2: Run, see failures** (`pnpm exec vitest run src/agent/dest.test.ts`)
- [ ] **Step 3: Implement** `resolveDestination` and `assertInside` (use `fs.realpathSync` on the existing parent when checking symlinks).
- [ ] **Step 4: Run** (PASS) **Step 5: Commit** `feat(agent): resolve the scrap destination inside the current project`

### Task G1.3: Selection, quality gate and de-duplication

**Files:** `src/agent/select.ts`, `src/agent/select.test.ts`, `src/agent/hash.ts`, `src/agent/hash.test.ts`

- [ ] **Step 1: Failing tests for `hash.ts`**: `dHash(buffer)` returns a 16 character hex string for a PNG generated with sharp; the same image resized to 50 percent gives a distance <= 2; a horizontally flipped image gives a distance >= 12; `hammingDistance(a, b)` is symmetric and 0 for equal hashes; a non-image buffer returns null.
- [ ] **Step 2: Failing tests for `select.ts`** (assets built by a small factory in the test file, bytes provided through the optional map):
  - `deck` drops `icon` and `sprite-symbol`, keeps `site-logo`, `logo`, `social`, `illustration`, `image`;
  - a raster with a 320 px long side is dropped as `small`, the same asset with role `logo` is kept;
  - SVG is never dropped for size;
  - `logo.svg` and `logo@2x.png` normalize to the same name, the PNG is dropped as `vector-preferred`;
  - two assets with identical bytes keep the SVG, and the dropped id appears in `duplicates`;
  - two rasters within distance 3 keep the one with the larger pixel area, and both are recorded in `duplicates`;
  - three favicons keep only the largest, the others are `extra-favicon`;
  - `max: 2` keeps the two highest scoring assets and counts the rest as `cap`;
  - `ids` bypasses the profile entirely (an icon named in `ids` is kept);
  - `profile: "all"` keeps everything the filters allow, with no size gate and no perceptual de-duplication;
  - `nameContains`, `kinds` and `roles` each filter and count as `filter`; an explicit `minLongSide` is the size gate of spec 4.2, not a plain filter, so it keeps the `site-logo`, `logo` and `favicon` exemption, counts as `small`, and applies in `profile: "all"` only when the caller names it;
  - the same input always gives the same output order (sorted by `score` then `order`).
- [ ] **Step 3: Run, see failures** **Step 4: Implement** in the order of spec section 4. Perceptual hashing only runs on rasters whose bytes are in the map, so `selectAssets` works before download (name and size rules only) and again after download (byte rules), which is how `downloadAssets` uses it.
- [ ] **Step 5: Run** (PASS) **Step 6: Commit** `feat(agent): select usable assets and drop duplicates`

### Task G1.4: Summary and cache

**Files:** `src/agent/summary.ts`, `summary.test.ts`, `src/agent/cache.ts`, `cache.test.ts`

- [ ] **Step 1: Failing tests**: `summarize` on a scan with 236 assets returns at most 8 logos, the counts, the palette hexes, one row per font family, `otherAssets` equal to the rest, and the whole JSON stays under 4 KB; fonts report `installable` false for an Adobe Fonts family and true for a self-hosted WOFF2. `cache`: `saveScan` writes `~/.cache/assets-scraper/<scanId>.json` (respecting `XDG_CACHE_HOME`), `loadScan` round-trips, `findRecentScan(url, ttl)` returns the newest scan of that URL inside the TTL and null past it, and a corrupt file is ignored rather than thrown.
- [ ] **Step 2: Run, see failures** **Step 3: Implement.** **Step 4: Run** (PASS) **Step 5: Commit** `feat(agent): summarize scans for agents and cache them`

### Task G1.5: Local scan source

**Files:** `src/agent/source-local.ts`, `src/agent/source.ts`, `tests/integration/agent/local-source.test.ts`

- [ ] **Step 1: Failing integration test** against the fixture site (`SCAN_TEST_ALLOW_HOSTS`): `createScanSource().scan(fixtureUrl)` returns an `AgentScan` with `source: "local"`, the fixture's site logo among the assets, the fonts, a palette, and a `scanId` that `saveScan` accepts; `fetchBytes` on the site logo returns the SVG bytes; an unreachable URL rejects with the engine's `ScanFailure` code.
- [ ] **Step 2: Run, see failures** **Step 3: Implement**: consume `scanEngine.scan()` events into an `AgentScan` (the last `page` event wins, assets batches concatenated, `error` events become a thrown `ScanFailure`), generate the scan id from the final URL plus the timestamp, and implement `fetchBytes` with `safeFetch` (inline assets return their bytes without a request). `src/agent/source.ts` exports `createScanSource(options)` choosing local unless `remote` (or `ASSETS_SCRAPER_REMOTE`) is set, with the remote implementation stubbed as `NotImplementedError` for track G2 to write.
- [ ] **Step 4: Run** (PASS) **Step 5: Commit** `feat(agent): run scans locally through the v1 engine`

### Task G1.6: Build script and PR

**Files:** `scripts/build-agent.mjs`, `package.json` scripts, `.gitignore`

- [ ] **Step 1:** `scripts/build-agent.mjs` bundles `src/agent/cli.ts` and `src/agent/mcp.ts` with esbuild (platform node, format esm, target node22, `packages: "external"` for `playwright-core`, `@sparticuz/chromium`, `sharp`, `fontkit`, `css-tree`, `undici`, `ipaddr.js`, `wawoff2`, `@modelcontextprotocol/sdk`), writing `dist/cli.mjs` and `dist/mcp.mjs` with a shebang, and resolving the `@/` alias from `tsconfig.json`. Until G2 and G3 land, missing entry points are skipped with a warning rather than failing.
- [ ] **Step 2:** `package.json`: `"build:agent": "node scripts/build-agent.mjs"`, and `"prepack"` is not needed. Add `dist/` to `.gitignore`.
- [ ] **Step 3:** Run `pnpm build:agent`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration`.
- [ ] **Step 4: Commit and PR** `feat(agent): add the agent core` and merge after CI.

---

## Phase G2: CLI and download (branch `feat/agent-cli`)

Owns `src/agent/{download,source-remote,cli}.ts`, `src/agent/*.test.ts` for those, `tests/integration/agent/cli.test.ts`.

### Task G2.1: Download

- [ ] **Step 1: Failing tests** (unit with a fake `ScanSource`, integration against the fixture with the real local source):
  - files land in `<dest>/svg/` and `<dest>/images/` with the asset filenames, and `manifest.json` lists every file with its source URL, dimensions, bytes, role and keep reason;
  - inline SVG assets are written from their markup without any request;
  - selection runs twice: name and size rules before fetching, byte rules (exact and perceptual duplicates) after, so a duplicate discovered from bytes is deleted from disk, not left behind;
  - identical bytes for an existing file are skipped (not rewritten), different bytes get `-2`;
  - a fetch failure lands in `failed` with its reason and does not abort the run;
  - `totalBytes` stops the run at `limits.maxDownloadBytes` with a `unavailable` drop reason for the rest;
  - concurrency is capped at `limits.downloadConcurrency`;
  - writing outside the destination is impossible (an asset named `../../evil.svg` stays inside).
- [ ] **Step 2: Run, see failures** **Step 3: Implement `downloadAssets`.** **Step 4: Run** (PASS) **Step 5: Commit** `feat(agent): download a selection into the scrap directory`

### Task G2.2: Remote source

- [ ] **Step 1: Failing tests** with a local HTTP server standing in for the hosted app: `createScanSource({ remote, token })` posts to `/api/v1/scan` with the bearer token and `view: "full"`, maps the JSON to `AgentScan` with `source: "remote"`, throws a typed error on 401, 429 and 5xx, and `fetchBytes` fetches the asset URL directly, falling back to `${remote}${asset.proxy}` when the direct fetch fails or the URL is `http:`.
- [ ] **Step 2: Run, see failures** **Step 3: Implement.** **Step 4: Run** (PASS) **Step 5: Commit** `feat(agent): add the remote scan source`

### Task G2.3: CLI

- [ ] **Step 1: Failing integration tests** driving `node dist/cli.mjs` against the fixture site: `scan --json` prints the summary JSON and exits 0; `get --out <tmp> --json` writes files and prints the download result; `get --profile all --kind svg` keeps every SVG; a bad URL exits 1 with a one-line error on stderr; `--remote` without a token exits 1 explaining what is missing; human output is readable (no JSON, absolute paths, a one-line summary of what was dropped and why).
- [ ] **Step 2: Run, see failures** **Step 3: Implement** the commands from spec section 7 with `node:util.parseArgs`, no dependency. **Step 4: Run** (PASS) **Step 5: Commit** `feat(agent): add the assets-scraper command`

### Task G2.4: PR

`pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration`, push, PR "feat: agent CLI and downloads".

---

## Phase G3: MCP server and fonts (branch `feat/agent-mcp`)

Owns `src/agent/{fonts,mcp}.ts` and their tests, `tests/integration/agent/mcp.test.ts`.

### Task G3.1: Font install, list, uninstall

- [ ] **Step 1: Failing tests** (redirect the font directory and the state file with env overrides `ASSETS_SCRAPER_FONT_DIR` and `ASSETS_SCRAPER_STATE_DIR` so tests never touch `~/Library/Fonts`):
  - a WOFF2 family (the fixture Inter) converts to TTF, lands in the font directory as `Inter-Regular.ttf`, and the manifest records family, files, licence kind and text, source host and date;
  - a family whose best file is already TTF installs without conversion (`converted: false`);
  - a commercial licence installs and is reported with its licence text (the owner's decision), an Adobe Fonts family is skipped with `reason: "adobe-fonts"`, a family with no downloadable file is skipped with a reason;
  - a file the tool did not install is never overwritten (a pre-existing `Inter-Regular.ttf` gives `skipped: exists`);
  - `listInstalledFonts` returns what was installed, `uninstallFonts(["Inter"])` deletes those files and updates the manifest, and uninstalling an unknown family reports it as missing without throwing;
  - the converted TTF parses back with fontkit and keeps the glyph count of the source.
- [ ] **Step 2: Run, see failures** **Step 3: Implement** spec section 5. **Step 4: Run** (PASS) **Step 5: Commit** `feat(agent): install page fonts and keep track of them`

### Task G3.2: MCP server

- [ ] **Step 1: Failing integration test** using the MCP SDK's in-memory client transport against the server module: `tools/list` returns the eight tools of spec section 6 with schemas; `scan_page` on the fixture returns a summary under 4 KB with a `scanId`; `list_assets` filters and paginates; `download_assets` with `dest` writes files and returns paths and drop reasons; `read_svg` returns markup starting with `<svg`; `get_palette` returns hexes; `install_fonts` with the test font directory installs the fixture font; `uninstall_fonts` removes it; an unknown `scanId` returns a tool error telling the agent to run `scan_page` again; every tool output is JSON text content, never binary.
- [ ] **Step 2: Run, see failures** **Step 3: Implement** with `@modelcontextprotocol/sdk` (add the dependency in this track and say so in the PR), stdio transport, tool schemas with zod, the one-hour scan cache, and a startup check that prints a clear message when `node_modules` or the build are missing. **Step 4: Run** (PASS) **Step 5: Commit** `feat(agent): add the MCP server`

### Task G3.3: PR

Checks, push, PR "feat: MCP server and font installation".

---

## Phase G4: Hosted API for agents (branch `feat/agent-api`)

Owns `src/app/api/v1/**`, `src/app/llms.txt/route.ts`, `src/app/api/openapi.json/route.ts`, `src/server/security/agent-auth.ts` and their tests.

### Task G4.1: Agent authentication

- [ ] **Step 1: Failing tests**: `authenticateAgent(request)` accepts a token listed in `AGENT_TOKENS` (comma separated, trimmed) with constant-time comparison, rejects an unknown or missing token with 401 and the `ApiError` shape, never logs the token, and reports which token matched only as an index. The ops token keeps working through the existing gate and is not accepted here.
- [ ] **Step 2 to 5** as usual. **Commit** `feat(api): authenticate agent tokens`

### Task G4.2: `POST /api/v1/scan`

- [ ] **Step 1: Failing integration tests** (route handler called directly, fixture site allowed): returns `summary` by default and `full` on request, with the shapes from the spec; applies the gate order of spec 7.1 minus BotID (origin check skipped for token clients, rate limit and budget still applied); maps engine failures to the v1 error codes and statuses; a scan of a private address returns 422 `blocked-address`; the response is a single JSON document, no streaming.
- [ ] **Step 2 to 5.** **Commit** `feat(api): add the agent scan endpoint`

### Task G4.3: `GET /api/v1/assets.zip`

- [ ] **Step 1: Failing integration tests**: streams a ZIP whose entries match the selection rules (same `selectAssets` as the CLI), contains `manifest.json`, respects `profile`, `kinds`, `roles`, `max`, counts bytes against the proxy budget, refuses without a token, and stops cleanly when the budget runs out (the ZIP ends with what it had plus a note in the manifest).
- [ ] **Step 2 to 5.** **Commit** `feat(api): stream a selected ZIP for agents`

### Task G4.4: `llms.txt` and OpenAPI

- [ ] **Step 1: Failing tests**: `/llms.txt` returns text mentioning the two endpoints, the bearer auth, the limits and two runnable examples; `/api/openapi.json` parses as OpenAPI 3.1 and describes both endpoints with their error codes. An e2e test asserts both are reachable and that `robots.txt` still disallows everything.
- [ ] **Step 2 to 5.** **Commit** `docs(api): describe the agent API for machines`

### Task G4.5: PR

Checks including e2e, push, PR "feat: hosted agent API".

---

## Phase G5: Claude Code plugin and docs (branch `feat/agent-plugin`)

Owns `.claude-plugin/**`, `plugins/**`, `README.md`, `docs/agents.md`.

### Task G5.1: Plugin and skill

- [ ] **Step 1:** `.claude-plugin/marketplace.json` listing one plugin, and `plugins/assets-scraper/.claude-plugin/plugin.json` declaring the MCP server (`node ${CLAUDE_PLUGIN_ROOT}/../../dist/mcp.mjs`, env passthrough for `ASSETS_SCRAPER_REMOTE` and `ASSETS_SCRAPER_TOKEN`).
- [ ] **Step 2:** `plugins/assets-scraper/skills/assets-scraper/SKILL.md`: when to use it, the workflow (scan, read the summary, download a selection, install fonts), the destination rule (`scrap/` inside the project), how to keep the context small (never list every asset, never paste bytes), and three worked examples.
- [ ] **Step 3:** A test (`tests/integration/agent/plugin.test.ts`) validating both JSON files against the documented schema fields and checking the MCP entry path exists after `pnpm build:agent`.
- [ ] **Step 4: Commit** `feat(plugin): add the Claude Code plugin and skill`

### Task G5.2: Docs

- [ ] **Step 1:** `docs/agents.md`: the three ways in (MCP, CLI, HTTP), setup for each, the selection rules, the font behavior with the licence warning, the destination rule, and the limits. README gets a short "Use it from an agent" section linking there.
- [ ] **Step 2: Commit** `docs: explain how agents use the scraper` **Step 3: PR** "feat: Claude Code plugin and agent docs".

---

## Phase G6: Integration, review, deploy

- [x] **Task G6.1:** Merge G2, G3, G4, G5 in that order, rebasing each onto main, CI green, checks green on main after every merge.
  - [ ] Wire `download_assets`: track G3 shipped the tool behind a `downloadAssets` port whose default refuses, because `src/agent/download.ts` belonged to track G2. Pass `downloadAssets` in `main()` in `src/agent/mcp.ts`, and replace the tripwire test in `src/agent/mcp.test.ts` ("says the downloader is not wired in this build") with one asserting that a server created without the option downloads through the real function. Nothing else in the repo fails if this is forgotten.
- [ ] **Task G6.2:** End to end on the fixture and on one real site: `pnpm build:agent`, then the CLI (`scan`, `get`, `fonts install` into a temp font dir), then the MCP server through the SDK client, then the hosted API locally (`pnpm build && AGENT_TOKENS=... pnpm start`), asserting the same selection in all three paths. Fix what differs.
- [ ] **Task G6.3:** Adversarial review (security: path traversal, symlinks, token handling, ZIP contents, SSRF through the remote source; correctness: selection determinism, cache invalidation, font manifest; agent ergonomics: are the summaries actually small and useful) with each finding verified before fixing.
- [ ] **Task G6.4:** Deploy: set `AGENT_TOKENS` in Vercel production, deploy, verify `/llms.txt`, `/api/openapi.json`, one `POST /api/v1/scan` and one `GET /api/v1/assets.zip` with a real token, and that a request without a token is refused. Save the agent token to `~/.config/assets-scraper/agent.env` (mode 600).
- [ ] **Task G6.5:** Install the plugin locally (`claude plugin marketplace add ~/Development/tools/assets_scraper`, `claude plugin install assets-scraper`) and confirm the MCP tools work from a fresh Claude Code session, then report the exact commands to the owner.
