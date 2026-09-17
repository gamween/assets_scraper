# Assets Scraper v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Assets Scraper v1 as specified in `docs/superpowers/specs/2026-09-16-assets-scraper-design.md`: paste a URL, get every SVG, image and font plus the brand palette, select and download.

**Architecture:** One Next.js 16 app on Vercel. `POST /api/scan` streams NDJSON events from a host-agnostic scan engine that drives a hardened headless Chromium behind a per-scan egress proxy, runs bundled in-page collectors, then post-processes in Node. `GET /api/asset` is a signed byte proxy used as a fallback. The client renders results, handles selection and builds ZIPs in the browser.

**Tech Stack:** Next.js 16.3.5, React 19.3.0, TypeScript 6.0, Tailwind CSS 4.3, shadcn 4.21 (Base UI), zod 4.6, zustand 5, playwright-core 1.63.0 + @sparticuz/chromium 153.0.0, undici 8.10, ipaddr.js 2.5, css-tree 3.2, fontkit 2.0, sharp 0.35, wawoff2 2.0, client-zip 2.5, botid 1.5, Vitest 5, Playwright Test 1.63, pnpm 10.33.

---

## 0. How this plan is executed

- **Phase 0 (sequential):** toolchain, shared contract, internal types, module stubs with final signatures, fixture site, CI. Merged to `main` before anything else.
- **Phase 1 (parallel tracks A to F):** each track works in its own git worktree on its own branch, only touches the files it owns, replaces its own stubs, and never edits `package.json`, the lockfile, `src/lib/contract.ts` or `src/server/scan/types.ts`. A track that needs a contract change or a new dependency stops and reports it instead of making the change.
- **Phase 2:** merge tracks in order A, D, E, C, B, F, wire, run everything locally, including the 23 reference sites.
- **Phase 3:** deploy to Vercel and validate in production.
- **Phase 4:** adversarial review and fix loop, final deploy.

Git protocol (every phase): branch from `main`, conventional commits (`feat(scope): ...`, `fix(scope): ...`, `test(scope): ...`, `chore: ...`, `docs: ...`), push, PR with `gh`, CI green, squash-merge, delete the branch. Never commit to `main` directly.

Worktrees for Phase 1:

```bash
cd ~/Development/tools/assets_scraper
git worktree add ../assets_scraper-wt/<track> -b feat/<track> main
cd ../assets_scraper-wt/<track> && pnpm install --frozen-lockfile
```

Reference material for implementers (local research artifacts from 2026-09-16, available during this build):

| Artifact | Path under `/private/tmp/claude-501/-Users-fianso/eb755a6c-00db-452d-b978-50bb3ba9b08c/scratchpad/research/` |
|---|---|
| Asset extraction spec and results | `reports/discovery-lab.md` |
| Lab code: in-page collector and SVG normalizer | `discovery-lab/lib/inpage.js` |
| Lab code: CDN rules, fonts, noise, pipeline | `discovery-lab/lib/cdn.mjs`, `discovery-lab/lib/fonts.mjs`, `discovery-lab/lib/noise.mjs`, `discovery-lab/lab.mjs` |
| CDN verification samples | `discovery-lab/cdn-verify.json` |
| Lab outputs per site | `discovery-lab/out-final/<host>/result.json` |
| Palette code v2 (validated) | `palette-lab/verify/src-v2/palette-inpage.ts`, `palette-post.ts`, `palette-node.ts` |
| Palette signals per site | `palette-lab/results/raw/*.signals.json` |
| Chromium on Vercel recipe | `reports/infra-spike.md`, `infra-spike/spike/lib/chromium.ts` |
| SSRF browser test, IP edge table | `critic/ssrf-browser.mjs`, `critic/ip-edge.mjs` |
| Security critique and architecture | `reports/critic.md` |
| UX spec and competitor notes | `reports/ux-survey.md` |
| Stack pins and config fixes | `reports/stack-pin.md` |

## 1. File structure

```
.github/workflows/ci.yml                     Phase 0
AGENTS.md, CLAUDE.md                          Phase 0
eslint.config.mjs, vitest.config.mts, playwright.config.ts, next.config.ts, vercel.json, pnpm-workspace.yaml, components.json, postcss.config.mjs, tsconfig.json   Phase 0
scripts/build-inpage.mjs                      Phase 0
scripts/scan-sites.mjs                        Phase 2
instrumentation-client.ts                     Phase 0 (BotID init)
src/lib/contract.ts                           Phase 0
src/lib/url.ts, src/lib/format.ts, src/lib/ndjson.ts   Phase 0
src/server/errors.ts                          Phase 0
src/server/config/limits.ts                   Phase 0
src/server/scan/types.ts                      Phase 0
src/server/net/{ip,safe-fetch,egress-proxy}.ts           Track A
src/server/security/{sign,budget,gate}.ts                Track A
src/app/api/asset/route.ts, src/app/api/health/route.ts  Track A
src/server/browser/launch.ts                             Track B
src/server/scan/{engine,preflight,navigate,capture,block,fallback}.ts   Track B
src/server/scan/inpage/run.ts                            Track B
src/app/api/scan/route.ts                                Track B
src/server/scan/inpage/collector.src.ts                  Track C
src/server/scan/post/{parse,cdn,verify,noise,variants,roles,naming,tone,format,assemble}.ts   Track C
src/server/scan/fonts/{css,binary,names,license,unicode,google,index}.ts   Track D
src/server/scan/inpage/palette.src.ts                    Track E
src/server/scan/palette/*.ts                             Track E
src/app/{layout,page}.tsx, src/app/globals.css, src/app/robots.ts   Track F
src/components/**                                        Track F
src/lib/client/{scan-client,asset-bytes,zip,clipboard,store,filters,recent}.ts   Track F
e2e/**                                                   Track F
tests/fixtures/site/**, tests/fixtures/serve.ts          Phase 0
tests/integration/**                                     Tracks A to E (own files only)
```

Unit tests live next to the code (`*.test.ts`, `*.test.tsx`). Integration tests that need Chrome live in `tests/integration/<track>/`.

---

## Phase 0: Foundation (branch `chore/foundation`)

### Task 0.1: Scaffold the app and pin the toolchain

**Files:** everything create-next-app and shadcn generate, `package.json`, `pnpm-workspace.yaml`, `eslint.config.mjs`, `src/app/globals.css`.

- [ ] **Step 1: Scaffold in a temp dir (create-next-app refuses a non-empty directory)**

```bash
cd /tmp && rm -rf as-scaffold && pnpm dlx create-next-app@16.3.5 as-scaffold \
  --ts --tailwind --eslint --app --src-dir --import-alias "@/*" \
  --use-pnpm --no-react-compiler --agents-md --disable-git --yes
cd as-scaffold && pnpm dlx shadcn@4.21.0 init -t next -b base -p nova --no-monorepo --no-rtl --yes
pnpm dlx shadcn@4.21.0 add button input dialog tooltip checkbox toast --yes
```

Expected: both commands exit 0; `src/components/ui/button.tsx` exists.

- [ ] **Step 2: Copy into the repo without overwriting README.md, .gitignore and docs**

```bash
cd ~/Development/tools/assets_scraper && git checkout -b chore/foundation
rsync -a --exclude node_modules --exclude .next --exclude README.md --exclude .gitignore /tmp/as-scaffold/ ./
```

- [ ] **Step 3: Pin versions and add every dependency the tracks need**

```bash
pnpm add next@16.3.5 react@19.3.0 react-dom@19.3.0 zod@4.6.5 zustand@5.0.15 \
  playwright-core@1.63.0 @sparticuz/chromium@153.0.0 undici@8.10.2 ipaddr.js@2.5.0 \
  css-tree@3.2.1 fontkit@2.0.4 sharp@0.35.4 wawoff2@2.0.1 client-zip@2.5.1 \
  botid@1.5.11 @upstash/redis@1.38.4 @vercel/functions@3.9.8 lucide-react@1.46.0 geist@1.7.2
pnpm add -D typescript@~6.0.3 @types/node@^22 @types/react@19.3.0 @types/react-dom@19.3.0 \
  eslint@^10.10.0 eslint-config-next@16.3.5 vitest@5.0.1 vite@8.3.0 jsdom@30.0.1 \
  @testing-library/react@16.3.3 @testing-library/dom@10.4.2 @playwright/test@1.63.0 \
  esbuild@0.28.2 @types/css-tree@3.2.0 @types/fontkit@2.0.9 babel-plugin-react-compiler@1.0.0
```

Pin `@sparticuz/chromium` and `playwright-core` exactly (no caret) in `package.json`.

- [ ] **Step 4: Scripts in `package.json`**

```json
{
  "scripts": {
    "build:inpage": "node scripts/build-inpage.mjs",
    "dev": "pnpm build:inpage && next dev",
    "build": "pnpm build:inpage && next build",
    "start": "next start",
    "lint": "eslint",
    "typecheck": "pnpm build:inpage && next typegen && tsc --noEmit",
    "test": "pnpm build:inpage && vitest run --project unit --project dom",
    "test:integration": "pnpm build:inpage && vitest run --project integration",
    "test:e2e": "playwright test"
  }
}
```

Do not add an `engines` field.

- [ ] **Step 5: `pnpm-workspace.yaml`**

```yaml
allowBuilds:
  sharp: false
  unrs-resolver: false
  esbuild: true
peerDependencyRules:
  allowedVersions:
    eslint: "10"
```

- [ ] **Step 6: `eslint.config.mjs` (ESLint 10 workaround)**

```js
import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  { settings: { react: { version: "19.3" } } },
  {
    files: ["src/components/**/*.tsx"],
    rules: { "@next/next/no-img-element": "off" },
  },
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts", "playwright-report/**", "test-results/**", "src/server/scan/inpage/generated/**"]),
]);
```

- [ ] **Step 7: Geist fix in `src/app/globals.css`**

Inside `@theme inline`, replace the self-referencing font lines with:

```css
--font-sans: var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif;
--font-mono: var(--font-geist-mono), ui-monospace, SFMono-Regular, Menlo, monospace;
--font-heading: var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif;
```

Remove every `.dark` block (light theme only). Keep `@custom-variant dark (&:is(.dark *));` after the imports: without it Tailwind v4 applies `dark:` utilities under `prefers-color-scheme: dark`, and no `.dark` class is ever set, so the line keeps them inert.

- [ ] **Step 8: Verify and commit**

```bash
pnpm lint && pnpm exec next typegen && pnpm exec tsc --noEmit && pnpm exec next build
```

Expected: all pass (the inpage build script does not exist yet, so call `next build` directly here; `next typegen` must run before `tsc` so `LayoutProps` exists).

```bash
git add -A && git commit -m "chore: scaffold Next.js 16 app with pinned toolchain"
```

### Task 0.2: Test runners and configs

**Files:** Create `vitest.config.mts`, `playwright.config.ts`, `vercel.json`. Modify `next.config.ts`, `tsconfig.json`.

- [ ] **Step 1: `vitest.config.mts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    projects: [
      { extends: true, test: { name: "unit", environment: "node", include: ["src/**/*.test.ts"] } },
      { extends: true, test: { name: "dom", environment: "jsdom", include: ["src/**/*.test.tsx"] } },
      {
        extends: true,
        test: {
          name: "integration",
          environment: "node",
          include: ["tests/integration/**/*.test.ts"],
          testTimeout: 180_000,
          hookTimeout: 60_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
```

- [ ] **Step 2: `playwright.config.ts`**

```ts
import { defineConfig, devices } from "@playwright/test";

const PORT = 3107;

export default defineConfig({
  testDir: "./e2e",
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  use: { baseURL: `http://localhost:${PORT}`, trace: "on-first-retry" },
  projects: [{ name: "chrome", use: { ...devices["Desktop Chrome"], channel: "chrome", viewport: { width: 1470, height: 956 } } }],
  webServer: {
    command: `pnpm build && pnpm start -p ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
  },
});
```

- [ ] **Step 3: `next.config.ts`**

```ts
import { createRequire } from "node:module";
import path from "node:path";
import type { NextConfig } from "next";
import { withBotId } from "botid/next/config";

const require = createRequire(import.meta.url);

/** Real (symlink-resolved) package directory, so pnpm does not get traced twice. */
function pkgDir(entry: string, up = 1): string {
  const resolved = require.resolve(entry);
  return path
    .relative(process.cwd(), path.resolve(path.dirname(resolved), ...Array(up).fill("..")))
    .split(path.sep)
    .join("/");
}

const chromiumFiles = [`./${pkgDir("@sparticuz/chromium")}/bin/**`, `./${pkgDir("playwright-core", 0)}/browsers.json`];

const CSP = [
  "default-src 'self'",
  "img-src 'self' blob: data: https:",
  "font-src 'self' blob: data:",
  "connect-src 'self' https:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join("; ");

const nextConfig: NextConfig = {
  typedRoutes: true,
  reactCompiler: true,
  serverExternalPackages: ["@sparticuz/chromium", "playwright-core", "sharp", "fontkit", "wawoff2"],
  outputFileTracingIncludes: { "/api/scan": chromiumFiles },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: CSP },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
};

export default withBotId(nextConfig);
```

- [ ] **Step 4: `vercel.json`**

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "framework": "nextjs",
  "fluid": true,
  "regions": ["iad1"],
  "functions": {
    "src/app/api/scan/route.ts": { "maxDuration": 120, "supportsCancellation": true },
    "src/app/api/asset/route.ts": { "maxDuration": 30, "supportsCancellation": true }
  }
}
```

- [ ] **Step 5: `instrumentation-client.ts` (BotID)**

```ts
import { initBotId } from "botid/client/core";

initBotId({ protect: [{ path: "/api/scan", method: "POST" }] });
```

If `botid` 1.5.11 exposes a different import path, use the one from its README and keep the same protected route.

- [ ] **Step 6: Commit**

```bash
pnpm exec next typegen && pnpm exec tsc --noEmit && git add -A && git commit -m "chore: add test runners, security headers, BotID and Vercel config"
```

### Task 0.3: Shared contract

**Files:** Create `src/lib/contract.ts`, `src/lib/contract.test.ts`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { ApiError, Asset, ScanEvent, ScanRequest } from "./contract";

const asset = {
  id: "a1", kind: "svg", role: "site-logo", name: "Fixture logo", filename: "fixture-logo.svg", format: "svg",
  foundIn: ["inline-svg"], visible: true, declaredOnly: false, order: 0, score: 1140, usedCount: 1,
  tone: "dark", display: null, original: null, inline: { mime: "image/svg+xml", text: "<svg/>" },
};

describe("contract", () => {
  it("accepts a valid asset", () => {
    expect(Asset.parse(asset).name).toBe("Fixture logo");
  });

  it("rejects an unknown role", () => {
    expect(() => Asset.parse({ ...asset, role: "banner" })).toThrow();
  });

  it("discriminates scan events by type", () => {
    const event = ScanEvent.parse({ type: "step", step: "load", state: "start" });
    expect(event.type).toBe("step");
    expect(() => ScanEvent.parse({ type: "step", step: "nope", state: "start" })).toThrow();
  });

  it("validates requests and API errors", () => {
    expect(ScanRequest.parse({ url: "linear.app" }).url).toBe("linear.app");
    expect(() => ScanRequest.parse({ url: "" })).toThrow();
    expect(ApiError.parse({ error: { code: "budget", message: "x" } }).error.code).toBe("budget");
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm exec vitest run src/lib/contract.test.ts`
Expected: FAIL, cannot resolve `./contract`.

- [ ] **Step 3: Implement `src/lib/contract.ts`**

```ts
import * as z from "zod";

export const StepId = z.enum(["queue", "open", "load", "scroll", "collect", "process"]);
export type StepId = z.infer<typeof StepId>;

export const ErrorCode = z.enum([
  "invalid-url", "blocked-address", "unsupported-port", "own-host",
  "rate-limited", "budget", "disabled", "access-code", "bot",
  "busy", "dns", "connect", "http", "blocked", "not-html", "timeout", "internal",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const WarningCode = z.enum(["partial", "truncated", "body-timeout", "verify-skipped", "collector-fallback"]);
export type WarningCode = z.infer<typeof WarningCode>;

export const AssetKind = z.enum(["svg", "image"]);
export type AssetKind = z.infer<typeof AssetKind>;

export const AssetRole = z.enum(["site-logo", "logo", "favicon", "social", "icon", "illustration", "image", "sprite-symbol"]);
export type AssetRole = z.infer<typeof AssetRole>;

export const Tone = z.enum(["light", "dark", "mixed", "opaque", "unknown"]);
export type Tone = z.infer<typeof Tone>;

export const AssetFormat = z.enum(["svg", "png", "jpg", "webp", "avif", "gif", "ico", "bmp", "other"]);
export type AssetFormat = z.infer<typeof AssetFormat>;

export const FoundIn = z.enum([
  "img", "picture", "lazy-attribute", "noscript", "video-poster", "svg-image", "object-embed",
  "css-background", "css-mask", "css-pseudo", "css-other", "stylesheet",
  "icon-link", "meta-icon", "manifest", "og-image", "twitter-image", "json-ld",
  "inline-svg", "sprite-symbol", "network", "shadow-dom", "iframe", "public-source",
]);
export type FoundIn = z.infer<typeof FoundIn>;

export const AssetSource = z.object({
  url: z.string(),
  proxy: z.string(),
  format: AssetFormat,
  width: z.number().optional(),
  height: z.number().optional(),
  bytes: z.number().optional(),
});
export type AssetSource = z.infer<typeof AssetSource>;

export const InlineSvg = z.object({ mime: z.literal("image/svg+xml"), text: z.string() });
export const InlineBytes = z.object({ mime: z.string(), base64: z.string() });

export const Asset = z.object({
  id: z.string(),
  kind: AssetKind,
  role: AssetRole,
  name: z.string(),
  filename: z.string(),
  format: AssetFormat,
  foundIn: z.array(FoundIn),
  visible: z.boolean(),
  declaredOnly: z.boolean(),
  order: z.number(),
  score: z.number(),
  usedCount: z.number().int().min(1),
  width: z.number().optional(),
  height: z.number().optional(),
  renderedWidth: z.number().optional(),
  renderedHeight: z.number().optional(),
  bytes: z.number().optional(),
  tone: Tone,
  display: AssetSource.nullable(),
  original: AssetSource.nullable(),
  aspectChanged: z.boolean().optional(),
  inline: z.union([InlineSvg, InlineBytes]).optional(),
  hasLiveText: z.boolean().optional(),
});
export type Asset = z.infer<typeof Asset>;

export const FontFile = z.object({
  url: z.string(),
  proxy: z.string(),
  format: z.enum(["woff2", "woff", "ttf", "otf", "eot", "other"]),
  bytes: z.number().optional(),
  unicodeRange: z.string().optional(),
  coversLatin: z.boolean(),
});
export type FontFile = z.infer<typeof FontFile>;

export const FontFaceInfo = z.object({
  weight: z.string(),
  style: z.string(),
  stretch: z.string().optional(),
  loaded: z.boolean(),
  subfamily: z.string().optional(),
  files: z.array(FontFile),
});
export type FontFaceInfo = z.infer<typeof FontFaceInfo>;

export const FontLicense = z.object({
  kind: z.enum(["open", "commercial", "unknown"]),
  text: z.string().optional(),
  url: z.string().optional(),
});
export type FontLicense = z.infer<typeof FontLicense>;

export const FontFamily = z.object({
  id: z.string(),
  name: z.string(),
  cssFamilies: z.array(z.string()),
  source: z.enum(["google-fonts", "adobe-fonts", "self-hosted", "third-party", "data-uri"]),
  sourceHost: z.string().optional(),
  license: FontLicense,
  convertible: z.boolean(),
  downloadable: z.boolean(),
  googleFamily: z.string().optional(),
  usedOnPage: z.boolean(),
  usage: z.number().min(0).max(1),
  axes: z.array(z.object({ tag: z.string(), min: z.number(), max: z.number(), default: z.number() })).optional(),
  faces: z.array(FontFaceInfo),
});
export type FontFamily = z.infer<typeof FontFamily>;

export const Swatch = z.object({
  hex: z.string().regex(/^#[0-9a-f]{6}$/),
  role: z.enum(["primary", "accent", "background", "surface", "text"]).optional(),
});
export type Swatch = z.infer<typeof Swatch>;

export const Palette = z.object({ brand: z.array(Swatch), neutrals: z.array(Swatch) });
export type Palette = z.infer<typeof Palette>;

export const PageInfo = z.object({
  requestedUrl: z.string(),
  finalUrl: z.string(),
  host: z.string(),
  title: z.string(),
  siteName: z.string().optional(),
  favicon: AssetSource.optional(),
  status: z.number(),
  brandLinks: z.array(z.object({ href: z.string(), text: z.string() })),
});
export type PageInfo = z.infer<typeof PageInfo>;

export const ScanStats = z.object({
  assets: z.number(),
  svg: z.number(),
  images: z.number(),
  fonts: z.number(),
  hidden: z.record(z.string(), z.number()),
  durationMs: z.number(),
});
export type ScanStats = z.infer<typeof ScanStats>;

export const Diagnostics = z.object({
  scanId: z.string(),
  cold: z.boolean(),
  phases: z.record(z.string(), z.number()),
  queueMs: z.number(),
  tmpFreeMb: z.number().optional(),
  memAvailableMb: z.number().optional(),
  egress: z.object({ bytes: z.number(), blocked: z.number() }),
  bodyTimeouts: z.number(),
  blockReason: z.string().optional(),
  collector: z.enum(["isolated", "main", "none"]),
  version: z.string(),
});
export type Diagnostics = z.infer<typeof Diagnostics>;

export const ScanEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("accepted"), scanId: z.string(), url: z.string() }),
  z.object({ type: z.literal("step"), step: StepId, state: z.enum(["start", "done"]) }),
  z.object({ type: z.literal("page"), page: PageInfo }),
  z.object({ type: z.literal("palette"), palette: Palette.nullable() }),
  z.object({ type: z.literal("assets"), items: z.array(Asset) }),
  z.object({ type: z.literal("fonts"), families: z.array(FontFamily) }),
  z.object({ type: z.literal("warning"), code: WarningCode, detail: z.string().optional() }),
  z.object({ type: z.literal("done"), partial: z.boolean(), stats: ScanStats, diagnostics: Diagnostics }),
  z.object({
    type: z.literal("error"),
    code: ErrorCode,
    message: z.string(),
    httpStatus: z.number().optional(),
    fallback: z.array(Asset).optional(),
    diagnostics: Diagnostics.optional(),
  }),
]);
export type ScanEvent = z.infer<typeof ScanEvent>;

export const ScanRequest = z.object({ url: z.string().min(1).max(2048) });
export type ScanRequest = z.infer<typeof ScanRequest>;

export const ApiError = z.object({ error: z.object({ code: ErrorCode, message: z.string() }) });
export type ApiError = z.infer<typeof ApiError>;
```

Note: the spec calls the face shape `FontFace`; the code uses `FontFaceInfo` so it never shadows the DOM `FontFace` class.

- [ ] **Step 4: Run the test**

Run: `pnpm exec vitest run src/lib/contract.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/contract.ts src/lib/contract.test.ts && git commit -m "feat(contract): add shared zod contract for scan events and assets"
```

### Task 0.4: URL normalization, formatting, NDJSON

**Files:** Create `src/lib/url.ts`, `src/lib/url.test.ts`, `src/lib/format.ts`, `src/lib/format.test.ts`, `src/lib/ndjson.ts`, `src/lib/ndjson.test.ts`.

- [ ] **Step 1: Failing tests**

`src/lib/url.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { normalizeInputUrl } from "./url";

describe("normalizeInputUrl", () => {
  it.each([
    ["linear.app", "https://linear.app/"],
    ["  <https://Linear.app/features>  ", "https://linear.app/features"],
    ['"stripe.com"', "https://stripe.com/"],
    ["https://x.com:443/a", "https://x.com/a"],
    ["http://x.com:80/", "http://x.com/"],
    ["https://user:pw@x.com/", "https://x.com/"],
    ["https://x.com/#/route", "https://x.com/#/route"],
    ["https://x.com/#!/route", "https://x.com/#!/route"],
    ["https://x.com/page#section", "https://x.com/page"],
    ["例え.jp", "https://xn--r8jz45g.jp/"],
    ["linear.app.", "https://linear.app./"],
    ["https://x.com/a).", "https://x.com/a"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeInputUrl(input)).toEqual({ ok: true, url: expected, host: new URL(expected).hostname });
  });

  it.each(["", "   ", "ftp://x.com", "javascript:alert(1)", "not a url", "x", "mailto:a@b.c"])("rejects %j", (input) => {
    expect(normalizeInputUrl(input)).toEqual({ ok: false, code: "invalid-url" });
  });

  it("rejects non-default ports", () => {
    expect(normalizeInputUrl("http://x.com:8080")).toEqual({ ok: false, code: "unsupported-port" });
    expect(normalizeInputUrl("localhost:3000")).toEqual({ ok: false, code: "unsupported-port" });
  });
});
```

`src/lib/format.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { formatBytes, formatDimensions, formatDuration } from "./format";

describe("format", () => {
  it.each([
    [0, "0 B"], [512, "512 B"], [3072, "3.0 KB"], [360_000, "352 KB"], [2_516_582, "2.4 MB"], [1_048_000, "1.0 MB"],
  ])("formatBytes(%d) = %s", (n, s) => expect(formatBytes(n)).toBe(s));

  it("formats dimensions and durations", () => {
    expect(formatDimensions(1200, 630)).toBe("1200×630");
    expect(formatDimensions(undefined, 630)).toBe("");
    expect(formatDuration(11_400)).toBe("11s");
    expect(formatDuration(75_000)).toBe("1m 15s");
  });
});
```

`src/lib/ndjson.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { chunkByBytes, decodeNdjson, encodeEvent } from "./ndjson";

function streamOf(parts: string[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(new TextEncoder().encode(part));
      controller.close();
    },
  });
}

describe("ndjson", () => {
  it("encodes one event per line", () => {
    expect(encodeEvent({ type: "step", step: "open", state: "start" })).toBe('{"type":"step","step":"open","state":"start"}\n');
  });

  it("decodes lines split across chunks and a trailing line without newline", async () => {
    const out: unknown[] = [];
    for await (const value of decodeNdjson(streamOf(['{"a":', '1}\n{"b"', ':2}\n\n{"c":3}']))) out.push(value);
    expect(out).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  it("chunks items by serialized size", () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ i, pad: "x".repeat(100) }));
    const chunks = chunkByBytes(items, 350);
    expect(chunks.flat()).toEqual(items);
    expect(chunks.every((c) => c.length <= 3)).toBe(true);
  });
});
```

- [ ] **Step 2: Run and see failures**

Run: `pnpm exec vitest run src/lib`
Expected: FAIL, modules missing.

- [ ] **Step 3: Implement**

`src/lib/url.ts`:

```ts
export type UrlInputResult =
  | { ok: true; url: string; host: string }
  | { ok: false; code: "invalid-url" | "unsupported-port" };

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const HOST_PORT = /^[^:/?#]+:\d+/;

export function normalizeInputUrl(raw: string): UrlInputResult {
  let s = raw.trim().replace(/^["'<\s]+/, "").replace(/["'>\s]+$/, "");
  // A trailing dot is punctuation only when the URL has a path ("x.com/a."), not for a bare FQDN ("linear.app.").
  const hasPath = /^(?:[a-z][a-z0-9+.-]*:\/\/)?[^/]+\/./i.test(s);
  const trimTrailing = (value: string) => value.replace(hasPath ? /[.,;]+$/ : /[,;]+$/, "");
  s = trimTrailing(s);
  const opens = (s.match(/\(/g) ?? []).length;
  const closes = (s.match(/\)/g) ?? []).length;
  if (s.endsWith(")") && closes > opens) s = trimTrailing(s.slice(0, -1));
  if (!s || /\s/.test(s)) return { ok: false, code: "invalid-url" };
  if (!SCHEME.test(s) || HOST_PORT.test(s)) s = `https://${s}`;

  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, code: "invalid-url" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, code: "invalid-url" };
  const host = u.hostname;
  if (!host || (!host.includes(".") && !host.startsWith("[") && host !== "localhost")) return { ok: false, code: "invalid-url" };
  if (u.port && u.port !== "80" && u.port !== "443") return { ok: false, code: "unsupported-port" };
  u.username = "";
  u.password = "";
  if (!u.hash.startsWith("#/") && !u.hash.startsWith("#!/")) u.hash = "";
  return { ok: true, url: u.toString(), host };
}
```

`src/lib/format.ts`:

```ts
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 10) return `${kb.toFixed(1)} KB`;
  if (kb < 999.5) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

export function formatDimensions(width?: number, height?: number): string {
  return width && height ? `${Math.round(width)}×${Math.round(height)}` : "";
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}
```

`src/lib/ndjson.ts`:

```ts
import type { ScanEvent } from "./contract";

export const encodeEvent = (event: ScanEvent): string => `${JSON.stringify(event)}\n`;

export function chunkByBytes<T>(items: T[], maxBytes: number): T[][] {
  const encoder = new TextEncoder();
  const chunks: T[][] = [];
  let current: T[] = [];
  let size = 0;
  for (const item of items) {
    const itemSize = encoder.encode(JSON.stringify(item)).length + 1;
    if (current.length && size + itemSize > maxBytes) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(item);
    size += itemSize;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

export async function* decodeNdjson(stream: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) yield JSON.parse(line);
        index = buffer.indexOf("\n");
      }
    }
    const tail = buffer.trim();
    if (tail) yield JSON.parse(tail);
  } finally {
    reader.releaseLock();
  }
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm exec vitest run src/lib`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib && git commit -m "feat(lib): add URL normalization, formatting and NDJSON codec"
```

### Task 0.5: Server errors, limits, internal types and module stubs

**Files:** Create `src/server/errors.ts`, `src/server/config/limits.ts`, `src/server/scan/types.ts`, and one stub file per module listed in section 1 (Tracks A to E), `src/server/scan/inpage/collector.src.ts`, `src/server/scan/inpage/palette.src.ts`, `scripts/build-inpage.mjs`.

- [ ] **Step 1: `src/server/errors.ts`**

```ts
import type { Asset, ErrorCode } from "@/lib/contract";

export class ScanFailure extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly options: { httpStatus?: number; fallback?: Asset[] } = {},
  ) {
    super(message);
    this.name = "ScanFailure";
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message = code,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`Not implemented: ${what}`);
    this.name = "NotImplementedError";
  }
}
```

- [ ] **Step 2: `src/server/config/limits.ts`**

```ts
const MB = 1024 * 1024;

const envNumber = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

export const limits = {
  scanDeadlineMs: 90_000,
  maxConcurrentScans: 1,
  queueWaitMs: 15_000,
  preflightMs: 8_000,
  preflightMaxBytes: 1 * MB,
  launchMs: 20_000,
  gotoMs: 25_000,
  loadMs: 10_000,
  networkIdleMs: 3_000,
  scrollMs: 8_000,
  scrollStepMs: 180,
  scrollIdleMs: 2_500,
  animationsMs: 2_000,
  collectMs: 15_000,
  settleMs: 5_000,
  gracefulCloseMs: 5_000, // graceful browser close before the kill
  killedCloseMs: 2_000, // wait for browser.close() after a kill
  readMs: 3_000, // small in-page reads after navigation
  backToTopMs: 1_000,
  paletteBudgetMs: 3_000, // the palette phase's share of collectMs
  paletteOverrunMs: 1_000, // the engine aborts extractPalette at paletteBudgetMs plus this
  paletteStopMs: 1_000, // after that abort, time for extractPalette to put the page back
  postGraceMs: 5_000, // page work stops this long before the scan deadline
  cancelCleanupMs: 10_000,
  egressCloseMs: 1_000,
  verifyMs: 8_000,
  verifyConcurrency: 16,
  maxDeclaredProbes: 150,
  maxStylesheetUrls: 2_000, // stylesheet text URLs the network did not load that get a record
  egressMaxBytes: 400 * MB,
  egressMaxSockets: 96,
  bodyMaxBytes: 15 * MB,
  bodyReadMs: 8_000,
  bodyConcurrency: 24,
  bodyTotalBytes: 250 * MB,
  blobMaxBytes: 2 * MB,
  blobTotalBytes: 16 * MB,
  svgMaxBytes: 1 * MB,
  svgTotalBytes: 12 * MB,
  svgMaxNormalizations: 400,
  collectorMaxElements: 80_000,
  spriteFetchMs: 4_000,
  blobFetchMs: 3_000,
  collectorMaxTextNodes: 20_000,
  manifestMs: 3_000,
  manifestMaxBytes: 512_000,
  maxBrandLinks: 6,
  collectorMaxOutputChars: 32_000_000, // JSON characters of the collector output, lists cut to fit
  fontParseMaxBytes: 5 * MB,
  fontParseBudgetMs: 1_500,
  fontParseMaxFiles: 40,
  maxAssets: 1_500,
  maxSignedUrls: 2_000,
  ndjsonLineBytes: 256_000,
  proxyMaxBytes: 25 * MB,
  proxyTimeoutMs: 20_000,
  proxyMaxRedirects: 5,
  toneMaxRasters: 300,
  toneMaxSvgs: 400,
  toneBudgetMs: 3_000,
  toneMaxBytes: 3 * MB,
  minTmpFreeMb: 250,
  minMemAvailableMb: 900,
  watchdogMemMb: 350,
  googleFontsMs: 2_000,
  googleFontsMaxFamilies: 8,
  paletteFetchMs: 600,
  wikidataMs: 3_000,
  faviconServiceMs: 3_000,
  get scansPerDay() {
    return envNumber("SCANS_PER_DAY", 80);
  },
  get scansPerMonth() {
    return envNumber("SCANS_PER_MONTH", 800);
  },
  get proxyBytesPerDay() {
    return envNumber("PROXY_BYTES_PER_DAY", 300 * MB);
  },
} as const;
```

As built, every key (not only the three budgets above) is read on each access and can be overridden with an environment variable named after it in SCREAMING_SNAKE_CASE (`postGraceMs` reads `POST_GRACE_MS`, `paletteBudgetMs` reads `PALETTE_BUDGET_MS`); values that are not whole numbers above 0 are ignored.

- [ ] **Step 3: `src/server/scan/types.ts`**

```ts
import type { Asset, FoundIn, FontFamily, ScanEvent, Tone, WarningCode } from "@/lib/contract";

export interface ScanBackend {
  scan(input: { url: string }, options: { signal: AbortSignal }): AsyncIterable<ScanEvent>;
}

export interface Rect { x: number; y: number; width: number; height: number }

export interface CandidateContext {
  header: boolean;
  nav: boolean;
  footer: boolean;
  homeLink: boolean;
  logoWord: boolean;
  siteWord: boolean;
  logoWall: boolean;
  shadowRoot: boolean;
  iframe: boolean;
}

export interface RawCandidate {
  url: string;                              // absolute http(s), data: or blob: URL
  group: number;                            // element group (src, srcset, picture, image-set)
  foundIn: FoundIn;
  descriptor?: { w?: number; x?: number };
  media?: string;                           // art-directed <source media>
  type?: string;                            // <source type>, <link type>
  sizes?: string;                           // <link sizes>
  order: number;
  visible: boolean;
  rect?: Rect;
  naturalWidth?: number;
  naturalHeight?: number;
  label?: string;                           // aria-label, title, alt, data-framer-name
  linkText?: string;
  context: CandidateContext;
  declaredOnly: boolean;
}

export interface RawSvg {
  markup: string;
  hash: string;
  source: "inline" | "sprite-symbol";
  referenced: boolean;
  order: number;
  visible: boolean;
  rect?: Rect;
  label?: string;
  linkText?: string;
  context: CandidateContext;
  usedCount: number;
  hasLiveText: boolean;
  elementCount: number;
}

export interface RawFontFaceRule {
  family: string;
  src: { url?: string; local?: string; format?: string }[];
  weight: string;
  style: string;
  stretch?: string;
  unicodeRange?: string;
  baseUrl: string;
  origin: "cssom" | "network";
}

export interface RawFontStatus {
  family: string;
  weight: string;
  style: string;
  stretch: string;
  status: "loaded" | "unloaded" | "loading" | "error";
}

export interface RawFontUsage { stack: string; weight: string; style: string; chars: number }

export interface CollectorOptions {
  host: string;
  siteName: string;
  timeBudgetMs: number;
  maxElements: number;
  maxSvgNormalizations: number;
  maxSvgBytes: number;
  maxSvgTotalBytes: number;
  spriteFetchMs: number;                    // external sprite fetch (spec 8.6)
  blobFetchMs: number;                      // limits.blobFetchMs
  maxTextNodes: number;                     // limits.collectorMaxTextNodes
  maxBrandLinks: number;                    // spec 8.1
  maxBlobBytes: number;                     // limits.blobMaxBytes
  maxBlobTotalBytes: number;                // limits.blobTotalBytes
  maxOutputChars: number;                   // JSON characters of the whole output; lists are cut to fit (limits.collectorMaxOutputChars)
  maxTitleChars: number;                    // page.title is cut to one character over this before fitting
  maxSiteNameChars: number;                 // same for page.siteName
}

export interface RawCollectorOutput {
  page: { title: string; siteName?: string; baseUrl: string; elementCount: number };
  candidates: RawCandidate[];
  svgs: RawSvg[];
  manifestUrl?: string;
  fontFaces: RawFontFaceRule[];
  fontStatuses: RawFontStatus[];
  fontUsage: RawFontUsage[];
  unreadableSheets: string[];
  blobs: { url: string; mime: string; base64: string }[];
  brandLinks: { href: string; text: string }[];
  noise: Record<string, number>;
  stats: { elements: number; ms: number; truncated: boolean };
}

export interface FontBinaryMeta {
  format: "woff2" | "woff" | "ttf" | "otf" | "eot" | "other";
  familyName?: string;
  subfamilyName?: string;
  fullName?: string;
  postscriptName?: string;
  typoFamily?: string;
  wwsFamily?: string;
  nameId1?: string;
  copyright?: string;
  licenseDescription?: string;
  licenseUrl?: string;
  axes?: { tag: string; min: number; max: number; default: number }[];
  weightClass?: number;
  coversLatin?: boolean;
}

export interface CapturedImage {
  url: string;
  status: number;
  contentType: string;
  server?: string;
  bytes?: number;
  sha1?: string;
  width?: number;
  height?: number;
  tone: Tone;
  svgText?: string;
  blobBase64?: string;
}

export interface CapturedFont {
  url: string;
  status: number;
  contentType: string;
  bytes?: number;
  sha1?: string;
  meta: FontBinaryMeta | null;
}

export interface CapturedSheet { url: string; status: number; cssText: string }

export interface CapturedNetwork {
  images: CapturedImage[];
  fonts: CapturedFont[];
  sheets: CapturedSheet[];
  bodyTimeouts: number;
  skippedBodies: number;
}

export interface PageContext {
  requestedUrl: string;
  finalUrl: string;
  host: string;
  siteName: string;
  title: string;
}

export interface Signer {
  sign(url: string): string;
  readonly count: number;
}

export interface SafeFetchOptions {
  method?: "GET" | "HEAD";
  headers?: Record<string, string>;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  signal?: AbortSignal;
}

export interface SafeResponse {
  url: string;
  status: number;
  headers: Headers;
  redirected: boolean;
  stream(): ReadableStream<Uint8Array>;
  buffer(): Promise<Buffer>;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
  cancel(): Promise<void>;
}

export type SafeFetch = (url: string, options?: SafeFetchOptions) => Promise<SafeResponse>;

export interface PostInput {
  collector: RawCollectorOutput;
  network: CapturedNetwork;
  page: PageContext;
  signer: Signer;
  fetch: SafeFetch;
  signal: AbortSignal;
  deadline: number;                 // epoch ms
}

export interface AssetsOutput { assets: Asset[]; hidden: Record<string, number>; warnings: WarningCode[] } // hidden already includes collector.noise (D1)
export interface FontsOutput { families: FontFamily[]; hidden: Record<string, number> }
```

- [ ] **Step 4: Stubs with final signatures**

Every stub body is `throw new NotImplementedError("<track>: <name>")`. Exact exports:

```ts
// src/server/net/ip.ts (Track A)
export class SsrfError extends Error {
  constructor(readonly reason: "private-ip" | "private-dns" | "own-host" | "dns-failure" | "invalid-host", readonly host: string) {
    super(`${reason}: ${host}`);
    this.name = "SsrfError";
  }
}
export function isPublicIp(ip: string): boolean;
export function isOwnHost(host: string): boolean;
export function isTestAllowed(host: string, port: number): boolean;
export async function resolvePublicHost(host: string, port: number): Promise<string>;

// src/server/net/safe-fetch.ts (Track A)
export type SafeFetchErrorCode = "invalid-url" | "blocked-address" | "own-host" | "unsupported-port" | "dns" | "connect" | "timeout" | "too-large" | "too-many-redirects" | "aborted";
export class SafeFetchError extends Error {
  constructor(readonly code: SafeFetchErrorCode, message: string) { super(message); this.name = "SafeFetchError"; }
}
export const safeFetch: SafeFetch;

// src/server/net/egress-proxy.ts (Track A)
export interface EgressProxy { port: number; stats(): { bytes: number; blocked: number; blockedHosts: string[] }; close(): Promise<void> }
export async function startEgressProxy(options?: { maxBytes?: number; maxSockets?: number }): Promise<EgressProxy>;

// src/server/security/sign.ts (Track A)
export class SignLimitError extends Error {}
export function createSigner(options?: { secret?: string; now?: number; max?: number }): Signer;
export function verifyAssetParams(params: URLSearchParams, now?: number, secret?: string): { url: string; dl?: string; fmt?: "ttf" };

// src/server/security/budget.ts (Track A)
export interface BudgetStore { incr(key: string, by: number, ttlSeconds: number): Promise<number> }
export function getBudgetStore(): BudgetStore;
export function setBudgetStoreForTests(store: BudgetStore | null): void;
export async function takeScanBudget(now?: Date): Promise<boolean>;
export async function takeProxyBytes(bytes: number, now?: Date): Promise<boolean>;

// src/server/security/gate.ts (Track A)
export type GateResult = { ok: true; url: string; host: string; ops: boolean } | { ok: false; response: Response };
export async function gateScanRequest(request: Request): Promise<GateResult>;

// src/server/browser/launch.ts (Track B)
export class BusyError extends Error {}
export interface BrowserSession {
  browser: import("playwright-core").Browser;
  context: import("playwright-core").BrowserContext;
  page: import("playwright-core").Page;
  cold: boolean;
  queueMs: number;
  launchMs: number;
  health: { tmpFreeMb?: number; memAvailableMb?: number };
}
export async function withBrowser<T>(options: { egressPort: number; signal: AbortSignal; onQueued?: () => void }, fn: (session: BrowserSession) => Promise<T>): Promise<T>;

// src/server/scan/inpage/run.ts (Track B)
export async function runInPage<T>(page: import("playwright-core").Page, source: string, expression: string, options: { timeoutMs: number }): Promise<{ value: T; world: "isolated" | "main" }>;

// src/server/scan/capture.ts (Track B)
export interface CaptureHandle { settle(timeoutMs: number): Promise<CapturedNetwork> }
export function startCapture(page: import("playwright-core").Page, options: { signal: AbortSignal }): CaptureHandle;

// src/server/scan/navigate.ts (Track B)
export interface NavigationResult { status: number; finalUrl: string; title: string; headers: Record<string, string>; elementCount: number; htmlSample: string }
export async function openPage(page: import("playwright-core").Page, url: string, options: { signal: AbortSignal }): Promise<NavigationResult>;
export async function loadAndScroll(page: import("playwright-core").Page, options: { signal: AbortSignal; onStep: (step: "load" | "scroll", state: "start" | "done") => void }): Promise<void>;
export async function prepareForCollection(page: import("playwright-core").Page): Promise<void>;

// src/server/scan/block.ts (Track B)
export interface BlockInput { status: number; title: string; html: string; headers: Record<string, string>; elementCount: number }
export function detectBlock(input: BlockInput): string | null;

// src/server/scan/preflight.ts (Track B)
export interface PageHead { title?: string; siteName?: string; icons: { href: string; rel: string; sizes?: string; type?: string }[]; ogImages: string[]; jsonLdLogos: string[]; manifestUrl?: string }
export interface PreflightResult { finalUrl: string; status: number; contentType: string; headers: Record<string, string>; head: PageHead | null }
export function parseHead(html: string, baseUrl: string): PageHead;
export async function preflight(url: string, options: { fetch: SafeFetch; signal: AbortSignal }): Promise<PreflightResult>;

// src/server/scan/fallback.ts (Track B)
export async function buildFallback(input: { host: string; pageUrl: string; head: PageHead | null; fetch: SafeFetch; signer: Signer; signal: AbortSignal }): Promise<Asset[]>;

// src/server/scan/engine.ts (Track B)
export const scanEngine: ScanBackend;

// src/server/scan/post/tone.ts (Track C)
export async function toneFromBytes(buffer: Buffer, contentType: string): Promise<Tone>;
export async function toneFromSvg(markup: string): Promise<Tone>;

// src/server/scan/post/assemble.ts (Track C)
export async function assembleAssets(input: PostInput): Promise<AssetsOutput>;

// src/server/scan/fonts/index.ts (Track D)
export function parseFontBinary(buffer: Buffer): FontBinaryMeta | null;
export function parseFontFaceCss(cssText: string, baseUrl: string): RawFontFaceRule[];
export async function isConvertibleFont(meta: FontBinaryMeta | null, options: { fetch: SafeFetch; signal: AbortSignal }): Promise<boolean>;
export async function buildFontFamilies(input: PostInput): Promise<FontsOutput>;

// src/server/scan/palette/index.ts (Track E)
export async function extractPalette(page: import("playwright-core").Page, options: { fetch: SafeFetch; signal: AbortSignal; timeBudgetMs: number }): Promise<Palette | null>;
```

Route stubs return `501`:

```ts
// src/app/api/scan/route.ts (Track B), src/app/api/asset/route.ts (Track A), src/app/api/health/route.ts (Track A)
export const runtime = "nodejs";
export async function POST(): Promise<Response> { return new Response("Not implemented", { status: 501 }); }
```

(`GET` instead of `POST` for asset and health.)

- [ ] **Step 5: In-page source stubs and the bundler**

`src/server/scan/inpage/collector.src.ts`:

```ts
import type { CollectorOptions, RawCollectorOutput } from "../types";

declare global {
  // eslint-disable-next-line no-var
  var __assetsScraper: { collect(options: CollectorOptions): Promise<RawCollectorOutput> } | undefined;
}

globalThis.__assetsScraper = {
  async collect() {
    throw new Error("Not implemented: C: collector");
  },
};
```

`src/server/scan/inpage/palette.src.ts`:

```ts
declare global {
  // eslint-disable-next-line no-var
  var __assetsScraperPalette:
    | { collect(options: Record<string, unknown>): unknown; restore(): void; decodeIconColors(arg: { b64: string; mime: string }): Promise<[string, number][]> }
    | undefined;
}

globalThis.__assetsScraperPalette = {
  collect() {
    throw new Error("Not implemented: E: palette collect");
  },
  restore() {},
  async decodeIconColors() {
    return [];
  },
};
```

`scripts/build-inpage.mjs`:

```js
import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";

const OUT = "src/server/scan/inpage/generated";
const entries = [
  { name: "collector", entry: "src/server/scan/inpage/collector.src.ts", exportName: "COLLECTOR_SOURCE" },
  { name: "palette", entry: "src/server/scan/inpage/palette.src.ts", exportName: "PALETTE_SOURCE" },
];

await mkdir(OUT, { recursive: true });
for (const { name, entry, exportName } of entries) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "chrome120",
    write: false,
    minify: false,
    keepNames: false,
    legalComments: "none",
  });
  const code = result.outputFiles[0].text;
  await writeFile(`${OUT}/${name}.ts`, `// Generated by scripts/build-inpage.mjs. Do not edit.\nexport const ${exportName} = ${JSON.stringify(code)};\n`);
}
console.log(`inpage bundles written to ${OUT}`);
```

- [ ] **Step 6: Verify**

```bash
pnpm build:inpage && pnpm typecheck && pnpm lint && pnpm test
```

Expected: all pass. `src/server/scan/inpage/generated/collector.ts` and `palette.ts` exist and are gitignored.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(server): add limits, internal scan types and module stubs with final signatures"
```

### Task 0.6: Fixture site and helper

**Files:** Create `tests/fixtures/site/**` (copied from `discovery-lab/fixture/`), `tests/fixtures/serve.ts`, `tests/integration/fixture-server.test.ts`.

- [ ] **Step 1: Copy the site and add a brand link**

```bash
mkdir -p tests/fixtures/site && cp -R /private/tmp/claude-501/-Users-fianso/eb755a6c-00db-452d-b978-50bb3ba9b08c/scratchpad/research/discovery-lab/fixture/{index.html,frame.html,assets} tests/fixtures/site/
```

In `tests/fixtures/site/index.html`, replace `<footer></footer>` with:

```html
<footer><a href="/press">Press kit</a> <a href="https://other.example/brand">Other brand</a></footer>
```

The fixture fonts are Inter, JetBrains Mono and Source Sans 3 (all SIL OFL), fine to redistribute.

- [ ] **Step 2: Failing test `tests/integration/fixture-server.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serveFixture, type FixtureServer } from "../fixtures/serve";

let server: FixtureServer;
beforeAll(async () => {
  server = await serveFixture({ "/hello": (_req, res) => res.end("hi") });
});
afterAll(() => server.close());

describe("fixture server", () => {
  it("serves the site, assets and extra routes", async () => {
    const html = await fetch(`${server.origin}/`).then((r) => r.text());
    expect(html).toContain("<title>Fixture Co</title>");
    const font = await fetch(`${server.origin}/assets/__inter.woff2`);
    expect(font.headers.get("content-type")).toBe("font/woff2");
    expect(await fetch(`${server.origin}/hello`).then((r) => r.text())).toBe("hi");
    expect((await fetch(`${server.origin}/nope`)).status).toBe(404);
  });
});
```

- [ ] **Step 3: Implement `tests/fixtures/serve.ts`**

```ts
import { createReadStream, existsSync, statSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

const SITE = path.join(import.meta.dirname, "site");
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".css": "text/css", ".png": "image/png", ".jpg": "image/jpeg",
  ".gif": "image/gif", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".json": "application/json",
};

export interface FixtureServer { origin: string; host: string; port: number; close(): Promise<void> }

export async function serveFixture(routes: Record<string, http.RequestListener> = {}, root = SITE): Promise<FixtureServer> {
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent((req.url ?? "/").split("?")[0]);
    const route = routes[pathname];
    if (route) return route(req, res);
    const file = path.join(root, pathname === "/" ? "/index.html" : pathname);
    if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("not found");
    }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    host: `127.0.0.1:${port}`,
    port,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
```

- [ ] **Step 4: Run**

Run: `pnpm test:integration`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests && git commit -m "test: add fixture site and local fixture server"
```

### Task 0.7: CI, agent notes, PR

**Files:** Create `.github/workflows/ci.yml`, `e2e/smoke.spec.ts`. Modify `AGENTS.md`, `README.md`.

- [ ] **Step 0: `e2e/smoke.spec.ts`** (Playwright fails on an empty test dir)

```ts
import { expect, test } from "@playwright/test";

test("home responds", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
});
```

- [ ] **Step 1: `.github/workflows/ci.yml`**

```yaml
name: CI
on:
  pull_request:
  push:
    branches: [main]

jobs:
  checks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm test

  integration:
    runs-on: ubuntu-latest
    needs: checks
    env:
      CHROME_EXECUTABLE_PATH: /usr/bin/google-chrome
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm test:integration

  e2e:
    runs-on: ubuntu-latest
    needs: checks
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm test:e2e
      - uses: actions/upload-artifact@v4
        if: failure()
        with: { name: playwright-report, path: playwright-report }
```

- [ ] **Step 2: `AGENTS.md` project section** (keep the Next.js managed block)

```md
# Assets Scraper

- Spec: docs/superpowers/specs/2026-09-16-assets-scraper-design.md. Plan: docs/superpowers/plans/2026-09-16-assets-scraper-v1.md.
- Commands: `pnpm dev`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration` (needs Google Chrome), `pnpm test:e2e`.
- `src/lib/contract.ts` is the single source of truth for everything that crosses the network. Change it only together with server and client.
- `src/server/scan` must not import from `next`. The route handlers are thin adapters.
- Every server-side request to a URL that came from a user or a scraped page goes through `safeFetch`. Chromium always runs behind the egress proxy.
- Never insert scraped SVG markup into the DOM. Preview through blob URLs in `<img>`, show code as text.
- UI copy: English, sentence case, no em dash, no en dash, no exclamation marks, no emojis.
- In-page code lives in `src/server/scan/inpage/*.src.ts` and is bundled by `pnpm build:inpage`. It must not import runtime code from the app.
```

- [ ] **Step 3: README dev section**

```md
## Development

Requirements: Node 22+, pnpm 10.33, Google Chrome.

pnpm install
pnpm dev            # http://localhost:3000
pnpm test           # unit and DOM tests
pnpm test:integration
pnpm test:e2e

Set CHROME_EXECUTABLE_PATH if Chrome is not in the default location.
```

- [ ] **Step 4: Commit, push, PR, merge**

```bash
git add -A && git commit -m "ci: add lint, typecheck, unit, integration and e2e workflow"
git push -u origin chore/foundation
gh pr create --title "chore: foundation (toolchain, contract, stubs, fixture, CI)" --body "Phase 0 of the v1 plan."
gh pr checks --watch && gh pr merge --squash --delete-branch
```

Expected: CI green.

---

## Phase 1, Track A: Network safety and asset proxy (branch `feat/net-security`)

Owns: `src/server/net/*`, `src/server/security/*`, `src/app/api/asset/route.ts`, `src/app/api/health/route.ts`, `tests/integration/security/*`.

### Task A1: `isPublicIp`, own hosts, test allowlist

**Files:** `src/server/net/ip.ts`, `src/server/net/ip.test.ts`

- [ ] **Step 1: Failing tests**

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { isOwnHost, isPublicIp, isTestAllowed, resolvePublicHost, SsrfError } from "./ip";

describe("isPublicIp", () => {
  it.each([
    "127.0.0.1", "10.0.0.1", "172.16.5.4", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1",
    "198.18.0.1", "192.0.0.1", "224.0.0.1", "255.255.255.255", "::1", "::", "fd00::1", "fe80::1",
    "::ffff:10.0.0.1", "::ffff:127.0.0.1", "::7f00:1", "64:ff9b::7f00:1", "2002:7f00:1::", "2001::1", "not-an-ip",
  ])("blocks %s", (ip) => expect(isPublicIp(ip)).toBe(false));

  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"])("allows %s", (ip) => expect(isPublicIp(ip)).toBe(true));
});

describe("own hosts and test allowlist", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("treats Vercel and APP_HOSTS hosts as own", () => {
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "assets-scraper.vercel.app");
    vi.stubEnv("APP_HOSTS", "scraper.example.com, other.example");
    expect(isOwnHost("assets-scraper.vercel.app")).toBe(true);
    expect(isOwnHost("SCRAPER.example.com")).toBe(true);
    expect(isOwnHost("stripe.com")).toBe(false);
  });

  it("ignores a trailing root dot on either side", () => {
    // normalizeInputUrl drops the root dot, but env values and redirect targets can still end with one
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "assets-scraper.vercel.app");
    vi.stubEnv("APP_HOSTS", "other.example.");
    expect(isOwnHost("assets-scraper.vercel.app.")).toBe(true);
    expect(isOwnHost("other.example")).toBe(true);
  });

  it("honors the test allowlist only outside production and Vercel", () => {
    vi.stubEnv("SCAN_TEST_ALLOW_HOSTS", "127.0.0.1:8787");
    expect(isTestAllowed("127.0.0.1", 8787)).toBe(true);
    expect(isTestAllowed("127.0.0.1", 8788)).toBe(false);
    vi.stubEnv("VERCEL", "1");
    expect(isTestAllowed("127.0.0.1", 8787)).toBe(false);
  });
});

describe("resolvePublicHost", () => {
  it("rejects private literals and loopback names", async () => {
    await expect(resolvePublicHost("127.0.0.1", 443)).rejects.toBeInstanceOf(SsrfError);
    await expect(resolvePublicHost("[::1]", 443)).rejects.toBeInstanceOf(SsrfError);
    await expect(resolvePublicHost("localhost", 80)).rejects.toBeInstanceOf(SsrfError);
    await expect(resolvePublicHost("localhost.", 80)).rejects.toBeInstanceOf(SsrfError);
  });
});
```

- [ ] **Step 2: Run, see failures** (`pnpm exec vitest run src/server/net/ip.test.ts`, FAIL with NotImplementedError)

- [ ] **Step 3: Implement** following `critic.md` R1 (`isPublicIp` with `::/96` block after IPv4-mapped unwrap, `resolvePublicHost` with `dns.lookup({ all: true, order: "verbatim" })`, own-host set built from `VERCEL_URL`, `VERCEL_BRANCH_URL`, `VERCEL_PROJECT_PRODUCTION_URL`, `APP_HOSTS` read on every call, lowercase, port and trailing root dot stripped, on the configured hosts and on the host being checked). `isTestAllowed` returns true only when `NODE_ENV !== "production"`, `VERCEL` is unset and `SCAN_TEST_ALLOW_HOSTS` contains the exact `host:port`. `resolvePublicHost` returns the host itself (literal) or the first checked address, and returns the literal/first address without the private check when `isTestAllowed(host, port)`.

- [ ] **Step 4: Run tests** (PASS) **Step 5: Commit** `feat(net): add public IP checks, own-host detection and test allowlist`

### Task A2: `safeFetch`

**Files:** `src/server/net/safe-fetch.ts`, `tests/integration/security/safe-fetch.test.ts`

- [ ] **Step 1: Failing integration tests** (local servers, no Chrome)

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serveFixture, type FixtureServer } from "../../fixtures/serve";
import { safeFetch, SafeFetchError } from "@/server/net/safe-fetch";

let allowed: FixtureServer;
let victim: FixtureServer;
let victimHits = 0;

beforeAll(async () => {
  victim = await serveFixture({ "/secret": (_q, s) => { victimHits++; s.end("SECRET"); } });
  allowed = await serveFixture({
    "/redirect-victim": (_q, s) => { s.writeHead(302, { location: `${victim.origin}/secret` }); s.end(); },
    "/redirect-loop": (_q, s) => { s.writeHead(302, { location: "/redirect-loop" }); s.end(); },
    "/big": (_q, s) => { s.writeHead(200, { "content-type": "application/octet-stream" }); s.end(Buffer.alloc(2 * 1024 * 1024)); },
    "/slow": () => {},
  });
  process.env.SCAN_TEST_ALLOW_HOSTS = allowed.host;
});
afterAll(async () => { await allowed.close(); await victim.close(); });

describe("safeFetch", () => {
  it("fetches an allowed URL", async () => {
    const res = await safeFetch(`${allowed.origin}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Fixture Co");
  });

  it("blocks private addresses directly and through redirects", async () => {
    await expect(safeFetch(`${victim.origin}/secret`)).rejects.toMatchObject({ code: "blocked-address" });
    await expect(safeFetch(`${allowed.origin}/redirect-victim`)).rejects.toMatchObject({ code: "blocked-address" });
    await expect(safeFetch("http://127.0.0.1.nip.io/")).rejects.toBeInstanceOf(SafeFetchError);
    expect(victimHits).toBe(0);
  });

  it("enforces redirects, size and time caps", async () => {
    await expect(safeFetch(`${allowed.origin}/redirect-loop`, { maxRedirects: 3 })).rejects.toMatchObject({ code: "too-many-redirects" });
    const big = await safeFetch(`${allowed.origin}/big`, { maxBytes: 1024 });
    await expect(big.buffer()).rejects.toMatchObject({ code: "too-large" });
    await expect(safeFetch(`${allowed.origin}/slow`, { timeoutMs: 500 })).rejects.toMatchObject({ code: "timeout" });
  });

  it("rejects non-http schemes and odd ports", async () => {
    await expect(safeFetch("file:///etc/passwd")).rejects.toMatchObject({ code: "invalid-url" });
    await expect(safeFetch("http://example.com:8080/")).rejects.toMatchObject({ code: "unsupported-port" });
  });
});
```

- [ ] **Step 2: Run, see failures** (`pnpm test:integration -- tests/integration/security/safe-fetch.test.ts`)
- [ ] **Step 3: Implement** with undici `Agent` whose `connect.lookup` calls `resolvePublicHost`, literal IP check before connecting, `redirect: "manual"` loop re-validating each `location` (resolved against the current URL, scheme and port checks each hop), `AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])`, default `User-Agent: Mozilla/5.0 (compatible; AssetsScraper/1.0; +https://github.com/gamween/assets_scraper)` unless provided, byte counting in `stream()`/`buffer()` throwing `too-large`, error mapping (`ENOTFOUND`/`EAI_AGAIN` to `dns`, `ECONNREFUSED`/`ECONNRESET`/TLS to `connect`, `SsrfError` to `blocked-address` or `own-host`, abort to `timeout` or `aborted`). Ports: only 80 and 443 unless `isTestAllowed`.
- [ ] **Step 4: Run** (PASS) **Step 5: Commit** `feat(net): add SSRF-safe fetch with checked DNS and re-validated redirects`

### Task A3: Egress proxy with a real Chrome SSRF suite

**Files:** `src/server/net/egress-proxy.ts`, `tests/integration/security/egress-proxy.test.ts`

- [ ] **Step 1: Failing test** adapted from `critic/ssrf-browser.mjs`: start a victim server (counts hits), an allowed page server serving `/attack.html` that tries every vector (`<img src=victim>`, `fetch(victim)`, `new WebSocket("ws://127.0.0.1:<victimPort>")`, `<iframe src="http://[::1]:<victimPort>/">`, `location.href = victim` after 500 ms, `<img src="http://127.0.0.1.nip.io:<victimPort>/">`, `<img src="http://0.0.0.0:<victimPort>/">`), launch local Chrome with `proxy: { server: "http://127.0.0.1:<proxy.port>" }` and the hardened flags, navigate to `/attack.html`, wait 3 s. Assert `victimHits === 0`, `proxy.stats().blocked > 0`, and that a control page on the allowed server loaded (its title is readable). A second case: navigate directly to `${victim.origin}/secret` and expect the navigation to fail.

```ts
import { chromium } from "playwright-core";
// ...
const browser = await chromium.launch({
  executablePath: process.env.CHROME_EXECUTABLE_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--force-webrtc-ip-handling-policy=disable_non_proxied_udp"],
  proxy: { server: `http://127.0.0.1:${proxy.port}` },
});
```

- [ ] **Step 2: Run, see failure** **Step 3: Implement** from `critic.md` R1 (HTTP absolute-form handler and `CONNECT` handler, `guard(host, port)` with ports 80/443 or `isTestAllowed`, `resolvePublicHost`, pinned IP connect, hop-by-hop header stripping, socket and byte caps, `stats()` with blocked hosts, `close()` destroying sockets). **Step 4: Run** (PASS, victim hits 0) **Step 5: Commit** `feat(net): add per-scan egress proxy that pins public IPs`

### Task A4: URL signing

**Files:** `src/server/security/sign.ts`, `src/server/security/sign.test.ts`

- [ ] **Step 1: Failing tests**

```ts
import { describe, expect, it } from "vitest";
import { HttpError } from "@/server/errors";
import { createSigner, SignLimitError, verifyAssetParams } from "./sign";

const secret = "test-secret-with-enough-entropy-0123456789";
const now = Date.UTC(2026, 8, 16, 12, 30);

describe("sign", () => {
  it("round-trips and keeps the same path within an hour", () => {
    const signer = createSigner({ secret, now });
    const a = signer.sign("https://cdn.example.com/logo.svg");
    const b = createSigner({ secret, now: now + 10 * 60_000 }).sign("https://cdn.example.com/logo.svg");
    expect(a).toBe(b);
    const params = new URL(a, "https://app.local").searchParams;
    expect(verifyAssetParams(params, now, secret)).toEqual({ url: "https://cdn.example.com/logo.svg" });
  });

  it("rejects tampering, expiry and unknown params", () => {
    const params = new URL(createSigner({ secret, now }).sign("https://a.com/x.png"), "https://app.local").searchParams;
    const tampered = new URLSearchParams(params);
    tampered.set("u", Buffer.from("https://evil.com/x.png").toString("base64url"));
    expect(() => verifyAssetParams(tampered, now, secret)).toThrow(HttpError);
    expect(() => verifyAssetParams(params, now + 8 * 3_600_000, secret)).toThrow(HttpError);
    const extra = new URLSearchParams(params);
    extra.set("x", "1");
    expect(() => verifyAssetParams(extra, now, secret)).toThrow(HttpError);
  });

  it("accepts dl and fmt=ttf, rejects other fmt", () => {
    const params = new URL(createSigner({ secret, now }).sign("https://a.com/f.woff2"), "https://app.local").searchParams;
    params.set("dl", "inter.woff2");
    params.set("fmt", "ttf");
    expect(verifyAssetParams(params, now, secret)).toEqual({ url: "https://a.com/f.woff2", dl: "inter.woff2", fmt: "ttf" });
    params.set("fmt", "png");
    expect(() => verifyAssetParams(params, now, secret)).toThrow(HttpError);
  });

  it("caps signed URLs per scan", () => {
    const signer = createSigner({ secret, now, max: 2 });
    signer.sign("https://a.com/1");
    signer.sign("https://a.com/2");
    expect(() => signer.sign("https://a.com/3")).toThrow(SignLimitError);
    expect(signer.count).toBe(2);
  });
});
```

Defaults: `verifyAssetParams(params, now = Date.now(), secret = getSecret())`.

- [ ] **Step 2: Run, see failures** **Step 3: Implement** from `critic.md` R4 (`mac(e, u)` over `v1\n${e}\n${u}` HMAC-SHA256 base64url truncated to 32, expiry `(floor(now/3_600_000) + 7) * 3600`, allowed params `u,e,s,dl,fmt`, `timingSafeEqual`, `getSecret()` = `ASSET_URL_SECRET`, or in non-production a random per-process key; in production without the secret throw at first use). **Step 4: Run** (PASS) **Step 5: Commit** `feat(security): add HMAC-signed asset URLs`

### Task A5: Budget store

**Files:** `src/server/security/budget.ts`, `src/server/security/budget.test.ts`

- [ ] **Step 1: Failing tests**: with `setBudgetStoreForTests(memoryStore)` and `SCANS_PER_DAY=2`, three `takeScanBudget(now)` calls return `true, true, false`; the next UTC day returns `true` again; `takeProxyBytes` sums bytes and returns false past `PROXY_BYTES_PER_DAY`; a store whose `incr` throws falls back to the in-memory store and still enforces the limit.
- [ ] **Step 2: Run, see failures** **Step 3: Implement**: `MemoryBudgetStore` (Map with expiry), `UpstashBudgetStore` (when both Upstash env vars exist, `@upstash/redis` `incrby` + `expire` in a pipeline), `RuntimeCacheBudgetStore` only if `@vercel/functions` exposes a runtime cache API in 3.9.8 (check `node_modules/@vercel/functions` exports; if absent, skip this implementation and note it in the PR), selection in `getBudgetStore()`, keys `scan:d:YYYY-MM-DD` (ttl 2 days), `scan:m:YYYY-MM` (ttl 40 days), `proxy:d:YYYY-MM-DD`. **Step 4: Run** (PASS) **Step 5: Commit** `feat(security): add scan and proxy budgets with pluggable stores`

### Task A6: Scan gate

**Files:** `src/server/security/gate.ts`, `src/server/security/gate.test.ts`

- [ ] **Step 1: Failing tests** (mock `botid/server` with `vi.mock`), one per rule in order, each asserting status and `ApiError` body:
  - GET gives 405; missing JSON content type gives 400 `invalid-url`; foreign `Origin` gives 403 `bot`;
  - body `{ url: "" }` gives 400 `invalid-url`;
  - `checkBotId` returning `{ isBot: true }` gives 403 `bot`;
  - `SCAN_DISABLED=1` gives 503 `disabled`;
  - `ACCESS_CODE=abc` without header gives 401 `access-code`, with `x-access-code: abc` passes;
  - budget exhausted gives 429 `budget`;
  - `http://127.0.0.1/` gives 422 `blocked-address`, `http://x.com:8080` gives 422 `unsupported-port`, own host gives 422 `own-host`;
  - `x-ops-token` equal to `OPS_TOKEN` (at least 32 characters) skips BotID and budget and sets `ops: true`;
  - a valid request returns `{ ok: true, url: "https://linear.app/", host: "linear.app", ops: false }`.
- [ ] **Step 2: Run, see failures** **Step 3: Implement** in the spec order (7.1), with `normalizeInputUrl`, literal private IP check through `isPublicIp` on IP hostnames, `isOwnHost`, timing-safe comparisons, JSON error helper `apiError(status, code, message)`. Origin check: compare `new URL(request.url).origin` with the `Origin` header; allow a missing `Origin` only when `ops` is true. **Step 4: Run** (PASS) **Step 5: Commit** `feat(security): add ordered request gate for scans`

### Task A7: Asset proxy route and health route

**Files:** `src/app/api/asset/route.ts`, `src/server/security/asset-proxy.ts` (handler logic, testable without Next), `tests/integration/security/asset-proxy.test.ts`, `src/app/api/health/route.ts`

- [ ] **Step 1: Failing tests** calling `handleAssetRequest(request)` directly against a local allowed server:
  - valid signature streams bytes with `content-type`, `x-content-type-options: nosniff`, `cross-origin-resource-policy: same-origin`, CSP `sandbox`, `vercel-cdn-cache-control` and `vary: Sec-Fetch-Site`;
  - `Sec-Fetch-Site: cross-site` gives 403;
  - bad signature gives 403; unknown param gives 400;
  - an HTML response upstream gives 415;
  - `application/octet-stream` with PNG magic bytes is served as `image/png`;
  - over 25 MB gives 413 (use a small `PROXY_MAX_BYTES` override injected through a handler option);
  - `dl=../../x.svg` gives `content-disposition: attachment; filename*=UTF-8''x.svg`;
  - `fmt=ttf` on the fixture `__inter.woff2` returns `font/ttf` bytes starting with `00 01 00 00` when `isConvertibleFont` resolves true (mock it), and 403 when false;
  - daily proxy bytes over budget gives 429.
- [ ] **Step 2: Run, see failures** **Step 3: Implement** following spec 11.2 (`verifyAssetParams`, `safeFetch` with `Referer` = origin of the asset URL's page is unknown here, so send `Referer: https://<asset host>/`, magic-byte sniffing for PNG, JPEG, GIF, WebP, AVIF, ICO, WOFF, WOFF2, TTF, OTF, SVG text, `wawoff2.decompress` for `fmt=ttf` after `parseFontBinary` and `isConvertibleFont`, the proxied bytes budget taken before bytes are served: the upstream `content-length`, or 1 MiB blocks while a body of unknown length streams, the unused part handed back through `waitUntil`). Route file: `export const runtime = "nodejs"; export const GET = (request: Request) => handleAssetRequest(request);`. Health route returns `{ ok: true, version: process.env.VERCEL_GIT_COMMIT_SHA ?? "dev", disabled: process.env.SCAN_DISABLED === "1", accessCode: Boolean(process.env.ACCESS_CODE) }` with `cache-control: no-store`. **Step 4: Run** (PASS) **Step 5: Commit** `feat(api): add signed asset proxy and health routes`

### Task A8: PR

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration
git push -u origin feat/net-security && gh pr create --title "feat: network safety, signing, budgets, gate and asset proxy" --body "Track A of the v1 plan."
```

Do not merge; Phase 2 merges.

---

## Phase 1, Track B: Browser, engine and scan route (branch `feat/engine`)

Owns: `src/server/browser/launch.ts`, `src/server/scan/{engine,preflight,navigate,capture,block,fallback}.ts`, `src/server/scan/inpage/run.ts`, `src/app/api/scan/route.ts`, `tests/integration/engine/*`.

Tracks C, D and E are stubs on this branch. Engine tests that need real collectors are written against the stub behavior (collector failure is a handled `internal` error or partial result) plus an injected fake: `engine.ts` exports `createScanEngine(deps)` with defaults wired to the real modules, and `scanEngine = createScanEngine()`. Tests inject fakes for `assembleAssets`, `buildFontFamilies`, `extractPalette` and the collector source.

### Task B1: `detectBlock` and `parseHead`

**Files:** `src/server/scan/block.ts`, `src/server/scan/block.test.ts`, `src/server/scan/preflight.ts` (only `parseHead`), `src/server/scan/preflight.test.ts`

- [ ] **Step 1: Failing tests**

```ts
import { describe, expect, it } from "vitest";
import { detectBlock } from "./block";

const base = { status: 200, title: "Home", html: "<html></html>", headers: {}, elementCount: 400 };

describe("detectBlock", () => {
  it("flags Cloudflare's mitigation header", () => expect(detectBlock({ ...base, headers: { "cf-mitigated": "challenge" } })).toBe("cloudflare-challenge"));
  it.each(["Just a moment...", "Access to this page has been denied", "Please verify you are a human", "Attention Required! | Cloudflare"])("flags title %s", (title) =>
    expect(detectBlock({ ...base, title })).toBe("challenge-title"));
  it("flags challenge markup on small or failed pages only", () => {
    const html = '<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script>';
    expect(detectBlock({ ...base, html, elementCount: 40 })).toBe("challenge-markup");
    expect(detectBlock({ ...base, html, elementCount: 297 })).toBeNull(); // medium.com false positive
  });
  it("flags captcha-only pages and forbidden small pages", () => {
    expect(detectBlock({ ...base, html: "hcaptcha", elementCount: 50 })).toBe("captcha-only-page");
    expect(detectBlock({ ...base, status: 403, elementCount: 120 })).toBe("http-403");
    expect(detectBlock({ ...base, status: 403, elementCount: 900 })).toBeNull();
  });
});
```

`parseHead` tests: from a small HTML string, returns title, `og:site_name`, icon links with `rel`, `sizes`, `type` resolved to absolute URLs, `og:image` and `twitter:image` values, JSON-LD `logo` as a string, `{ url }` or `{ contentUrl }` (including `@graph` arrays), and `manifestUrl`.

- [ ] **Step 2: Run, see failures** **Step 3: Implement** (`detectBlock` exactly as spec 8.9; `parseHead` with tag regexes over the first 1 MB, attribute parser tolerant to quote styles, `JSON.parse` guarded). **Step 4: Run** (PASS) **Step 5: Commit** `feat(scan): add block detection and page head parsing`

### Task B2: Hardened launch

**Files:** `src/server/browser/launch.ts`, `tests/integration/engine/launch.test.ts`

- [ ] **Step 1: Failing tests** (local Chrome):
  - `withBrowser` gives a page that can load `about:blank`, and closes the browser afterwards (the process from the pidfile is gone);
  - two concurrent `withBrowser` calls run one at a time (`onQueued` called once, second `queueMs` > 0);
  - with `MAX_CONCURRENT_SCANS=1` and `QUEUE_WAIT_MS=200` a third concurrent call rejects with `BusyError`;
  - the context has `acceptDownloads: false`, `serviceWorkers: "block"`, the user agent does not contain `HeadlessChrome`, viewport is 1440x900;
  - aborting the signal while `fn` runs kills the browser and rejects.
- [ ] **Step 2: Run, see failures** **Step 3: Implement** from `infra-spike.md` (d) plus `critic.md` R6: `IS_SERVERLESS`, sparticuz executable single-flight with the wrapper script (`ulimit -c 0`, pidfile, `exec`), insecure flag filter, extra flags, `proxy` from `egressPort`, scrubbed `env`, `killStaleChromium`, `/tmp` sweep, health check (`statfs` on `/tmp` and `/proc/meminfo` when present) returning `BusyError` below `limits.minTmpFreeMb` / `limits.minMemAvailableMb` after one kill-and-sweep retry, semaphore with `limits.queueWaitMs` (env `QUEUE_WAIT_MS` override for tests), context options from spec 7.3, CDP `Network.setBlockedURLs` for media, `cold` true for the first launch in the process. Local mode uses `CHROME_EXECUTABLE_PATH` or the macOS/Linux default path and the same flags and proxy. **Step 4: Run** (PASS) **Step 5: Commit** `feat(browser): add hardened Chromium launch with pidfile kill, health gate and semaphore`

### Task B3: `runInPage`

**Files:** `src/server/scan/inpage/run.ts`, `tests/integration/engine/run-in-page.test.ts`

- [ ] **Step 1: Failing tests**: on a page that overrides `Array.prototype.includes` to throw, `runInPage(page, "globalThis.__t = { go: () => [1,2].includes(2) }", "globalThis.__t.go()", { timeoutMs: 2000 })` returns `{ value: true, world: "isolated" }`; an expression that never resolves rejects after `timeoutMs`; when isolated world creation fails (simulate by passing a closed page's CDP session through an injected factory), it falls back to the main world and reports `world: "main"`.
- [ ] **Step 2: Run, see failures** **Step 3: Implement** from `discovery-lab.md` 1.1 step 4 (`Page.getFrameTree`, `Page.createIsolatedWorld` with `grantUniveralAccess: false`, `Runtime.evaluate` of `${source};${expression}` with `awaitPromise` and `returnByValue`, exception mapping, detach in `finally`, `Promise.race` with the timeout). **Step 4: Run** (PASS) **Step 5: Commit** `feat(scan): run bundled in-page code in an isolated world`

### Task B4: Network capture

**Files:** `src/server/scan/capture.ts`, `tests/integration/engine/capture.test.ts`

- [ ] **Step 1: Failing tests** on the fixture site: after `goto` and `settle(5000)`, `images` contains `photo-small.png` with `sha1`, `width`/`height` from sharp metadata and a `tone` (the stub `toneFromBytes` throws, so capture must catch and set `unknown`); `fonts` contains `__inter.woff2` (with `meta: null` while Track D is a stub); `sheets` contains `style.css` with its text; a route `/hang.png` that never finishes its body is counted in `bodyTimeouts` and does not block `settle` longer than its timeout (set `BODY_READ_MS=500` through an option); a 3xx is skipped; the blob image has `blobBase64`.
- [ ] **Step 2: Run, see failures** **Step 3: Implement** from spec 7.4 with a small concurrency limiter, byte accounting, per-read timeout, `sharp(buffer).metadata()` guarded, `toneFromBytes` and `parseFontBinary` calls guarded with try/catch, SVG text kept up to 1 MB, CSS text kept, blob bodies kept within caps. **Step 4: Run** (PASS) **Step 5: Commit** `feat(scan): capture network images, fonts and stylesheets with bounded reads`

### Task B5: Navigation helpers

**Files:** `src/server/scan/navigate.ts`, `tests/integration/engine/navigate.test.ts`

- [ ] **Step 1: Failing tests** on the fixture site: `openPage` returns status 200, title `Fixture Co`, `finalUrl`, `elementCount > 30`; `loadAndScroll` calls `onStep` with `load start/done` and `scroll start/done`, and a lazy page (route `/lazy.html` whose image is inserted by an `IntersectionObserver` near the bottom) ends with that image loaded; `prepareForCollection` finishes a 10 s CSS animation so its element has its end state, and resolves `document.fonts.ready`; a route `/loop.html` with `while(true){}` after 1 s does not hang the helpers past their caps (the test aborts with the signal and expects rejection within 12 s).
- [ ] **Step 2: Run, see failures** **Step 3: Implement** from spec 7.2 phases 4 to 7 and `discovery-lab.md` 1.1 step 2 (with `document.scrollingElement`). **Step 4: Run** (PASS) **Step 5: Commit** `feat(scan): add navigation, lazy scroll and collection preparation`

### Task B6: Preflight and fallback

**Files:** `src/server/scan/preflight.ts`, `src/server/scan/fallback.ts`, `tests/integration/engine/preflight.test.ts`

- [ ] **Step 1: Failing tests**: preflight on the fixture returns `contentType` text/html and a `head` with the apple-touch icon and `og:image`; a route serving `application/pdf` returns `contentType` `application/pdf` and `head: null`; `http://127.0.0.1:<victim>/` rejects with `ScanFailure` code `blocked-address`; an unresolvable host `https://does-not-exist.invalid/` rejects with `dns`; a 403 page resolves (does not throw). Fallback: with a fake `fetch` returning a PNG for the Google favicon URL and a Wikidata JSON response with a `P154` value, `buildFallback` returns assets with `foundIn: ["public-source"]`, roles `favicon`/`site-logo`, signed proxies, and includes head icons; it never throws (network failures give an empty list).
- [ ] **Step 2: Run, see failures** **Step 3: Implement** (preflight through `safeFetch` GET with `limits.preflightMaxBytes`, `Accept: text/html,*/*;q=0.8`, `SafeFetchError` to `ScanFailure` code mapping; fallback per spec 8.9 with the exact-match Wikidata SPARQL of `fallback.ts`, `SELECT ?logo ?site WHERE { VALUES ?site { <IRIs> } ?item wdt:P856 ?site . ?item wdt:P154 ?logo } LIMIT 5`, where `<IRIs>` are the 8 official website IRIs of the bare host (`https` and `http`, with and without `www.`, with and without the trailing slash); bindings for another host are ignored. A `FILTER(CONTAINS(...))` text match scans every official website and never answers in time. Sent through `safeFetch` to `https://query.wikidata.org/sparql?format=json&query=...` with the generic user agent, `limits.wikidataMs` (3 s) timeout). **Step 4: Run** (PASS) **Step 5: Commit** `feat(scan): add preflight and public-source fallback for blocked sites`

### Task B7: Engine

**Files:** `src/server/scan/engine.ts`, `tests/integration/engine/engine.test.ts`

- [ ] **Step 1: Failing tests** with `createScanEngine({ assembleAssets: fake, buildFontFamilies: fake, extractPalette: fake, collectorSource: FAKE_COLLECTOR })` where `FAKE_COLLECTOR` defines `globalThis.__assetsScraper.collect` returning a minimal valid `RawCollectorOutput`:
  - event order on the fixture: `accepted`, `step open start`, `page` (early: empty `brandLinks`, no `favicon`), `step open done`, `step load ...`, `step scroll ...`, `step collect ...`, `step process ...`, `page` (final: `brandLinks` from the fake collector output), `palette`, `assets`, `fonts`, `done`; the stream ends after `done`; `done.diagnostics.collector` is `isolated`;
  - a PDF URL yields `error not-html` with one fallback asset of that URL;
  - a blocked page (route returning a Cloudflare-style challenge title with status 403) yields `error blocked` with fallback assets and `diagnostics.blockReason`;
  - a page with `while(true){}` yields `done` with `partial: true` or `error timeout` within `SCAN_DEADLINE_MS=15000` + 10 s, and the Chrome process is gone afterwards;
  - aborting the signal during `scroll` ends the iterator without emitting `done` and kills Chrome;
  - a page whose script triggers a file download (`<a download>` click) does not write to disk and the scan completes;
  - `http://127.0.0.1:<victim>/` gives `error blocked-address` before launching Chrome;
  - the real (stub) collectors: `createScanEngine()` on the fixture yields `error internal` (not an unhandled rejection), proving failure handling.
- [ ] **Step 2: Run, see failures** **Step 3: Implement** spec section 7.2 end to end: `AbortSignal.any` with the request signal and the deadline, preflight, `startEgressProxy`, `withBrowser` (emitting `step queue` from `onQueued`), `startCapture` before `openPage`, `detectBlock` on the navigation result, early `page` event (empty `brandLinks`, no `favicon`), `loadAndScroll`, `prepareForCollection`, `extractPalette` (the engine only calls it: it opens its own isolated world and loads its own in-page code) then `runInPage(page, COLLECTOR_SOURCE, "globalThis.__assetsScraper.collect(<options>)")`, `capture.settle`, close browser, post-processing (`assembleAssets` and `buildFontFamilies` in parallel with a shared signer from `createSigner({ max: limits.maxSignedUrls })`; `assembleAssets` signs its sources, then the engine signs the font files with `signFontFiles` and adds a `truncated` warning when the cap left any unsigned), final `page` event (collector `brandLinks`, `favicon` from the favicon asset's signed source), batching `assets` with `chunkByBytes`, `done` with stats and diagnostics (egress stats, phases, health, `version` from `VERCEL_GIT_COMMIT_SHA` or `dev`). Every thrown `ScanFailure` becomes an `error` event; any other error becomes `internal` with the diagnostics. The deadline path emits whatever results exist with `partial: true` and a `warning partial`. **Step 4: Run** (PASS) **Step 5: Commit** `feat(scan): add scan engine orchestration with deadlines and cancellation`

### Task B8: Scan route

**Files:** `src/app/api/scan/route.ts`, `src/server/scan/stream.ts` (engine to NDJSON `Response`), `src/server/scan/stream.test.ts`

- [ ] **Step 1: Failing tests** for `eventsToResponse(iterable, signal)`: content type `application/x-ndjson; charset=utf-8`, `cache-control: no-store`, `x-accel-buffering: no`; lines decode with `decodeNdjson` in order; an iterable that throws mid-way ends with an `error internal` line; cancelling the response body aborts the iterable.
- [ ] **Step 2: Run, see failures** **Step 3: Implement** `stream.ts` and the route:

```ts
import { gateScanRequest } from "@/server/security/gate";
import { scanEngine } from "@/server/scan/engine";
import { eventsToResponse } from "@/server/scan/stream";

export const runtime = "nodejs";
export const maxDuration = 120;
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const gate = await gateScanRequest(request);
  if (!gate.ok) return gate.response;
  return eventsToResponse(scanEngine.scan({ url: gate.url }, { signal: request.signal }), request.signal);
}
```

**Step 4: Run** (PASS) **Step 5: Commit** `feat(api): stream scan events as NDJSON`

### Task B9: PR

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration
git push -u origin feat/engine && gh pr create --title "feat: hardened browser, scan engine and scan route" --body "Track B of the v1 plan."
```

---

## Phase 1, Track C: Asset collector and post-processing (branch `feat/assets`)

Owns: `src/server/scan/inpage/collector.src.ts`, `src/server/scan/post/*`, `tests/integration/assets/*`.

Port the lab code (`discovery-lab/lib/inpage.js`, `cdn.mjs`, `noise.mjs`, and the post-processing parts of `lab.mjs`) to TypeScript into the files below, keeping the validated behavior, and adapt its output to `RawCollectorOutput` and the final `Asset` contract.

For collector integration tests on this branch, use a local test helper `tests/integration/assets/harness.ts` that launches local Chrome directly with playwright-core, loads the fixture, runs the bundled collector with `page.evaluate` of the `COLLECTOR_SOURCE` string (Track B's `runInPage` is a stub here), and captures network bodies with a minimal inline listener.

### Task C1: Parsers and formats

**Files:** `src/server/scan/post/parse.ts`, `parse.test.ts`, `src/server/scan/post/format.ts`, `format.test.ts`

- [ ] **Step 1: Failing tests**

```ts
import { describe, expect, it } from "vitest";
import { extractCssUrls, parseSrcset } from "./parse";

describe("parseSrcset", () => {
  it("keeps commas inside URLs and reads descriptors", () => {
    expect(parseSrcset("https://res.cloudinary.com/x/image/upload/w_500,c_fill/a.jpg 500w, /b.jpg 1000w")).toEqual([
      { url: "https://res.cloudinary.com/x/image/upload/w_500,c_fill/a.jpg", w: 500 },
      { url: "/b.jpg", w: 1000 },
    ]);
    expect(parseSrcset("a.png, b.png 2x")).toEqual([{ url: "a.png", x: 1 }, { url: "b.png", x: 2 }]);
    expect(parseSrcset("")).toEqual([]);
  });
});

describe("extractCssUrls", () => {
  it("reads url() and image-set strings without garbage", () => {
    expect(extractCssUrls('url("a.png"), url(b.png)')).toEqual(["a.png", "b.png"]);
    expect(extractCssUrls('image-set("imgset-1x.png" 1x, "imgset-2x.png" 2x)')).toEqual(["imgset-1x.png", "imgset-2x.png"]);
    expect(extractCssUrls('image-set(url("a.png") 1dppx, url("b.png") 2dppx)')).toEqual(["a.png", "b.png"]);
    expect(extractCssUrls("none")).toEqual([]);
    expect(extractCssUrls("url(#grad1)")).toEqual([]);
  });
});
```

`format.test.ts`: `formatFromContentType("image/svg+xml; charset=utf-8", "x")` is `svg`; `("image/x-icon", ...)` is `ico`; `("application/octet-stream", "https://a.com/x.webp?v=1")` is `webp` from the extension; `sniffFormat` recognizes PNG, JPEG, GIF, WebP, AVIF (`ftypavif`), ICO, SVG text, and returns `other` otherwise.

- [ ] **Step 2: Run, see failures** **Step 3: Implement** (parsers from `discovery-lab.md` 1.3; `formatFromContentType`, `sniffFormat(buffer)`, `extensionFor(format)`). **Step 4: Run** (PASS) **Step 5: Commit** `feat(assets): add srcset and CSS URL parsers and format detection`

### Task C2: CDN originals

**Files:** `src/server/scan/post/cdn.ts`, `cdn.test.ts`

- [ ] **Step 1: Failing table-driven tests** built from `discovery-lab/cdn-verify.json`: for every sample with a verified original, `originalCandidates(sample.url, { pageUrl: sample.pageUrl, server: sample.server })[0]` equals the verified original URL. Add explicit cases:

```ts
it.each([
  ["https://www.notion.com/_next/image?url=%2Ffront-static%2Fa.png&w=256&q=75", "https://www.notion.com/front-static/a.png"],
  ["https://vercel.com/vc-ap-vercel-marketing/_next/image?url=https%3A%2F%2Fassets.vercel.com%2Fimage%2Fupload%2Fx.png&w=1920&q=75", "https://assets.vercel.com/image/upload/x.png"],
  ["https://framerusercontent.com/images/abc.jpg?scale-down-to=512", "https://framerusercontent.com/images/abc.jpg"],
  ["https://cdn.prod.website-files.com/a/b-p-500.avif", "https://cdn.prod.website-files.com/a/b.avif"],
  ["https://static.wixstatic.com/media/11_abc~mv2.png/v1/fill/w_200,h_40,al_c/logo.png", "https://static.wixstatic.com/media/11_abc~mv2.png"],
  ["https://cdn.shopify.com/s/files/1/products/shoe_600x.jpg?v=12&width=600", "https://cdn.shopify.com/s/files/1/products/shoe.jpg?v=12"],
  ["https://images.unsplash.com/photo-1?ixid=abc&w=400&q=80&fit=crop", "https://images.unsplash.com/photo-1?ixid=abc"],
  ["https://cdn.sanity.io/images/p/production/id-1200x800.png?w=300&auto=format", "https://cdn.sanity.io/images/p/production/id-1200x800.png"],
  ["https://images.ctfassets.net/s/a/b/c.png?w=400&fm=avif", "https://images.ctfassets.net/s/a/b/c.png"],
])("%s", (input, expected) => expect(originalCandidates(input, { pageUrl: "https://site.example/" })[0]).toBe(expected));

it("skips signed URLs and returns nothing for plain URLs", () => {
  expect(originalCandidates("https://res.cloudinary.com/x/image/upload/s--abcdefgh--/w_300/a.jpg", { pageUrl: "https://s.example/" })).toEqual([]);
  expect(originalCandidates("https://example.com/logo.png", { pageUrl: "https://example.com/" })).toEqual([]);
});

it("builds the same variant key for size variants", () => {
  expect(variantKey("https://www.apple.com/v/home/a/images/hero_small_2x.jpg")).toBe(variantKey("https://www.apple.com/v/home/a/images/hero_large.jpg"));
  expect(variantKey("https://a.com/x.png?w=300&q=80")).toBe(variantKey("https://a.com/x.png?w=1200"));
});
```

- [ ] **Step 2: Run, see failures** **Step 3: Port** `cdn.mjs` (every rule in spec 8.4, recursion to depth 3, `variantKey`). **Step 4: Run** (PASS) **Step 5: Commit** `feat(assets): add CDN original URL rules and variant keys`

### Task C3: Noise, variants, roles, naming, tone

**Files:** `src/server/scan/post/{noise,variants,roles,naming,tone}.ts` with tests

- [ ] **Step 1: Failing tests**
  - `noise.test.ts`: tracker host (`https://www.google-analytics.com/collect?v=1`) gives `tracker`; `pixel.gif` gives `spacer`; a decoded 1x1 image gives `pixel`; a 40x40 data URI PNG gives `tiny-data-uri`; an SVG data URI with only `<defs/>` gives `placeholder`; an `text/html` capture gives `not-image`; `https://cdn.cookielaw.org/logos/x.png` gives `consent`; `https://www.gstatic.com/recaptcha/api2/logo_48.png` gives `widget`; a normal logo gives `null`.
  - `variants.test.ts`: the fixture-like group (`photo-small.png` 200w and `photo-large.png` 1600w in one element group) merges and picks `photo-large.png`; a `<picture>` with `media` source does not merge with its fallback `src`; two URLs with the same `sha1` merge; a raster and an SVG in one group split; a fallback `src` shared by two elements joins only its preferred group.
  - `roles.test.ts`: header SVG in a home link with a logo word scores 8 and becomes `site-logo`; `og:image` becomes `social`; a 24x24 rendered SVG becomes `icon`; a favicon is never `icon`; `relevanceScore` orders site-logo above a large visible image above a hidden icon.
  - `naming.test.ts`: display name from the collector label over the file basename (the collector picks `aria-label` over `<title>` over `alt`, tested in `collector.test.ts`); hashed basenames (`logo.a1b2c3d4.svg`, `hero-3f9ab1c2e4.png`) are cleaned; filenames are prefixed with the site slug once (`linear-logo.svg`, not `linear-linear-logo.svg`), capped at 80 characters, clash to `-2`, and `../evil/<name>` becomes safe.
  - `tone.test.ts`: generate PNGs with sharp in the test (white shape on transparent gives `light`, black shape on transparent gives `dark`, opaque red gives `opaque`, half gray gives `mixed`); a JPEG buffer gives `opaque` without decoding; `toneFromSvg('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#fff"/></svg>')` gives `opaque`, a white circle on transparent gives `light`; invalid bytes give `unknown`.
- [ ] **Step 2: Run, see failures** **Step 3: Implement** (spec 8.2, 8.3, 8.5, 8.7, 8.8; port `noise.mjs` host lists; noise reasons are the `HiddenReason` names from the contract, not the lab strings). **Step 4: Run** (PASS) **Step 5: Commit** `feat(assets): add noise filter, variant grouping, roles, naming and tone`

### Task C4: Verification

**Files:** `src/server/scan/post/verify.ts`, `tests/integration/assets/verify.test.ts`

- [ ] **Step 1: Failing tests** against local routes: a PNG route answering `206` with `content-range: bytes 0-262143/900000` gives `{ ok: true, format: "png", bytes: 900000, width, height }`; an HTML 200 gives `{ ok: false }`; octet-stream with WebP magic gives `ok` and `webp`; `runVerifications` with 40 tasks respects concurrency 16 and stops starting new tasks after the deadline, returning `verify-skipped` for the rest.
- [ ] **Step 2: Run, see failures** **Step 3: Implement** (spec 8.4 request, dimensions from the first bytes with sharp on the partial buffer when possible, else unknown). **Step 4: Run** (PASS) **Step 5: Commit** `feat(assets): verify CDN originals and declared URLs with ranged requests`

### Task C5: In-page collector and SVG normalizer

**Files:** `src/server/scan/inpage/collector.src.ts`, `tests/integration/assets/harness.ts`, `tests/integration/assets/collector.test.ts`

- [ ] **Step 1: Failing golden test** on the fixture site (via the harness), asserting on `RawCollectorOutput`:
  - `page.title` is `Fixture Co`, `page.siteName` is `Fixture`;
  - the header SVG is in `svgs` with `context.homeLink && context.header`, `label` `Fixture home`, and its markup contains the link's live computed color, `rgb(0, 0, 238)` (currentColor resolved: the header link has no color rule and keeps the UA link color);
  - the gradient SVG markup contains `rgb(255, 51, 102)` and a `<linearGradient` copied into its `<defs>`;
  - the external sprite SVG markup contains the star path from `sprite.svg`;
  - the `.page-icons` SVG markup contains `rgb(0, 170, 119)`, and the two identical ones collapse to one entry with `usedCount: 2`;
  - the `:r1:`/`:r2:` pair collapses to one entry with `usedCount: 2`;
  - the `display:none` SVG is present with `visible: false` and its markup has no `display:none`;
  - the shadow DOM SVG markup contains `rgb(0, 153, 255)` with `context.shadowRoot`; the iframe SVG is present with `context.iframe`;
  - candidates include `photo-small.png` and `photo-large.png` in one `group`, `hero.jpg` with `media`, `lazy.jpg` with `foundIn: "lazy-attribute"`, `noscript.jpg` not visible, `poster.jpg`, `bg.png` (`css-background`), `hover.png` (`declaredOnly`), `pseudo.png` (`css-pseudo`), `imgset-1x.png` and `imgset-2x.png` sharing a group, `mask.svg` (`css-mask`), `shadow.png` (`shadow-dom`), `iframe.png` (`iframe`), `og.png` (`og-image` and `svg-image`), `touch.png` (`icon-link`), `logo.svg` (`icon-link` and `img`), the JSON-LD logo URL (`json-ld`);
  - `blobs` has one PNG;
  - `fontFaces` include `__Inter_d65c78` twice with unicode ranges, `Brand Serif` and `Unused Face`; `fontUsage` has `__Inter_d65c78` and `Brand Serif` stacks with characters; `fontStatuses` has a `loaded` entry for `__Inter_d65c78`;
  - `brandLinks` equals `[{ href: "<origin>/press", text: "Press kit" }]`;
  - a page overriding `Array.prototype.includes` still produces output;
  - `stats.truncated` is false and `stats.ms < 5000`.
- [ ] **Step 2: Run, see failures** **Step 3: Port** `inpage.js` into `collector.src.ts` as `globalThis.__assetsScraper.collect(options)`, typed against `src/server/scan/types.ts`, with the caps in `CollectorOptions`, `customElements` guards, the sandbox iframe normalizer (spec 8.6), sprite expansion, blob capture, brand links, font rules/statuses/usage, and `unreadableSheets` for sheets whose `cssRules` throw. **Step 4: Run** (PASS) **Step 5: Commit** `feat(assets): port in-page collector and SVG normalizer`

### Task C6: Assemble

**Files:** `src/server/scan/post/assemble.ts`, `tests/integration/assets/assemble.test.ts`

- [ ] **Step 1: Failing golden test** feeding the harness output (collector plus captured network with real sha1/sizes/tones computed through `toneFromBytes`) into `assembleAssets` with a fake signer (`sign: (u) => "/api/asset?u=" + u`) and `safeFetch` (fixture host allowed by `SCAN_TEST_ALLOW_HOSTS`). Assert on the final `Asset[]` (validated with `Asset.parse`):
  - exactly one `site-logo`, an inline SVG, named `Fixture home` or `Fixture`, filename starting `fixture-`;
  - the photo asset has `display.url` ending `photo-small.png` and `original.url` ending `photo-large.png`;
  - `hero.jpg` is a separate asset; `pixel.gif` is absent and `hidden.spacer` or `hidden.pixel` is at least 1; the lazy GIF placeholder is absent;
  - `hover.png` has `declaredOnly: true`; `mask.svg` is `kind: "svg"`;
  - `og.png` has role `social` and `foundIn` containing `og-image`;
  - the JSON-LD logo at `example.invalid` is absent (failed probe) and counted in `hidden["probe-failed"]`;
  - the blob image has `inline.base64` and `display: null`;
  - filenames are unique; every non-inline asset has `proxy` from the signer; every asset has a `tone`;
  - assets are sorted by `score` descending, `site-logo` first.
- [ ] **Step 2: Run, see failures** **Step 3: Implement** the pipeline: noise, candidate to URL records (resolve relative URLs against `page.baseUrl`, decode data URIs, attach captured info by URL), variants, CDN candidates, verification and declared probes within `input.deadline` (warnings when skipped), roles and scores, SVG assets from `svgs` (tone via `toneFromSvg` within budget), naming, signing (inline assets are not signed), `maxAssets` cap with `truncated` warning. **Step 4: Run** (PASS) **Step 5: Commit** `feat(assets): assemble final assets from collector output and captures`

### Task C7: PR

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration
git push -u origin feat/assets && gh pr create --title "feat: asset collector and post-processing" --body "Track C of the v1 plan."
```

---

## Phase 1, Track D: Fonts (branch `feat/fonts`)

Owns: `src/server/scan/fonts/*`, `tests/integration/fonts/*`. Port from `discovery-lab/lib/fonts.mjs` and `discovery-lab.md` section 3.

### Task D1: Unicode ranges and CSS parsing

**Files:** `src/server/scan/fonts/unicode.ts`, `css.ts` with tests

- [ ] **Step 1: Failing tests**

```ts
import { describe, expect, it } from "vitest";
import { coversBasicLatin, parseUnicodeRange } from "./unicode";
import { parseFontFaceCss } from "./css";

describe("unicode-range", () => {
  it("parses ranges and wildcards", () => {
    expect(parseUnicodeRange("U+0000-00FF, U+0131, U+4??")).toEqual([[0, 255], [0x131, 0x131], [0x400, 0x4ff]]);
    expect(coversBasicLatin("U+0000-00FF")).toBe(true);
    expect(coversBasicLatin("U+0400-045F")).toBe(false);
    expect(coversBasicLatin(undefined)).toBe(true);
  });
});

describe("parseFontFaceCss", () => {
  it("extracts faces with resolved URLs, formats, weights and ranges", () => {
    const css = `@font-face{font-family:"__Inter_d65c78";src:url(__inter.woff2) format("woff2");font-weight:100 900;unicode-range:U+0000-00FF}
      @media (min-width:1px){@font-face{font-family:'Brand Serif';src:local("Brand"),url("ss3.woff2") format('woff2');font-style:italic}}
      .broken{color:`;
    expect(parseFontFaceCss(css, "https://site.example/assets/style.css")).toEqual([
      { family: "__Inter_d65c78", src: [{ url: "https://site.example/assets/__inter.woff2", format: "woff2" }], weight: "100 900", style: "normal", unicodeRange: "U+0000-00FF", baseUrl: "https://site.example/assets/style.css", origin: "network" },
      { family: "Brand Serif", src: [{ local: "Brand" }, { url: "https://site.example/assets/ss3.woff2", format: "woff2" }], weight: "400", style: "italic", baseUrl: "https://site.example/assets/style.css", origin: "network" },
    ]);
  });
});
```

- [ ] **Step 2: Run, see failures** **Step 3: Implement** (css-tree `parse` with `parseValue: false`, walk `Atrule` named `font-face`, parse declarations, default weight `400`, style `normal`). **Step 4: Run** (PASS) **Step 5: Commit** `feat(fonts): parse @font-face rules and unicode ranges`

### Task D2: Binary metadata, names and licence

**Files:** `src/server/scan/fonts/binary.ts`, `names.ts`, `license.ts` with tests

- [ ] **Step 1: Failing tests**
  - `binary.test.ts` using `tests/fixtures/site/assets/*.woff2`: `__inter.woff2` gives `format: "woff2"`, `familyName: "Inter"`, `coversLatin: true`, a copyright containing `Inter Project Authors`, and axes including `wght`; `ss3.woff2` gives `familyName` `Source Sans 3`; random bytes give `null`.
  - `names.test.ts` table from `discovery-lab.md` 3.2: (`__Inter_d65c78`, binary `Inter`) gives `Inter`; (`NotionInter`, `Inter`) gives `Inter`; (`GeistSans`, `Geist`) gives `Geist`; (`Mona Sans`, nameId1 `Mona Sans ExtraLight`) gives `Mona Sans`; (`sohne-var`, typoFamily `Söhne VF`) gives `Söhne VF`; (`Geograph`, familyName `Copyright Klim Type Foundry`) gives `Geograph`; (`wf_1a2b3c4d5e6f7a8b9c`, `Akzidenz-Grotesk BQ`) gives `Akzidenz-Grotesk BQ`; (`Waldenburg-75357948a2b6a39b`, no binary) gives `Waldenburg`; binary name `.` is rejected; (`Brand Serif`, `Source Sans 3`) gives `Brand Serif` with `embeddedName: "Source Sans 3"`.
  - `license.test.ts`: licence text `This Font Software is licensed under the SIL Open Font License, Version 1.1` gives `open`; `Licensed under the Apache License, Version 2.0` gives `open`; a copyright with a commercial foundry licence URL gives `commercial`; no text gives `unknown`; source `google-fonts` gives `open`; source `adobe-fonts` gives `commercial`.
- [ ] **Step 2: Run, see failures** **Step 3: Implement** (fontkit `create(buffer)` inside try/catch, name records 0/1/13/14/16/21, `postscriptName`, `variationAxes`, `OS/2.usWeightClass`, character set check for `A` and `a`; `resolveFamilyName` and helpers verbatim from the lab; `classifyLicense`). **Step 4: Run** (PASS) **Step 5: Commit** `feat(fonts): read font binaries, resolve family names and classify licences`

### Task D3: Google Fonts matching and convertibility

**Files:** `src/server/scan/fonts/google.ts`, `src/server/scan/fonts/index.ts` (`isConvertibleFont`), tests with a fake `SafeFetch`

- [ ] **Step 1: Failing tests**: `matchGoogleFamilies(["Inter", "Brand Serif", "Source Sans 3"], { fetch })` where the fake returns 200 for `family=Inter` and `family=Source+Sans+3` and 400 otherwise gives a map `Inter -> Inter`, `Source Sans 3 -> Source Sans 3`; at most 8 names are requested; a throwing fetch gives an empty map. `isConvertibleFont(meta)` is true for an OFL meta without network, true for an unknown-licence meta whose family matches Google Fonts, false for a commercial meta, false for `null`.
- [ ] **Step 2: Run, see failures** **Step 3: Implement** (spec section 9, `https://fonts.googleapis.com/css2?family=<name with + for spaces>`, 2 s timeout, 5-minute in-memory cache per family). **Step 4: Run** (PASS) **Step 5: Commit** `feat(fonts): match Google Fonts families and decide TTF convertibility`

### Task D4: Build font families

**Files:** `src/server/scan/fonts/index.ts`, `tests/integration/fonts/families.test.ts`

- [ ] **Step 1: Failing golden test** on the fixture (load the page with local Chrome, run a minimal inline collector for `document.fonts`, text usage and CSSOM `@font-face`, or reuse `tests/integration/assets/harness.ts` if Track C is merged locally; otherwise construct `RawCollectorOutput` font fields from a JSON fixture recorded once from the page and committed as `tests/fixtures/fonts/fixture-collector.json`), plus captured fonts parsed with `parseFontBinary`, and a fake `fetch` for Google checks (200 for `Inter` and `Source Sans 3`). Expect `FontFamily[]` (validated with `FontFamily.parse`):
  - `Inter`: `cssFamilies: ["__Inter_d65c78"]`, `source: "self-hosted"`, `usedOnPage: true`, `googleFamily: "Inter"`, `license.kind: "open"`, `convertible: true`, `downloadable: true`, one face `100 900` normal `loaded: true` with two files (one `coversLatin: true`), axes with `wght`;
  - `Brand Serif`: `usedOnPage: true`, `googleFamily: "Source Sans 3"`, `convertible: true`;
  - `Unused Face`: `usedOnPage: false`, one face with `loaded: false`, files listed but no bytes;
  - families sorted by `usage` descending, then used before unused;
  - `buildFontFamilies` signs nothing: every file comes out with `proxy: ""`; after `signFontFiles(families, signer)` (as the engine calls it once the assets are signed, spec 11.2) every remote file has a signed `proxy`;
  - a second case adds an `Inline Face` `@font-face` whose `src` is a `data:font/woff2;base64,` URI of `ss3.woff2`: its family has `source: "data-uri"` and one file with `inline.base64` equal to the file bytes, `url` and `proxy` both `""`, and nothing signed for it.
- [ ] **Step 2: Run, see failures** **Step 3: Implement** spec section 9 (grouping stages 1 to 3, faces keyed by css family, weight, style, stretch; source classification by host; usage shares; Adobe `downloadable: false`; licence; Google matching of display names and embedded names; no signing inside `buildFontFamilies` (every file keeps `proxy: ""`, since it runs in parallel with `assembleAssets` and must not spend the shared cap first), plus the exported `signFontFiles(families, signer)` the engine calls afterwards (files of loaded faces, then Basic-Latin files of unloaded faces, then the rest; returns true when the cap left a file unsigned); `data:` files decoded, base64 or percent-encoded, into `inline` with empty `url` and `proxy`, as the `FontFile` comment in the contract says; the `fonts` line is not batched, so inline files can take it past the 256 KB line target). **Step 4: Run** (PASS) **Step 5: Commit** `feat(fonts): build font families with faces, usage, source and licence`

### Task D5: PR

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration
git push -u origin feat/fonts && gh pr create --title "feat: font extraction, naming and licensing" --body "Track D of the v1 plan."
```

---

## Phase 1, Track E: Palette (branch `feat/palette`)

Owns: `src/server/scan/inpage/palette.src.ts`, `src/server/scan/palette/*`, `tests/integration/palette/*`, `tests/fixtures/palette/*`.

Port `palette-lab/verify/src-v2/` with every fix enabled. Do not commit third-party site screenshots; commit recorded signal JSON only.

### Task E1: Color math, PNG decoding, quantization

**Files:** `src/server/scan/palette/color.ts`, `png.ts`, `quantize.ts` with tests

- [ ] **Step 1: Failing tests**: `hexToRgb("#533afd")` is `[83, 58, 253]`; `rgbToHex([83, 58, 253])` round-trips; `rgbToOklab`/`oklabToLch` of pure white gives `l ≈ 1`, `c ≈ 0`; `isNeutral` is true for `#061b31`-like dark navy and false for `#533afd`; `decodePng` on a PNG generated with sharp (4x4, known pixels) returns matching RGBA; `quantize` on a synthetic 100x100 image that is 70 percent `#ffffff` and 30 percent `#533afd` returns both colors with shares within 0.02; masks exclude a region; `ringColor` and `smoothness` match the lab behavior on synthetic inputs.
- [ ] **Step 2: Run, see failures** **Step 3: Port** the corresponding parts of `palette-post.ts` (split by responsibility). **Step 4: Run** (PASS) **Step 5: Commit** `feat(palette): add color math, PNG decoding and quantization`

### Task E2: Palette building

**Files:** `src/server/scan/palette/build.ts`, `build.test.ts`, `tests/fixtures/palette/*.signals.json`

- [ ] **Step 1: Failing tests**: copy the recorded `palette-lab/results/raw/*.signals.json` for stripe.com, linear.app, chain.link, spotify.com, coinbase.com and uniswap.org (whichever exist) into `tests/fixtures/palette/`. For the pixel sources, generate a small synthetic screenshot per site in the test (a 1440x900 raw RGBA buffer filled with the lab's recorded dominant background color and a 200x60 block of the expected brand color) instead of committing real screenshots. Run `buildPalette(signals, pixels, DEFAULT_CONFIG)` and assert that for at least 5 of the 6 sites some top-3 brand swatch hue is within 20 degrees of the expected brand (Stripe `#533afd`, Uniswap `#ff37c7`, Spotify `#1ed760`, Coinbase `#0052ff`, Chainlink `#0847f7`, Linear `#5e6ad2`). Assert the output shape for all: at most 6 brand, at most 5 neutrals, hex lowercase `#rrggbb`. Also `toContractPalette(palette)` maps lab roles to `Swatch` (drops `null` roles) and validates with `Palette.parse`.
- [ ] **Step 2: Run, see failures** **Step 3: Port** `buildPalette`, `DEFAULT_CONFIG`, all v2 fixes, `svgColors`, `dropBlends`, and add `toContractPalette`. If the lab code requires a screenshot, make `pixels` nullable and skip pixel-based sources when absent. **Step 4: Run** (PASS) **Step 5: Commit** `feat(palette): build brand palettes from recorded signals`

### Task E3: In-page signals and `extractPalette`

**Files:** `src/server/scan/inpage/palette.src.ts`, `src/server/scan/palette/index.ts`, `tests/integration/palette/extract.test.ts`

- [ ] **Step 1: Failing integration test** on the fixture site with local Chrome: after `goto` (nothing injected first), `extractPalette(page, { fetch: fakeFetch, signal, timeBudgetMs: 3000 })` returns a `Palette` where some brand swatch is within OKLab distance 0.08 of `#ff3366` or `#ee3333`, a neutral within 0.08 of `#141e28`, completes under 2 s, and leaves the DOM without `data-palette-hidden` attributes. A second fixture route `/consent.html` with a fixed OneTrust-like banner (`#onetrust-banner-sdk`) must not contribute its colors (banner is bright green `#00ff00`; assert no swatch near it).
- [ ] **Step 2: Run, see failures** **Step 3: Port** `palette-inpage.ts` into `palette.src.ts` as `globalThis.__assetsScraperPalette` (`collect`, `restore`, `decodeIconColors`), and `palette-node.ts` into `index.ts` with these changes: `extractPalette` opens its own isolated world (CDP `Page.createIsolatedWorld`, the main world only when that fails, spec 7.5) and evaluates a fresh copy of `PALETTE_SOURCE` there for each in-page call, so nothing is installed on the page and the engine never injects anything, fetch icon and manifest with `options.fetch` (not the context request API), respect `timeBudgetMs`, always restore overlays in `finally`, return `null` on any failure. **Step 4: Run** (PASS) **Step 5: Commit** `feat(palette): extract palettes from live pages`

### Task E4: PR

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration
git push -u origin feat/palette && gh pr create --title "feat: brand palette extraction" --body "Track E of the v1 plan."
```

---

## Phase 1, Track F: UI (branch `feat/ui`)

Owns: `src/app/{layout,page}.tsx`, `src/app/globals.css`, `src/app/robots.ts`, `src/components/**`, `src/lib/client/**`, `e2e/**`, `public/**`.

Build against the contract with mocked NDJSON. Create realistic fixtures from lab outputs (`discovery-lab/out-final/linear.app/result.json`, `stripe.com`, `framer.com`) converted to `ScanEvent` lines and committed as `e2e/fixtures/*.ndjson`. Remote asset URLs in fixtures must be replaced by local test routes (`/e2e-assets/...` served by Playwright `page.route`) so tests run offline. Follow spec section 12 for every screen, state, string and token.

### Task F1: Client libraries

**Files:** `src/lib/client/{scan-client,asset-bytes,zip,clipboard,recent,filters}.ts` with tests, `src/lib/client/store.ts` with tests

- [ ] **Step 1: Failing tests**
  - `scan-client.test.ts` (mock `fetch`): `startScan("linear.app", handlers)` POSTs JSON with `x-access-code` when stored; parses streamed events in order into `handlers.onEvent`; maps a JSON `ApiError` 429 to `onError({ code: "budget" })`; on an `error busy` event retries once after a jittered delay (fake timers) and reports `busy` if it happens again; `abort()` cancels the stream and calls no further handlers.
  - `asset-bytes.test.ts`: inline SVG returns a `image/svg+xml` Blob without network; inline base64 decodes; https remote tries direct CORS first and falls back to `proxy` on a thrown fetch or non-OK status; `http:` goes straight to the proxy; a failing proxy throws `AssetUnavailableError`; a `FontFile` with `inline` (a data URI font: `url` and `proxy` are `""`, the proxy cannot fetch `data:` and the CSP blocks fetching it) decodes without any fetch.
  - `filters.test.ts`: `sectionize(assets, fonts, { tab: "all", query: "", sort: "relevance" })` puts `site-logo`, `logo`, `favicon` in `logos`, small icons (longest rendered side <= 48) in `smallIcons`, `declaredOnly` in `stylesheets`, sorts by score; `tab: "svg"` has no `logos` section; `query` matches name, filename, URLs and font names case-insensitively; sort `largest`, `file-size`, `name`, `page-order` behave.
  - `store.test.ts`: `select`, `toggle`, `selectRange` over visual order, `selectAllVisible` excludes collapsed sections, `clearSelection`, selection survives tab change, `openDetail`/`next`/`previous` wrap within the visible list.
  - `zip.test.ts` (Node, client-zip works with `Response`): `buildZip(selection, host)` yields entries `linear.app-assets/svg/<filename>`, `images/`, `fonts/<family>/`, adds `.ttf` for convertible WOFF2 fonts through `proxy&fmt=ttf`, adds inline font files from their bytes (named from family, weight, style and format, never from the empty `url`) in their original format only, with no `.ttf` even when convertible, since `fmt=ttf` needs the proxy (spec 9), skips failed entries and reports them.
  - `recent.test.ts`: keeps the last 5 unique hosts, survives `localStorage` throwing.
- [ ] **Step 2: Run, see failures** **Step 3: Implement** (spec 12.1, 12.3 previews, 12.4, critic G3 `getAssetBlob`, client-zip `downloadZip` with an async generator and 6 concurrent fetches, `showSaveFilePicker` when available, zustand store). **Step 4: Run** (PASS) **Step 5: Commit** `feat(client): add scan client, asset bytes, filters, selection store and ZIP builder`

### Task F2: Design tokens and app shell

**Files:** `src/app/globals.css`, `src/app/layout.tsx`, `src/app/robots.ts`, `src/components/app-shell/top-bar.tsx`

- [ ] **Step 1:** Put the token block from spec 12.6 in `:root`, map them in `@theme inline` (colors, radii, fonts), add `.bg-grid` checkerboard, tabular numbers utility, reduced-motion rules. Keep the `@custom-variant dark` line (Task 0.1 step 7) so `dark:` utilities stay inert. `layout.tsx`: Geist Sans and Mono through `geist/font`, `metadata` with `title: "Assets Scraper"`, `robots: { index: false, follow: false }`. `robots.ts`: disallow `/`.
- [ ] **Step 2:** Render check: `pnpm dev`, open `http://localhost:3000` at 1470x956 with the browser tools, confirm Geist renders (computed font family starts with Geist) and there are no console CSP errors.
- [ ] **Step 3: Commit** `feat(ui): add light design tokens and app shell`

### Task F3: Landing and scanning states

**Files:** `src/app/page.tsx`, `src/components/landing/*`, `src/components/scan/*`, `e2e/landing.spec.ts`, `e2e/scanning.spec.ts`

- [ ] **Step 1: Failing E2E tests**
  - landing shows the title, subline, focused input with placeholder `linear.app`, `Scan` button, `Try` chips; submitting `stripe.com` navigates to `/?url=https%3A%2F%2Fstripe.com%2F`; an invalid input shows `Enter a web address, like linear.app`; pasting `linear.app` with no field focused starts a scan; `Recent` chips appear after a scan.
  - scanning with a mocked slow stream shows the steps in order with a spinner on the current one, the elapsed counter, `Cancel` returns to the landing with the URL kept, the tab title is `Scanning stripe.com`, the queue step text `Waiting for a free browser` appears only after a `step queue` event, and the 20 s line appears (fake clock).
- [ ] **Step 2: Run, see failures** (`pnpm test:e2e e2e/landing.spec.ts e2e/scanning.spec.ts`) **Step 3: Implement** spec 12.2 landing and scanning. **Step 4: Run** (PASS) **Step 5: Commit** `feat(ui): add landing and scanning states`

### Task F4: Results grid, sections, cards, palette strip, brand links

**Files:** `src/components/results/*`, `e2e/results.spec.ts`

- [ ] **Step 1: Failing E2E tests** on the linear fixture: header meta, `Copy link`, `Rescan`, `Download all`; palette strip with swatches, clicking one copies its hex (clipboard permission granted) and shows the toast `Copied #5e6ad2`; brand link chips come from the last `page` event (the fixture sends an early `page` with empty `brandLinks`, then the final one; the client replaces, never merges) and a chip starts a scan of that URL; tabs with counts and keys `1` to `4`; `Logos` section first in `All` and absent in `SVG`; `Small icons` collapsed with `Show`; search with `/` filters and shows `Nothing matches "zzz"` with `Clear search`; sort changes order; background control changes tile backgrounds; tiles show filename and mono meta; a remote image that 404s falls back to the proxy URL (assert the `src` changes); no scraped SVG markup is present in the DOM (`page.locator("main svg[data-scraped]")` count 0 and no element contains the fixture's unique path data); `9 hidden: tracking pixels and spacer images` footer; partial banner for a `done partial` fixture.
- [ ] **Step 2: Run, see failures** **Step 3: Implement** spec 12.2 results and 12.3 cards, grid breakpoints, `content-visibility`, lazy previews, tone mapping, footer text built from the `HiddenReason` keys of `stats.hidden` (unknown keys count toward the total). **Step 4: Run** (PASS) **Step 5: Commit** `feat(ui): add results grid, sections, cards, palette strip and brand links`

### Task F5: Fonts rows

**Files:** `src/components/results/font-row.tsx`, `e2e/fonts.spec.ts`

- [ ] **Step 1: Failing E2E tests** with a fixture family pointing to a local WOFF2 route: the specimen line renders in the loaded font (computed `font-family` contains the unique alias and `document.fonts.check` is true); weights summary text; `Download` triggers a download of the file; `Download TTF` exists only when `convertible`; an Adobe Fonts family shows the `Adobe Fonts` link and no download; a failing font shows `Preview unavailable`.
- [ ] **Step 2: Run, see failures** **Step 3: Implement** spec 12.3 font rows. **Step 4: Run** (PASS) **Step 5: Commit** `feat(ui): add font rows with live specimens`

### Task F6: Detail view

**Files:** `src/components/detail/*`, `e2e/detail.spec.ts`

- [ ] **Step 1: Failing E2E tests**: clicking a card opens the modal with name, badge, metadata, counter `1 of N`; `←`/`→` navigate within the current tab and search; `Esc` closes and focus returns to the card; `D` downloads (download event with the asset filename); `C` on an SVG copies the markup (clipboard text starts with `<svg`); `O` opens the source in a new page for remote files and does nothing for inline SVGs; `&asset=<id>` in the URL opens the detail after results load and closing removes it; `Download as displayed` appears only when `aspectChanged`; the `Code` block shows markup as text; at 390x844 the detail is a full-screen sheet.
- [ ] **Step 2: Run, see failures** **Step 3: Implement** spec 12.2 detail and 12.5 keys. **Step 4: Run** (PASS) **Step 5: Commit** `feat(ui): add asset detail view with keyboard navigation`

### Task F7: Selection bar and ZIP

**Files:** `src/components/selection/*`, `e2e/selection.spec.ts`

- [ ] **Step 1: Failing E2E tests**: checkbox click, `Cmd+click`, `Shift+click` range, `Cmd+A` select all visible, `Esc` clears; the floating bar shows `3 selected · <size>`; `Download ZIP` produces a download named `linear.app-assets.zip` whose entries (read with `unzipper`-free check: parse the central directory with a small helper in the test, or use `client-zip` output length and `yauzl` if already available; otherwise save the file and list entries with `unzip -l` through `child_process`) are exactly the selected files under `svg/`, `images/`, `fonts/`; a failing entry produces the toast `1 file couldn't be downloaded` with `Show`; `Download all` in the header zips the current tab and excludes collapsed small icons.
- [ ] **Step 2: Run, see failures** **Step 3: Implement** spec 12.4. **Step 4: Run** (PASS) **Step 5: Commit** `feat(ui): add selection bar and ZIP downloads`

### Task F8: Errors, access code, blocked fallback

**Files:** `src/components/scan/error-panel.tsx`, `src/components/scan/access-code-dialog.tsx`, `e2e/errors.spec.ts`

- [ ] **Step 1: Failing E2E tests**: every row of the spec section 13 table renders its exact title, line and actions from a mocked response (gate JSON errors and stream `error` events); `access-code` shows the code field, `Continue` retries with the header and stores the code; `blocked` with fallback assets shows `From public sources` cards; `Copy debug info` copies JSON containing `scanId`; zero assets shows its empty state; ZIP partial failure toast.
- [ ] **Step 2: Run, see failures** **Step 3: Implement**. **Step 4: Run** (PASS) **Step 5: Commit** `feat(ui): add error states, access code prompt and blocked-site fallback`

### Task F9: Responsive and visual QA

- [ ] **Step 1:** Screenshot tests (`e2e/visual.spec.ts`, not pixel-compared, saved as artifacts) at 1470x956, 1024x768 and 390x844 for landing, scanning, results, detail, selection bar, error.
- [ ] **Step 2:** Review the screenshots against spec 12.6 (columns per breakpoint, gutters, no horizontal scroll, top bar sticky, readable previews) and fix issues.
- [ ] **Step 3: Commit** `test(ui): add responsive screenshot suite`

### Task F10: PR

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e
git push -u origin feat/ui && gh pr create --title "feat: results UI, selection and ZIP" --body "Track F of the v1 plan."
```

---

## Phase 2: Integration (branch per merge, then `chore/integration`)

### Task 2.1: Merge tracks

- [ ] **Step 1:** Merge PRs in order A, D, E, C, B, F. Before each merge: rebase the branch on `main`, resolve conflicts (only stub files should conflict: keep the implementation), `pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration`, push, CI green, squash-merge.
- [ ] **Step 2:** After B is merged, the engine uses the real collectors. Run `pnpm test:integration` and fix wiring issues on `chore/integration`.

### Task 2.2: End-to-end on the fixture

**Files:** `tests/integration/engine/fixture-e2e.test.ts`

- [ ] **Step 1: Failing test**: `scanEngine.scan({ url: fixture.origin + "/" })` with `SCAN_TEST_ALLOW_HOSTS` set yields `done` (not partial), `assets` satisfying the Task C6 golden assertions, `fonts` satisfying Task D4, a non-null `palette`, two `page` events where the first has empty `brandLinks` and the last has `brandLinks` with `Press kit`, and `diagnostics.collector === "isolated"`.
- [ ] **Step 2: Run, fix, pass. Step 3: Commit** `test(engine): add full fixture scan test`

### Task 2.3: Reference sites locally

**Files:** `scripts/scan-sites.mjs`

- [ ] **Step 1:** Write a script that POSTs to a base URL (`--base http://localhost:3000` or production) for each URL in a list (the 23 lab sites: allbirds.com, apple.com, binance.com, chain.link, coinbase.com, framer.com, g2.com, gatsbyjs.com, gymshark.com, ilovechickpea.ca, linear.app, medium.com, notion.com, porsche.com, ripple.com, sanity.io, squarespace.com, stripe.com, techcrunch.com, uniswap.org, vercel.com, webflow.com, xrpl.org), sends `x-ops-token` from `OPS_TOKEN`, reads NDJSON, and writes `scan-results/<host>.json` plus a summary table: status, duration, counts per kind, fonts, palette brand hexes, site-logo found, hidden counts, partial, error code, diagnostics phases.
- [ ] **Step 2:** Run it against `pnpm dev` with `OPS_TOKEN` set. Compare with `discovery-lab/table.md` and the palette results: site logo found on every unblocked site, counts in the same range, palette top color matches the lab for the palette sites, g2.com gives `blocked` with fallback assets.
- [ ] **Step 3:** Fix regressions (each fix with a test when the cause is reproducible offline). **Step 4: Commit** `chore: add reference site scan script` and the fixes, PR, merge.

### Task 2.4: Manual UI pass locally

- [ ] **Step 1:** With the browser tools at 1470x956, scan stripe.com, linear.app, framer.com and apple.com through the UI. Check previews, logos first, palette, fonts specimens, detail, Copy SVG code pasted into a text field, selection, ZIP contents (`unzip -l`), no console errors, no CSP violations.
- [ ] **Step 2:** Fix issues found, PR, merge.

---

## Phase 3: Deploy and production validation

### Task 3.1: Link and configure the Vercel project

- [ ] **Step 1:** Link the repo to project `assets-scraper` (`prj_hcr6ADAVOD0Y9FWbjoZqTvhgcGHD`, team `gamween-7559s-projects`) with `pnpm dlx vercel@latest link --yes --project assets-scraper --scope gamween-7559s-projects --token "$VERCEL_TOKEN"` (token from `~/.config/counsel/deploy.env`, never printed).
- [ ] **Step 2:** Set production env through the Vercel API or CLI: `ASSET_URL_SECRET` (48 random bytes base64url), `OPS_TOKEN` (48 random bytes base64url, also saved to `~/.config/assets-scraper/ops.env` with mode 600, never committed).
- [ ] **Step 3:** Firewall: create one rate-limit rule on `/api/scan` (20 requests per 10 minutes per IP, action deny with 429) through the Vercel Firewall API; if Hobby does not allow it through the API, record that and rely on the budget.
- [ ] **Step 4:** Confirm BotID works for the production domain (Vercel dashboard or API setting if required by botid 1.5.11).

### Task 3.2: Deploy

- [ ] **Step 1:** `pnpm dlx vercel@latest deploy --prod --yes --token "$VERCEL_TOKEN" --scope gamween-7559s-projects` from a clean checkout of `main` (remote build, never `--prebuilt`).
- [ ] **Step 2:** Check the build output: `/api/scan` function includes `chromium.br` once (about 84 MB function), the `functions` glob applied (`maxDuration` 120, cancellation).
- [ ] **Step 3:** `curl https://assets-scraper.vercel.app/api/health` returns the commit SHA.

### Task 3.3: Production checks

- [ ] **Step 1:** Run `scripts/scan-sites.mjs --base https://assets-scraper.vercel.app` with `OPS_TOKEN`. Record cold and warm timings, partial rates, errors, `diagnostics` (memory, `/tmp`, egress). All unblocked sites must finish under 60 s without `internal` errors.
- [ ] **Step 2:** SSRF probes with the ops token: `http://127.0.0.1/`, `http://169.254.169.254/latest/meta-data/`, `http://[::1]/`, `http://127.0.0.1.nip.io/`, `https://httpbin.org/redirect-to?url=http://127.0.0.1/`, `http://0x7f000001/`, `https://assets-scraper.vercel.app/` must all return `blocked-address` or `own-host` (gate) or an `error` event with those codes (preflight).
- [ ] **Step 3:** Asset proxy abuse probes: unsigned `u` gives 403, cross-site `Sec-Fetch-Site` gives 403, HTML upstream gives 415.
- [ ] **Step 4:** Browser check of the production UI at 1470x956 (scan linear.app, open detail, select 3 assets, download ZIP).
  Read the browser console on page load and during the scan: there must be no CSP violation. BotID's client loads Kasada scripts (`p.js`, `c.js`) from its same-origin rewrite path, and the production CSP has no `'unsafe-eval'` or `'wasm-unsafe-eval'`; if those scripts are blocked, every scan fails with `bot` 403. Then add only the keyword they need to `script-src` in `next.config.ts` (prefer `'wasm-unsafe-eval'` over `'unsafe-eval'`) and redeploy.
- [ ] **Step 5:** Open item from spec 17: run the same site list with `CHROMIUM_MULTIPROCESS=1` (if implemented as a launch toggle in Track B) and compare memory, CPU and `/tmp`; keep the better default.

---

## Phase 4: Review and hardening

### Task 4.1: Adversarial review

- [ ] **Step 1:** Review the merged code with independent reviewers per lens: security (SSRF paths, proxy, XSS, secrets, gate order), correctness (engine phases, deadlines, cancellation, contract conformance), extraction quality (fixture and reference results vs spec 8), fonts and licensing, UI against spec 12 (screens, copy, keys, responsive, accessibility), performance (bundle size, memory, 500-asset scroll). Each finding needs a concrete failure scenario and is verified by a second reviewer who tries to refute it.
- [ ] **Step 2:** Fix confirmed findings, each with a test when reproducible, PRs, merge.
- [ ] **Step 3:** Repeat until a review round finds nothing new.

### Task 4.2: Final deploy and report

- [ ] **Step 1:** Deploy `main` to production, run Task 3.3 checks again.
- [ ] **Step 2:** Update README with usage, the production URL, limits and env vars.

---

## Self-review against the spec

| Spec section | Tasks |
|---|---|
| 2 Decisions, 3 Scope | 0.1 to 0.7, all tracks |
| 4 Architecture, `ScanBackend` | 0.5, B7, B8 |
| 5 Modules | 1 File structure, 0.5 stubs |
| 6 Contract | 0.3, 0.4 |
| 7.1 Gate | A6, B8 |
| 7.2 Phases | B5, B7 |
| 7.3 Browser | B2 |
| 7.4 Capture | B4 |
| 7.5 In-page code | 0.5 bundler, B3, C5, E3 |
| 8.1 to 8.8 Extraction | C1 to C6 |
| 8.9 Block and fallback | B1, B6, B7, F8 |
| 9 Fonts | D1 to D4, A7 (TTF), F5 |
| 10 Palette | E1 to E3, F4 |
| 11.1 SSRF | A1 to A3, 3.3 |
| 11.2 Proxy | A4, A7, 3.3 |
| 11.3 Budgets and switches | A5, A6, 3.1 |
| 11.4 XSS | F4 (no markup in DOM), F6, 0.2 headers |
| 11.5 Low profile | 0.2 headers, F2 robots |
| 12 UI | F1 to F9 |
| 13 Errors | A6, B7, F8 |
| 14 Limits | 0.5 |
| 15 Testing | every task, 2.2, 2.3, 3.3, 4.1 |
| 16 Deployment | 0.2, 3.1 to 3.3 |
| 17 Open items | 3.1 step 4, 3.3 step 5, A5 |

Additions to the spec made by this plan: `OPS_TOKEN` (ops header that skips BotID and budget for the reference-site script), `fmt=ttf` on the asset proxy with a server-side licence check, `FontFaceInfo` naming, and a Google Fonts match counting as an open licence for conversion.
