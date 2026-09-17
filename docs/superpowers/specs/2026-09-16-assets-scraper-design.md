# Assets Scraper: design

- Date: 2026-09-16
- Status: approved
- Scope: v1

## 1. Purpose

Paste a website URL and get every SVG, image and font on that page, plus the brand color palette. Preview everything, select what you need and download one file or a ZIP of the selection.

The main use is building pitch decks, and the main destination is Figma. The tool replaces a dead third-party app that "did not always work", because it parsed raw HTML without rendering JavaScript. This one renders the page in a real headless Chromium.

## 2. Decisions

| Topic | Decision |
|---|---|
| Theme | Light only |
| UI language | English, short factual copy. Never an em dash, no decorative emojis |
| Access | Public URL, no accounts. Abuse controls live on the server. An optional shared access code can be switched on with an env var |
| Deck target | Figma. SVG files and "Copy SVG code" matter most. No PNG conversion, no copy-as-image |
| Extras | Brand color palette. Selection-first ZIP (only what you tick goes in the ZIP) |
| Hosting | Vercel Hobby, Fluid compute, region `iad1`, Node 24. The scan engine stays host-agnostic so it can move to a container host without UI changes |
| Rendering | `playwright-core` 1.63.0 driving `@sparticuz/chromium` 153.0.0 in production, local Google Chrome in development |
| Target screen | 1470 CSS px wide (MacBook Air 13.6"), responsive down to phones |

## 3. Scope

### In v1

- Real-browser scan with lazy-load scrolling, network capture and an in-page collector.
- SVG: inline (normalized so the standalone file looks exactly like the page), SVG files, data-URI SVGs, CSS-background SVGs, referenced sprite symbols, SVGs inside open shadow roots and same-origin iframes.
- Images: every rendered and lazy source, CSS images, icons, manifest icons, social images, JSON-LD logos, network-only images, `blob:` and `data:` images. Size variants merged. Originals recovered behind image CDNs and verified.
- Fonts: families with clean names, faces, files, licence, used or only declared. Specimen rendered with the real font. TTF download only for open licences.
- Brand palette: brand colors and neutrals, click to copy hex.
- Brand resource links found on the page (press kit, brand, logos), one click to scan them.
- Results UI: sections, tabs, search, sort, preview background control, detail view, grid selection, ZIP of the selection, single downloads, Copy SVG code, shareable `/?url=` link, recent scans.
- Security: SSRF protection for Chromium and every server fetch, signed asset proxy, rate limit, bot protection, scan budget, kill switch.
- Blocked sites: honest error plus assets from public sources (favicon service, Wikidata logo, readable page head).

### Out of v1

PNG conversion or copy, video, Lottie, 3D, design tokens, server-side history, accounts, cross-origin iframe collection, closed shadow roots, a second mobile-viewport pass, SVG optimization, canvas or WebGL capture, Google Fonts full-family download (a link to the specimen page is enough), embedding web fonts into SVGs that contain text.

## 4. Architecture

```
Browser (Next.js client UI)
  |  POST /api/scan {url}  ->  200 application/x-ndjson (one ScanEvent per line)
  |  GET  /api/asset?u&e&s[&dl]   signed byte proxy, used only as a fallback
  |  direct CORS fetch to asset hosts first (bytes for ZIP, fonts, SVG code)
  v
Vercel Function /api/scan (Node 24, maxDuration 120, supportsCancellation)
  gate: WAF rule -> POST + JSON + same-origin -> zod -> BotID -> kill switch / access code -> budget -> URL policy
  pipeline (hard deadline 90 s):
    preflight safeFetch (DNS/SSRF check, HTML check, page head for fallbacks)
    per-instance semaphore (1 browser per instance)
    per-scan egress proxy on 127.0.0.1 (every Chromium request goes through it)
    launch Chromium (hardened flags, pidfile, no core dumps)
    navigate -> block detection -> load -> lazy scroll -> back to top -> finish animations -> fonts.ready
    palette collector (in-page, isolated world) + viewport screenshot
    asset collector (in-page, isolated world) + network capture results
    close Chromium, kill on failure
    post-processing in Node: fonts, CDN originals + verification, declared URL probes,
      noise, variants, roles, naming, tone, signing, palette post-processing
    emit page, palette, assets, fonts, done
```

The scan engine (`src/server/scan`) exposes one function and does not import anything from Next.js:

```ts
export interface ScanBackend {
  scan(input: { url: string }, options: { signal: AbortSignal }): AsyncIterable<ScanEvent>;
}
```

The route handler is a thin adapter that runs the gate and writes events as NDJSON. The same engine could run in a Playwright container later.

## 5. Modules

| Path | Responsibility | Depends on |
|---|---|---|
| `src/lib/contract.ts` | Zod schemas and TypeScript types for every event, asset, font, palette, error code. Shared by server and client | zod |
| `src/lib/url.ts` | Input normalization (client and server) | none |
| `src/lib/format.ts` | Bytes, dimensions, counts formatting | none |
| `src/lib/ndjson.ts` | NDJSON encoder (server) and streaming line decoder (client) | contract |
| `src/server/config/limits.ts` | Every limit and budget in one place, env-overridable | none |
| `src/server/net/ip.ts` | `isPublicIp`, `resolvePublicHost`, own-host checks | ipaddr.js |
| `src/server/net/safe-fetch.ts` | undici Agent with checked DNS lookup, manual redirects re-validated, byte and time caps | undici, ip |
| `src/server/net/egress-proxy.ts` | Per-scan HTTP/CONNECT proxy that pins checked IPs, ports 80/443 only, byte and socket caps | ip |
| `src/server/security/sign.ts` | HMAC signing and verification of asset proxy URLs | node:crypto |
| `src/server/security/budget.ts` | `BudgetStore` interface with Upstash, Vercel Runtime Cache and in-memory implementations | limits |
| `src/server/security/gate.ts` | Request gate for `/api/scan` (origin, body, BotID, kill switch, access code, budget, URL policy) | botid, budget, url, ip |
| `src/server/browser/launch.ts` | Hardened Chromium launch, pidfile kill, `/tmp` sweep, health check, semaphore, `withBrowser` | playwright-core, @sparticuz/chromium |
| `src/server/scan/engine.ts` | `ScanBackend` implementation, phases, deadlines, cancellation, diagnostics | everything below |
| `src/server/scan/preflight.ts` | First fetch of the page through `safeFetch`, content-type check, head parsing | safe-fetch |
| `src/server/scan/navigate.ts` | goto, load waits, lazy scroll, animations, block detection hook | playwright-core |
| `src/server/scan/capture.ts` | Network response capture with bounded body reads | playwright-core |
| `src/server/scan/block.ts` | `detectBlock` | none |
| `src/server/scan/fallback.ts` | Public-source assets for blocked sites | safe-fetch |
| `src/server/scan/inpage/collector.src.ts` | In-page asset collector and SVG normalizer (browser code) | none (bundled) |
| `src/server/scan/inpage/palette.src.ts` | In-page palette signal collector (browser code) | none (bundled) |
| `src/server/scan/inpage/run.ts` | Runs a bundled collector in a CDP isolated world, main-world fallback | playwright-core, generated bundles |
| `scripts/build-inpage.mjs` | Bundles the two `.src.ts` files with esbuild into IIFE strings in `src/server/scan/inpage/generated/` | esbuild |
| `src/server/scan/post/parse.ts` | srcset, `url()`, `image-set()` parsers | none |
| `src/server/scan/post/cdn.ts` | `originalCandidates`, `variantKey` | none |
| `src/server/scan/post/verify.ts` | Original verification and declared URL probes | safe-fetch |
| `src/server/scan/post/noise.ts` | Noise rules and reasons | none |
| `src/server/scan/post/variants.ts` | Union-find merge of size variants | cdn |
| `src/server/scan/post/roles.ts` | Roles, logo score, relevance score, small-icon rule | none |
| `src/server/scan/post/naming.ts` | Display names and unique sanitized filenames | none |
| `src/server/scan/post/tone.ts` | Preview tone from captured bytes and SVG markup | sharp |
| `src/server/scan/post/assemble.ts` | Builds final `Asset[]` from candidates, signs URLs | all post modules, sign |
| `src/server/scan/fonts/*.ts` | `@font-face` parsing, binary parsing, family naming, grouping, licence, Google Fonts check | css-tree, fontkit, safe-fetch |
| `src/server/scan/palette/*.ts` | Palette post-processing and node-side extras (icon, manifest, screenshot quantization) | none |
| `src/app/api/scan/route.ts` | Gate, then stream engine events as NDJSON | gate, engine, ndjson |
| `src/app/api/asset/route.ts` | Signed byte proxy | sign, safe-fetch, budget |
| `src/app/api/health/route.ts` | Build SHA, disabled flag, access code required flag | none |
| `src/lib/client/scan-client.ts` | POST, stream decode, cancel, retry once on `busy`, access code header | ndjson, contract |
| `src/lib/client/asset-bytes.ts` | `getAssetBlob`: inline bytes, else direct CORS fetch, else proxy | contract |
| `src/lib/client/zip.ts` | ZIP of a selection with client-zip, streaming save when available | client-zip, asset-bytes |
| `src/lib/client/woff2.ts` | Lazy WOFF2 to TTF conversion | wawoff2 |
| `src/lib/client/clipboard.ts` | Safari-safe text copy | none |
| `src/lib/client/store.ts` | UI state: scan state, results, filters, selection, detail | zustand |
| `src/components/**` | UI components | shadcn (Base UI), lucide-react |

## 6. Contract

`src/lib/contract.ts` defines these shapes with zod and exports the inferred types. Everything that crosses the network is validated on the client in development and trusted in production.

```ts
export type StepId = "queue" | "open" | "load" | "scroll" | "collect" | "process";

export type ErrorCode =
  | "invalid-url" | "blocked-address" | "unsupported-port" | "own-host"
  | "rate-limited" | "budget" | "disabled" | "access-code" | "bot"
  | "busy" | "dns" | "connect" | "http" | "blocked" | "not-html" | "timeout" | "internal";

export type WarningCode = "partial" | "truncated" | "body-timeout" | "verify-skipped" | "collector-fallback";

export type AssetKind = "svg" | "image";
export type AssetRole = "site-logo" | "logo" | "favicon" | "social" | "icon" | "illustration" | "image" | "sprite-symbol";
export type Tone = "light" | "dark" | "mixed" | "opaque" | "unknown";
export type AssetFormat = "svg" | "png" | "jpg" | "webp" | "avif" | "gif" | "ico" | "bmp" | "other";
export type FoundIn =
  | "img" | "picture" | "lazy-attribute" | "noscript" | "video-poster" | "svg-image" | "object-embed"
  | "css-background" | "css-mask" | "css-pseudo" | "css-other" | "stylesheet"
  | "icon-link" | "manifest" | "og-image" | "twitter-image" | "json-ld"
  | "inline-svg" | "sprite-symbol" | "network" | "shadow-dom" | "iframe" | "public-source";

export interface AssetSource {
  url: string;            // absolute http(s) URL
  proxy: string;          // signed same-origin path: /api/asset?u=...&e=...&s=...
  format: AssetFormat;
  width?: number;
  height?: number;
  bytes?: number;
}

export interface Asset {
  id: string;             // sha1 of the variant key, or of the normalized SVG hash
  kind: AssetKind;
  role: AssetRole;
  name: string;           // human display name
  filename: string;       // unique in the scan, sanitized, with extension
  format: AssetFormat;
  foundIn: FoundIn[];
  visible: boolean;       // rendered on the page during the scan
  declaredOnly: boolean;  // only found in stylesheets
  order: number;          // first appearance in page order
  score: number;          // relevance, higher first
  usedCount: number;
  width?: number;         // intrinsic size of the best version
  height?: number;
  renderedWidth?: number;
  renderedHeight?: number;
  bytes?: number;
  tone: Tone;
  display: AssetSource | null;    // version shown on the page (tiles)
  original: AssetSource | null;   // best verified version (download, ZIP)
  aspectChanged?: boolean;        // original framing differs from display
  inline?: { mime: "image/svg+xml"; text: string } | { mime: string; base64: string };
  hasLiveText?: boolean;          // SVG with <text> in a web font
}

export interface FontFile {
  url: string;
  proxy: string;
  format: "woff2" | "woff" | "ttf" | "otf" | "eot" | "other";
  bytes?: number;
  unicodeRange?: string;
  coversLatin: boolean;
}

export interface FontFace {
  weight: string;         // "400" or "100 900"
  style: string;          // "normal" | "italic" | "oblique ..."
  stretch?: string;
  loaded: boolean;
  subfamily?: string;
  files: FontFile[];
}

export interface FontFamily {
  id: string;
  name: string;
  cssFamilies: string[];
  source: "google-fonts" | "adobe-fonts" | "self-hosted" | "third-party" | "data-uri";
  sourceHost?: string;
  license: { kind: "open" | "commercial" | "unknown"; text?: string; url?: string };
  convertible: boolean;   // TTF conversion offered (open licence or Google Fonts)
  downloadable: boolean;  // false for Adobe Fonts
  googleFamily?: string;  // exact Google Fonts family name when matched
  usedOnPage: boolean;
  usage: number;          // share of visible text characters, 0..1
  axes?: { tag: string; min: number; max: number; default: number }[];
  faces: FontFace[];
}

export interface Swatch { hex: string; role?: "primary" | "accent" | "background" | "surface" | "text" }
export interface Palette { brand: Swatch[]; neutrals: Swatch[] }

export interface PageInfo {
  requestedUrl: string;
  finalUrl: string;
  host: string;
  title: string;
  siteName?: string;
  favicon?: AssetSource;
  status: number;
  brandLinks: { href: string; text: string }[];
}

export interface ScanStats {
  assets: number; svg: number; images: number; fonts: number;
  hidden: Record<string, number>;   // noise reason -> count
  durationMs: number;
}

export interface Diagnostics {
  scanId: string;
  cold: boolean;
  phases: Record<string, number>;   // phase -> ms
  queueMs: number;
  tmpFreeMb?: number;
  memAvailableMb?: number;
  egress: { bytes: number; blocked: number };
  bodyTimeouts: number;
  blockReason?: string;
  collector: "isolated" | "main";
  version: string;                  // git SHA
}

export type ScanEvent =
  | { type: "accepted"; scanId: string; url: string }
  | { type: "step"; step: StepId; state: "start" | "done" }
  | { type: "page"; page: PageInfo }
  | { type: "palette"; palette: Palette | null }
  | { type: "assets"; items: Asset[] }          // batches, each line <= 256 KB
  | { type: "fonts"; families: FontFamily[] }
  | { type: "warning"; code: WarningCode; detail?: string }
  | { type: "done"; partial: boolean; stats: ScanStats; diagnostics: Diagnostics }
  | { type: "error"; code: ErrorCode; message: string; httpStatus?: number; fallback?: Asset[]; diagnostics?: Diagnostics };
```

Rules:

- Errors found by the gate, before streaming starts, return JSON `{ "error": { "code": ErrorCode, "message": string } }` with the HTTP status from section 13.
- Once streaming starts the HTTP status is 200 and failures arrive as an `error` event, which is always the last line.
- `assets` and `fonts` events arrive after all post-processing, so the client never patches an asset.
- Asset proxy: `GET /api/asset?u=<base64url url>&e=<unix seconds>&s=<hmac>[&dl=<filename>]`. Unknown parameters are rejected.

## 7. Scan pipeline

### 7.1 Gate (route handler, in order)

1. Vercel WAF rate-limit rule on `/api/scan`: 20 requests per 10 minutes per IP (one rule on Hobby).
2. Method POST, `content-type: application/json`, `Origin` equal to our own origin.
3. Body `{ url: string }` validated with zod, at most 2,048 characters.
4. `checkBotId()`; a bot gets `bot` (403).
5. `SCAN_DISABLED=1` gives `disabled` (503). When `ACCESS_CODE` is set, header `x-access-code` must match (timing-safe), otherwise `access-code` (401).
6. Budget: daily and monthly scan counters (`SCANS_PER_DAY`, `SCANS_PER_MONTH`). Over budget gives `budget` (429).
7. URL policy on the normalized URL: http or https, port 80 or 443, no credentials, not an own host, not a private IP literal.

### 7.2 Phases and budgets

The engine owns an `AbortController` tied to `request.signal` and to a hard deadline of 90 s from arrival. Every phase has its own cap. At the deadline the engine kills Chromium and emits what is ready with `partial: true`.

| # | Phase | Step event | Cap |
|---|---|---|---|
| 1 | Preflight `safeFetch` of the URL (manual redirects, 1 MB cap). Maps DNS, connect and private-address failures to error codes. A non-HTML response gives `not-html` with the URL as a single asset. A 403, 429 or 503 does not stop the scan | `open` start | 8 s |
| 2 | Semaphore (one scan per instance). Emits `step queue` while waiting | `queue` | 15 s, then `busy` |
| 3 | Start the egress proxy, launch Chromium | `open` | 20 s |
| 4 | `goto(url, domcontentloaded)`, then `detectBlock` | `open` done | 25 s |
| 5 | `waitForLoadState('load')`, then `networkidle` | `load` | 10 s and 3 s |
| 6 | `img[loading=lazy]` to eager, scroll `document.scrollingElement` by 0.85 viewport every 180 ms, idle, back to top, wait 300 ms | `scroll` | 8 s scroll, 2.5 s idle |
| 7 | Finish finite animations, `document.fonts.ready` | `collect` start | 2 s |
| 8 | Palette collector and viewport screenshot, then asset collector, both in an isolated world | `collect` | 15 s together |
| 9 | Settle pending body reads, close Chromium, stop the egress proxy | `collect` done | 5 s |
| 10 | Post-processing in Node, including original verification and declared URL probes | `process` | 8 s for network work |
| 11 | Emit `page`, `palette`, `assets` batches, `fonts`, `done` | | |

`page` is emitted twice. The first one goes out as soon as the title and final URL are known (after phase 4), so the UI can show the site header early; it has empty `brandLinks` and no `favicon`, which only exist after collection and post-processing. The second one, in phase 11, carries the brand links and the signed favicon. The client replaces its page info with each `page` event.

### 7.3 Browser

- Launch: sparticuz `args` minus `--disable-web-security`, `--allow-running-insecure-content` and `--disable-site-isolation-trials`, plus `--disable-blink-features=AutomationControlled`, `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`, `--hide-scrollbars`, `--mute-audio`. `chromium.setGraphicsMode = false`. `proxy: { server: "http://127.0.0.1:<egress port>" }`. Environment limited to `PATH`, `HOME`, `LD_LIBRARY_PATH`, `FONTCONFIG_PATH`, `TZ`.
- Wrapper script in `/tmp`: `ulimit -c 0`, writes its PID to a pidfile, then `exec` the binary. Before every launch: SIGKILL a stale PID, sweep `core.*`, `playwright_chromiumdev_profile-*` and `playwright-artifacts-*`, check `/tmp` free >= 250 MB and MemAvailable >= 900 MB, otherwise return `busy`.
- One browser per scan, never reused. `MAX_CONCURRENT_SCANS = 1` per instance.
- Context: viewport 1440x900, DPR 1, user agent `Chrome/<browser major>.0.0.0` without "HeadlessChrome", `locale: "en-US"`, `Accept-Language: en-US,en;q=0.9`, `bypassCSP: true`, `serviceWorkers: "block"`, `acceptDownloads: false`, `ignoreHTTPSErrors: true`. Media requests (`*.mp4`, `*.webm`, `*.m3u8`, `*.mov`) blocked through CDP.
- Local development uses `CHROME_EXECUTABLE_PATH` or the installed Google Chrome, with the same flags and the same egress proxy.
- A memory watchdog reads `/proc/meminfo` every 500 ms on Linux. Below 350 MB available it aborts the collector, kills Chromium and returns partial results.

### 7.4 Network capture

- Listener attached before `goto`. Captures images (`resourceType image` or `image/*`), fonts (`resourceType font`, font content types or font extensions) and stylesheets. Skips 3xx.
- Body reads: skipped above 15 MB `content-length`, 8 s per read, at most 24 concurrent reads, 250 MB total. Pending reads get 5 s to settle before the browser closes.
- Each image body is hashed (sha1), measured (sharp metadata) and toned (section 8.8), then dropped. SVG text up to 1 MB is kept. Font bytes are parsed (section 9) then dropped. CSS text is kept for parsing.
- Bytes are kept only for `blob:` images: 2 MB each, 16 MB total, sent to the client as base64 inline.

### 7.5 In-page code

- Written in TypeScript (`*.src.ts`) with no imports from the app, bundled by `scripts/build-inpage.mjs` with esbuild into an IIFE string. The build runs before `dev`, `build`, `test` and `typecheck` through explicit npm scripts.
- Executed with CDP `Page.createIsolatedWorld` and `Runtime.evaluate` (`returnByValue`). If the isolated world fails, run in the main world and report `collector: "main"` in diagnostics. Guard every use of `customElements`, which is null in isolated worlds.
- Returns plain JSON. Hard caps inside: 80,000 elements walked, 15 s time check, 400 unique SVG normalizations, 1 MB per SVG markup, 12 MB total inline SVG.

## 8. Extraction rules

The rules below were validated on 23 real sites and a local fixture page covering every edge case. The fixture page becomes the integration test site (`tests/fixtures/site/`).

### 8.1 Candidates

Walk every element in the document, in every open shadow root and in every readable same-origin iframe. Record a candidate per URL with its element group, `foundIn`, visibility, rendered rectangle, `alt`/`aria-label`/`title`, and context flags (in header, nav, footer, link to home, logo word, site word, logo wall).

- `<img>`: `currentSrc`, `src`, every `srcset` candidate (spec-style parser that keeps commas inside URLs), `naturalWidth/Height`.
- `<picture><source>`: sources that only differ by `type` join the group, `media` sources stay separate.
- Lazy attributes on `img` (`data-src`, `data-srcset`, `data-lazy-src`, `data-original`, `data-hi-res-src` and the rest of the lab list) and `data-bg`, `data-background`, `data-bg-src` on any element. JSON values are ignored.
- `<noscript>` contents parsed with `DOMParser`, marked not visible.
- `<video poster>`, SVG `<image href>`, `<object data>`, `<embed src>`, `<iframe src=*.svg>`, `<input type=image>`.
- Computed styles of every element and its `::before`/`::after`: `background-image`, `mask-image`, `-webkit-mask-image`, `border-image-source`, `list-style-image`, `-webkit-mask-box-image-source`, `content`. `image-set()` URLs share a group.
- Stylesheets: CSSOM for readable sheets (including adopted and shadow sheets, recursing into grouping rules), captured network CSS parsed with css-tree for the rest. CSS custom properties that hold `url()` count. URLs that were never rendered are `declaredOnly` and must pass a probe (section 8.4).
- Icons and meta: `link[rel~=icon|shortcut|apple-touch-icon|apple-touch-icon-precomposed|mask-icon|fluid-icon|image_src]`, web manifest icons (manifest fetched in Node), `og:image` variants, `twitter:image`, `msapplication-TileImage`, `itemprop=image`, JSON-LD `logo`. `/favicon.ico` is probed when no icon link exists.
- Inline SVG: top-level `<svg>` elements. Sprite sheets (only definitions) are expanded into their referenced symbols. Unreferenced symbols are counted in `hidden` but not listed.
- `blob:` URLs: network body first, then `fetch` inside the page, then canvas `toDataURL` for a still-loaded image.
- `data:` URIs: decoded. SVG data URIs join the SVG kind.
- Network-only images: every captured image response is a candidate.
- Brand links: same-site `<a>` whose href or text matches `/brand|press|media[- ]?kit|newsroom|logos?|guidelines/i`, at most 6.

### 8.2 Noise (dropped, counted by reason in `stats.hidden`)

- Tracker hosts (about 100 analytics and ads hosts) and tracking paths with a width of 2 px or less.
- Spacer names (`pixel|spacer|blank|transparent|clear|1x1|trans|empty` `.gif/.png`, `blank.jpg/webp/svg`).
- Decoded images of 2x2 px or less.
- Raster data URIs under 64 px on the longest side or under 1 KB.
- SVG data-URI placeholders with no drawable element, or blur placeholders.
- Responses that are not images (HTML error pages).
- Consent manager hosts and third-party widget hosts (reCAPTCHA, hCaptcha, Intercom, Drift, Zendesk, Cloudflare challenge, maps).
- Declared URLs whose probe failed, `blob:` URLs without bytes.
- Lottie frames, visible SVGs under 6 px, SVG markup over 1 MB.

### 8.3 Variants

Union-find over the remaining URLs. Two URLs merge when they share an element group (with the preferred-group rule for URLs shared by several elements and no merge for art-directed sources), share a `variantKey` (CDN original rule applied, presentational query parameters removed, `_small/_medium/_large/_xlarge`, `@2x`, `_2x` suffixes removed), or share the sha1 of captured bytes. Groups are then split by raster vs SVG. The best member is the largest by pixel area (captured bytes, then natural size, then declared size, then `w` descriptor, then `x` descriptor, then bytes).

### 8.4 CDN originals and verification

`originalCandidates(url, { pageUrl, server })` returns ordered rewrites, applied recursively up to depth 3. The observed URL is always the fallback.

Rules: Next.js `/_next/image?url=` under any base path, Vercel `/_vercel/image`, Netlify `/.netlify/images`, Astro `/_image?href=`, Nuxt IPX, Gatsby Image CDN `?u=`, Cloudflare `/cdn-cgi/image/`, Framer (drop query), Webflow `-p-<w>`, Wix `/v1/(fill|fit|crop)/`, Shopify (size params and suffixes), Squarespace (`?format=2500w`), Cloudinary upload and fetch (skip signed), imgix and imgix-backed DatoCMS and Prismic (skip signed), Unsplash (keep `ixid`), Sanity, Contentful (also by `Server` header), Storyblok, HubSpot, WordPress Jetpack params, WordPress `-WxH` and `-scaled`, Jetpack Photon, Ghost, Hugo, ImageKit, Builder.io (can turn into SVG), generic source-in-parameter proxy.

Verification: `safeFetch` GET with `Range: bytes=0-262143`, `Accept: image/png,image/jpeg,image/gif,image/svg+xml,*/*;q=0.5`, normal UA, `Referer` set to the page. Accept 2xx with `image/*`, or octet-stream after magic-byte sniffing. Read the full size from `content-range`. Pick the verified original. When the aspect ratio differs by more than 3 percent, set `aspectChanged` and keep the display version downloadable. When the content type becomes SVG, move the asset to the SVG kind. Declared URL probes use the same request. Budget: 8 s total, 16 concurrent, at most 150 declared probes.

### 8.5 Roles and relevance

- `logoScore` = logo word 3 + link to home 3 + header or nav 2 + site word 2 + top under 160 px and visible 1 + footer 1.
- `site-logo`: score >= 6, or a JSON-LD logo.
- `logo`: logo word, logo wall, or `alt` containing "logo".
- `favicon`: icon links, manifest icons, `/favicon.ico`.
- `social`: `og:image`, `twitter:image`.
- `icon`: longest rendered side <= 48 CSS px, or intrinsic side <= 48 px when not rendered. Logo and favicon roles are exempt. This is the single small-icon rule.
- `sprite-symbol` for expanded symbols, `illustration` for SVGs above the icon size, `image` otherwise.
- `score` = role weight (site-logo 1000, logo 500, favicon 300, social 200, illustration and image 100, sprite-symbol 20, icon 10) + min(rendered area / 1000, 90) + 50 when visible, minus 0.01 per page-order step.

### 8.6 Inline SVG normalization

For every top-level SVG, in the page:

1. Skip Lottie frames. Expand sprite sheets. Above 4,000 elements, resolve references but skip style inlining.
2. Deduplicate by `outerHTML` before the expensive work: at most 3 normalizations per identical markup, 400 per page.
3. Resolve references into a `<defs>`: external sprites (`fetch`, 4 s), local `href="#id"` and `url(#id)` in attributes, styles and `<style>`, up to 4 passes. Resolve `var()` presentation attributes through the live computed style.
4. Inline computed styles top-down: compare each property of `STYLE_PROPS` between the live element and the same element in a hidden same-origin `about:blank` sandbox iframe, set only the differences on the clone and the sandbox element. Properties authored with `var()` are always inlined. Skip layout and animation properties on the root, font properties when there is no text, and `color` unless the markup uses `currentColor`.
5. Root attributes: `xmlns`, `viewBox` when missing (numeric size, else rendered rect, else `getBBox()`), `width` and `height` from the rendered size, else from the `viewBox`.
6. Cleanup: remove root `display`, `visibility`, `opacity`, position, size, transform and animation from inline style; remove `on*`, `data-*`, `aria-*`, `role`, `focusable`, `tabindex`; remove `class` only without an inner `<style>`; remove custom properties and leftover `var()`; make external `href` absolute; remove `<script>`.
7. Serialize with `XMLSerializer`. Dedupe key: sha1 of the markup after renaming ids in order of appearance and collapsing whitespace. `usedCount` counts duplicates. Set `hasLiveText` when the SVG has text in a web font.

### 8.7 Naming

- Display name, first usable source: `aria-label`, `<title>`, `alt`, `data-framer-name`, `title` attribute, JSON-LD logo (`<Site> logo`), role default (`<Site> logo`, `<Site> favicon`, `<Site> social image`), link text of the wrapping anchor, decoded file basename without hash suffixes and CDN parameters, then `svg 12` or `image 12` by order.
- Filename: slug of the display name, prefixed with the site slug unless it already starts with it, at most 80 characters, the real extension, `-2`, `-3` on clashes. No `/`, `..` or control characters.

### 8.8 Tone

Tone decides the preview background of a tile.

- JPEG: `opaque` without decoding.
- Other rasters with captured bytes up to 3 MB: `sharp` resize to fit 32x32, read RGBA. At least 98 percent opaque pixels gives `opaque`. Otherwise mean luminance of non-transparent pixels (alpha-weighted, Rec. 709): above 0.7 gives `light` (show on dark), below 0.3 gives `dark` (show on light), else `mixed` (checkerboard).
- SVG: render the normalized markup with `sharp` at 64 px, same thresholds.
- No bytes, errors, or over the caps (300 rasters, 400 SVGs, 3 s total): `unknown`, shown on the checkerboard.

### 8.9 Block detection and fallback

`detectBlock(status, title, html, headers, elementCount)`:

- `cf-mitigated: challenge` header.
- Title matches `/just a moment|attention required|access denied|access to this page has been denied|are you a robot|verify you are (a )?human|please verify you are a human|pardon our interruption|request unsuccessful|security check|one more step|checking your browser/i`.
- Challenge markup (`cf-chl-`, `/cdn-cgi/challenge-platform/`, `captcha-delivery.com`, `px-captcha`, `_Incapsula_Resource`, `perimeterx.net`, `_pxAppId`, `ak-challenge`, `sec-cpt`) only when the status is 400 or more or the page has fewer than 60 elements.
- Captcha-only page (fewer than 80 elements with hCaptcha, reCAPTCHA or Turnstile).
- 403, 429 or 503 with fewer than 300 elements.

On a block: `error { code: "blocked", fallback }` where `fallback` contains assets with `foundIn: ["public-source"]` from the preflight page head (icons, `og:image`, JSON-LD logo), Google's favicon service (`https://www.google.com/s2/favicons?domain=<host>&sz=256`) and the Wikidata logo image (P154 of the item whose official website P856 matches the host, as a Wikimedia Commons file URL). Wikidata requests use the user agent `AssetsScraper/1.0 (+https://github.com/gamween/assets_scraper)` and nothing personal.

## 9. Fonts

- Collect `@font-face` rules from CSSOM and from captured CSS text (css-tree): family, `src` list, weight (single or range), style, stretch, `unicode-range`, base URL.
- Captured font files are the ground truth for what loaded. Files with no rule are grouped by binary name.
- `document.fonts` statuses give `loaded`. Visible text nodes give usage: the first family in each computed stack that has a loaded face, counted by characters.
- Unused declared faces are never downloaded during the scan.
- Grouping and naming: key by cleaned CSS family (Next.js `__Inter_d65c78` to `Inter`, build hashes removed), display name from the representative file through `resolveFamilyName` (CSS-first cross-check with the binary name read by fontkit, garbage names rejected), then merge groups that share a display name. Faces keyed by CSS family, weight, style and stretch.
- Source: `google-fonts` (fonts.gstatic.com, fonts.googleapis.com), `adobe-fonts` (use.typekit.net, p.typekit.net), `data-uri`, `self-hosted` (same site), `third-party` otherwise.
- Licence: fontkit name records 0, 13 and 14. `open` when they match `/SIL Open Font License|\bOFL\b|openfontlicense|scripts\.sil\.org\/OFL|Apache License|Ubuntu Font Licen[cs]e/i` or the source is `google-fonts`. `commercial` when a copyright or licence text exists and is not open. `unknown` otherwise.
- `convertible` = open licence. `downloadable` = not `adobe-fonts`.
- Google Fonts match: for each used family, `safeFetch` `https://fonts.googleapis.com/css2?family=<name>` with a 2 s timeout, at most 8 families. A 200 sets `googleFamily`.
- Variable axes from `fvar`.
- UI downloads: files as served (single file, or a small ZIP for several files). "Download TTF" converts WOFF2 in the browser with lazily loaded wawoff2, offered only when `convertible`. Adobe Fonts show the name and a link to fonts.adobe.com, no file.

## 10. Palette

The palette module is a port of the validated lab code (v2 with every fix enabled): in-page signal collection, node-side extras and post-processing.

- In-page: hide consent overlays and dialogs (including hosts outside `<body>` and zero-size fixed hosts), detect the logo, walk the DOM (8,000 elements or 600 ms) and record weighted color samples by source (`bg`, `text`, `link`, `cta`, `grad` with exclusive area, `svg`, `border`, `var`, `meta`, logo), normalizing every color through a 1x1 canvas and compositing alpha over the effective backdrop. Restore everything afterwards.
- Node: fetch the best icon and the web manifest through `safeFetch` (600 ms), take a viewport PNG screenshot while overlays are hidden, quantize it (5-bit histogram, media rects masked except full-viewport smooth backgrounds), pool vivid hues.
- Post: normalize shares per source, split neutral vs chromatic in OKLCh, cluster perceptually, score brand evidence, pick at most 6 brand colors and 4 neutrals (plus one slot for a dominant neutral covering at least 20 percent of the viewport), label roles only when confident.
- Output: `Palette { brand, neutrals }`. Added cost is about 200 ms per scan.

## 11. Security and abuse

### 11.1 SSRF

- Every Chromium request goes through the per-scan egress proxy. The proxy resolves DNS once, requires every A and AAAA record to be public, connects to the checked IP, allows only ports 80 and 443, denies own hosts, and caps 96 sockets and 400 MB per scan. Playwright proxies loopback too.
- Every Node request (preflight, verification, probes, manifest, icons, Google Fonts check, Wikidata, asset proxy) goes through `safeFetch` with the same `resolvePublicHost`: undici Agent with a checked `connect.lookup`, IP literals checked separately, `redirect: "manual"` with every hop re-validated (at most 5), timeouts and byte caps.
- `isPublicIp`: ipaddr.js `range() === "unicast"` after unwrapping IPv4-mapped IPv6, and an explicit block of `::/96` (IPv4-compatible), which ipaddr.js wrongly classifies as unicast.
- Own hosts: `VERCEL_URL`, `VERCEL_BRANCH_URL`, `VERCEL_PROJECT_PRODUCTION_URL`, `APP_HOSTS` (comma list) and, in production, `localhost`. This stops a scan from scanning the app itself.
- Tests only: `SCAN_TEST_ALLOW_HOSTS` accepts exact `host:port` pairs, honored only when `NODE_ENV !== "production"` and `VERCEL` is unset.

### 11.2 Asset proxy

- HMAC-SHA256 with `ASSET_URL_SECRET` over `v1\n<expiry>\n<url>`, truncated to 32 base64url characters, timing-safe comparison. Expiry is bucketed by hour, 6 to 7 hours of life, so CDN cache keys repeat. Development without the secret uses a random per-process key.
- At most 800 signed URLs per scan.
- `Sec-Fetch-Site` must be `same-origin` or `none`, with `Vary: Sec-Fetch-Site`.
- `safeFetch` with `Referer` set to the page origin, 25 MB cap, 20 s timeout, 5 redirects. Content types allowed: `image/*`, `font/*`, `application/font-*`, `application/x-font-*`, and `application/octet-stream` after magic-byte sniffing.
- Response headers: `content-security-policy: default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; sandbox`, `x-content-type-options: nosniff`, `cross-origin-resource-policy: same-origin`, `content-disposition` (attachment with the sanitized `dl` name, else inline), `cache-control: private, max-age=3600`, `vercel-cdn-cache-control: public, s-maxage=86400`.
- Daily proxied bytes budget (`PROXY_BYTES_PER_DAY`), taken before bytes are served: a known `content-length` in full, a body of unknown length in blocks of at least 1 MiB (the first before the status, the next whenever a chunk passes what the body holds). A take refused before the status gives 429; a block refused mid-body errors the stream. The unused part of the last block goes back when the body ends, fails or is cancelled (through `waitUntil`), so bodies in flight overshoot a store without atomic increments by at most one block each.
- The client uses the proxy only when direct access fails, and always for `http:` URLs.

### 11.3 Budgets and switches

- `BudgetStore.incr(key, by, ttlSeconds)` implementations (atomic increment that returns the new total; `takeScanBudget` and `takeProxyBytes` compare it with the limit), selected at runtime: Upstash Redis when `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` exist, Vercel Runtime Cache when available on the plan, otherwise in-memory per instance. If the store errors, fall back to the in-memory counter.
- Defaults: 80 scans per day, 800 per month, 300 MB proxied per day. All env-overridable.
- Kill switch `SCAN_DISABLED=1`. Optional `ACCESS_CODE`.
- BotID (basic) protects `POST /api/scan`, initialized in `instrumentation-client.ts`.

### 11.4 XSS and content safety

- Scraped SVG markup is never inserted into the DOM. Previews use `<img src="blob:...">` built from the markup. Code is shown as text.
- `blob:` URLs of scraped SVGs are never opened in a tab. "Open source" exists only for remote http(s) URLs, with `rel="noopener noreferrer"`.
- App headers: CSP `default-src 'self'; img-src 'self' blob: data: https:; font-src 'self' blob: data:; connect-src 'self' https:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'`, `X-Robots-Tag: noindex, nofollow`, `Referrer-Policy: strict-origin-when-cross-origin`. `robots.txt` disallows everything.
- ZIP entry names sanitized.

### 11.5 Low profile

No analytics, no public listing, `noindex` everywhere, no server-side storage of scans. The footer says "Scans aren't saved. Assets belong to their owners."

## 12. UI

### 12.1 Routes and state

- `/`: landing. `/?url=<encoded>` starts a scan after hydration. Submitting uses `history.pushState`. `&asset=<id>` opens that asset's detail after the scan.
- Local UI state (zustand): scan status, events, results, active tab, search, sort, preview background, selection, detail id. Sort and background are remembered in `localStorage` (try/catch). Recent scans: last 5 hosts.

### 12.2 Screens

**Landing.** Wordmark top left. Centered block at about 38 percent of the viewport height: title `Every SVG, image and font on a page.`, subline `Paste a URL. Download one file, a selection or everything.`, a 560 px input (placeholder `linear.app`, not `type="url"`) with the `Scan` button, `Try` chips (`stripe.com`, `linear.app`, `framer.com`), `Recent` chips when any. Paste anywhere (no focused field) with something URL-like starts a scan. Footer line.

**Scanning.** Switches to the results layout at once: the URL moves into the sticky 56 px top bar. A status block lists the steps `Opening <host>`, `Waiting for a free browser` (only when queued), `Waiting for the page to load`, `Scrolling to load lazy images`, `Collecting SVGs, images and fonts`, `Finding originals`, with checks, a spinner on the current step, an elapsed counter and `Cancel`. After 20 s: `Large pages can take up to a minute.` A static skeleton grid (12 tiles, no shimmer) sits below. The tab title follows the state (`Scanning linear.app`, `48 assets · linear.app`, `Scan failed · linear.app`).

**Results.**

- Header: favicon, page title, mono meta `linear.app · 48 assets · 11s`, actions `Copy link`, `Rescan`, `Download all`.
- Palette strip: brand swatches then neutrals, each a 32 px square with its hex in mono under it, click copies the hex, `Copy all` copies one `#hex role` per line.
- Brand links: `Brand resources on this site` chips that start a scan of that page.
- Sticky filter row: tabs `All`, `SVG`, `Images`, `Fonts` with counts, search `Filter by name or URL` (key `/`), sort (`Relevance`, `Page order`, `Largest`, `File size`, `Name`), background control `Auto · Light · Dark · Grid`.
- Sections in `All`: `Logos` (site-logo, logo, favicon), `SVG`, `Images` (social images lead with an `OG image` badge), `Fonts`, `Small icons` (collapsed, `Show`), `In stylesheets` (declared-only, collapsed), `Declared, not used` (fonts, collapsed). The type tabs show the same assets without the `Logos` section, with a `Logo` badge. A footer line counts hidden noise: `9 hidden: tracking pixels and spacer images`.
- Partial results show a banner: `Partial results. The page didn't finish loading.`

**Detail.** Modal 1120 px wide, preview left, 340 px info panel right; full-screen sheet on phones. Preview background control, previous and next arrows, counter `6 of 48` within the current tab and search. Info: name, role badge, actions with shortcut chips, metadata (`Format`, `Dimensions`, `File size`, `Found in`, `Used`, `Source`), and for SVG a collapsible `Code` block (text, 240 px max height).

- SVG actions: `Copy SVG code` (C), `Download SVG` (D), `Open source` (O, remote files only).
- Image actions: `Download` (D) with the real format, `Download as displayed` when `aspectChanged`, `Open source` (O).
- Font row actions: `Download` (file or small ZIP), `Download TTF` when `convertible`, `Copy name`, `Google Fonts` link when matched, `Adobe Fonts` link instead of downloads for Adobe.

**Errors.** Error panels replace the status block (copy in section 13). Blocked sites show `From public sources` assets under the message when any. `Copy debug info` copies the diagnostics JSON.

### 12.3 Cards

- Grid tiles share a frame: 1 px border, radius 8, 4:3 preview well, footer on the surface color with the filename (13 px, middle truncation that keeps the extension) and a mono meta line (`SVG · 88×22 · 3.0 KB · Inline`, `JPG · 1200×630 · 352 KB`).
- Role badge top left (`Logo`, `Favicon`, `OG image`). Checkbox top right, visible on hover and always once something is selected. Hover actions bottom right: `Copy SVG code` for SVG, `Download` for all.
- Previews: inline SVG and inline bytes through blob URLs, remote images through `<img src={display.url} referrerPolicy="no-referrer" loading="lazy" decoding="async">`, falling back to the proxy on error, `http:` always through the proxy. Vectors scale to 76 percent of the well, capped at 6x. Rasters are never enlarged beyond 2x. Animated GIFs play on hover only.
- Background: `Auto` maps tone `light` to the dark preview color, `dark` to light, `opaque` to the plain well, `mixed` and `unknown` to the checkerboard. The global control and the detail control override it.
- Font rows span the full width: specimen line in the real font (the page title, else an alphabet line) at 32 px, alphabet line at 16 px, family name, weights (`Regular 400, Medium 500, Bold 700` or `Variable 100 to 900`), format and size, source and licence badge, checkbox, actions. The font loads through `new FontFace(uniqueAlias, bytes)` from `getAssetBlob`. On failure: family name in the UI font with `Preview unavailable`.

### 12.4 Selection and ZIP

- Checkbox click or `Cmd/Ctrl+click` toggles, `Shift+click` selects a range in visual order, once something is selected a plain click toggles. Touch uses a `Select` button. `Cmd/Ctrl+A` selects everything visible in the current tab and search (collapsed sections excluded). `Esc` clears.
- Floating bar at the bottom center, 52 px, 12 px above the edge plus the safe area: `8 selected · 2.4 MB`, `Clear`, `Download ZIP`.
- `Download all` zips every asset of the current tab, small icons only when expanded.
- ZIP built in the browser with client-zip from an async generator, 6 fetches at a time through `getAssetBlob(asset, "original")`. `showSaveFilePicker` streaming when available, blob download otherwise, with a warning above 300 MB. Progress in the button (`Zipping 18 of 48`) and a `Cancel` link. Failed entries end in a toast (`2 files couldn't be downloaded`, `Show`).
- Layout: `<host>-assets/svg/`, `<host>-assets/images/`, `<host>-assets/fonts/<family>/`. Open-licence WOFF2 fonts also get a converted `.ttf` next to them.

### 12.5 Keyboard

`Cmd/Ctrl+V` scan the pasted URL (no field focused), `/` focus search, `1` to `4` tabs, `Enter` open detail, `Space` toggle selection, `Cmd/Ctrl+A` select all visible, `Esc` close detail or clear selection or clear search, `←` `→` previous and next in detail, `C` copy SVG code, `D` download, `O` open source.

### 12.6 Visual system ("Light table")

- The interface is a quiet neutral table; the only strong color on screen comes from the scraped assets. Near-black primary buttons, one cobalt accent for selection and focus. No gradients, glass, background animation or illustrations.
- Fonts: Geist Sans for UI, Geist Mono for metadata, URLs, counts and `kbd` chips (`geist` package, self-hosted). Tabular numbers everywhere a number changes.
- Type scale: display 32/38 600 (landing title), title 16/24 600, body 14/20, body-strong 14/20 500, small 13/18, mono 12/16, mono-xs 11/14 500, input-lg 16/24.
- Tokens:

```css
:root {
  --bg: #FAFAFA; --surface: #FFFFFF; --well: #F4F4F5;
  --border: #E4E4E7; --border-strong: #D4D4D8;
  --text: #18181B; --text-2: #52525B; --text-3: #6B6B73;
  --ink: #18181B; --ink-fg: #FAFAFA;
  --accent: #2B50E8; --accent-fg: #FFFFFF; --accent-soft: #E8EDFF;
  --danger: #C62828; --success: #1E7F3E; --warning: #9A5B00;
  --preview-light: #FFFFFF; --preview-dark: #141416;
  --grid-a: #FFFFFF; --grid-b: #EEEEF0;
  --shadow-float: 0 1px 2px rgb(0 0 0 / 0.06), 0 8px 24px rgb(0 0 0 / 0.10);
}
```

- Spacing scale 2, 4, 8, 12, 16, 24, 32, 48, 64, 96. Page gutter 32 (16 on phones), card padding 12, grid gap 16 (12 below 1024 px), section headers 32 above and 12 below.
- Radii: 4 badges, `kbd`, checkboxes; 6 buttons, inputs, tabs; 8 cards and wells; 12 dialog, selection bar, toasts.
- Flat surfaces; the float shadow only on the selection bar, dialog and toasts, always with a 1 px border.
- Grid columns: 7 at 1680 px and more (content max 1600), 6 from 1280 (reference: 1470 px gives 6 columns of about 221 px), 5 from 1024, 4 from 768, 3 from 480, 2 below. Explicit `repeat(N, minmax(0, 1fr))`.
- Motion: 100 ms hover and icon swaps, 150 ms fades, tabs and dialog, 200 ms selection bar and top bar. Enter `cubic-bezier(0.2, 0, 0, 1)`, exit `cubic-bezier(0.4, 0, 1, 1)`. Nothing loops except the spinner. Reduced motion: fades only.
- Performance: `content-visibility: auto` on sections, lazy previews with a 120 ms fade, no pagination (500 assets must scroll smoothly).

### 12.7 Copy rules

Sentence case. No em dash, no en dash, no exclamation marks, no emojis, never "Oops", "magic", "seamless", "effortless", "unlock", "supercharge", "in seconds", "AI".

## 13. Errors

| Code | HTTP (gate) | Title | Line | Actions |
|---|---|---|---|---|
| `invalid-url` | 400 | inline under the input: `Enter a web address, like linear.app` | | focus the input |
| `blocked-address` | 422 | `This address can't be scanned` | `Local and private network addresses are blocked.` | `Try another URL` |
| `unsupported-port` | 422 | `This address can't be scanned` | `Only ports 80 and 443 are supported.` | `Try another URL` |
| `own-host` | 422 | `This address can't be scanned` | `Assets Scraper can't scan itself.` | `Try another URL` |
| `rate-limited` | 429 | `Too many scans` | `Wait a few minutes and try again.` | `Try again` |
| `budget` | 429 | `Daily scan limit reached` | `Try again tomorrow.` | |
| `disabled` | 503 | `Scanning is paused` | `Try again later.` | |
| `access-code` | 401 | `Enter the access code` | | code field, `Continue` |
| `bot` | 403 | `The scan request was blocked` | `Reload the page and try again.` | `Reload` |
| `busy` | stream | `All browsers are busy` (after one automatic retry) | `Try again in a moment.` | `Try again` |
| `dns` | stream | `Couldn't find <host>` | `Check the address and try again.` | `Try again` |
| `connect` | stream | `Couldn't reach <host>` | `Check the address and try again.` | `Try again` |
| `http` | stream | `<host> returned <status>` | `The page may have moved.` | `Try again` |
| `blocked` | stream | `<host> blocked the scan` | `The site uses bot protection. Try another page on the site, or try again later.` | `Try again`, fallback assets |
| `not-html` | stream | `This URL is a file, not a page` | `You can download it directly.` | the single asset |
| `timeout` | stream | `The page took too long to load` | partial banner when assets exist | `Rescan` |
| `internal` | 500 or stream | `Something went wrong on our side` | | `Try again`, `Copy debug info` |
| zero assets | | `No SVGs, images or fonts on this page` | `Some sites only load content after sign-in.` | `Rescan` |
| empty tab | | `No fonts on this page` | | |
| no search match | | `Nothing matches "<query>"` | | `Clear search` |
| ZIP partly failed | | toast `2 files couldn't be downloaded` | | `Show` |

## 14. Limits

All in `src/server/config/limits.ts`, env-overridable.

| Limit | Value |
|---|---|
| WAF rule on `/api/scan` | 20 requests / 10 min per IP |
| Scans | 80 per day, 800 per month |
| Proxied bytes | 300 MB per day |
| Scan deadline | 90 s (function `maxDuration` 120) |
| Queue wait | 15 s |
| Egress per scan | 400 MB, 96 sockets |
| Body read | 15 MB each, 8 s each, 24 concurrent, 250 MB total |
| Blob bytes to client | 2 MB each, 16 MB total |
| Inline SVG | 1 MB each, 12 MB total, 400 normalizations |
| Assets per scan | 1,500 |
| Signed URLs per scan | 800 |
| Verification and probes | 8 s, 16 concurrent, 150 declared probes |
| Proxy response | 25 MB, 20 s |
| NDJSON line | 256 KB |

## 15. Testing

- **Unit (Vitest, node):** URL normalization (hash routes kept, IDN, credentials stripped, ports), `isPublicIp` edge table including `::7f00:1`, signing, NDJSON codec, zod schemas, srcset/`url()`/`image-set()` parsers, CDN rules (table-driven from verified samples), `variantKey`, noise rules, variants merge, roles and scores, naming and filename sanitizing, tone thresholds, `detectBlock` (recorded pages including a false positive), font family resolution and licence detection, unicode-range, palette post-processing on recorded signals, budget store, gate order.
- **Integration (Vitest, node, real Chrome):** the engine against the fixture site with golden expectations (every edge case listed in section 8), the SSRF suite (redirect to loopback, `nip.io` loopback, literal and IPv6 loopback, `0.0.0.0`, WebSocket, subresources) with zero hits on a victim server, a download URL, a never-ending body, an infinite-loop page (deadline kill and partial result), a heavy page (100k elements, 5k SVGs) within caps, own-host recursion.
- **E2E (Playwright test, `next start`):** mocked NDJSON streams for landing, progress, results, sections, search, sort, background control, detail navigation and keys, selection, ZIP download content, Copy SVG code (clipboard permission), every error state; plus one real scan of the fixture site through the running app.
- **Visual QA:** screenshots at 1470x956, 1024x768 and 390x844 of landing, scanning, results and detail, reviewed before release.
- **Production checks:** after each production deploy, a script scans the 23 reference sites and records counts, timings and diagnostics; SSRF probes against production must return `blocked-address` or produce no hit.
- **CI (GitHub Actions, ubuntu):** lint, typecheck, unit, integration (Chrome), E2E on every PR.

## 16. Deployment and operations

- Vercel project `assets-scraper` (existing), framework Next.js, Node 24.x, Fluid on, region `iad1`. Deploys through the Vercel CLI (remote builds on x64; never `--prebuilt` from Apple Silicon).
- `next.config.ts`: `outputFileTracingIncludes` for `/api/scan` with the real (symlink-resolved) paths of `@sparticuz/chromium/bin/**` and `playwright-core/browsers.json`; security headers; `typedRoutes`; React Compiler.
- `vercel.json`: `{ "fluid": true, "regions": ["iad1"], "functions": { "src/app/api/scan/route.ts": { "maxDuration": 120, "supportsCancellation": true } } }`.
- Env: `ASSET_URL_SECRET` (required in production), optional `SCAN_DISABLED`, `ACCESS_CODE`, `SCANS_PER_DAY`, `SCANS_PER_MONTH`, `PROXY_BYTES_PER_DAY`, `APP_HOSTS`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`.
- Firewall: one rate-limit rule (section 7.1), BotID enabled.
- Diagnostics travel in `done` and `error` events because Hobby keeps runtime logs for one hour. `GET /api/health` returns the build SHA and flags, never URLs.
- Dependency policy: `@sparticuz/chromium` and `playwright-core` pinned exactly and bumped together within a week of each Chrome security release.

## 17. Open items

- Measure whether Chromium CPU counts toward Active CPU on Hobby (dashboard usage after a known number of scans) and tune the daily budget.
- A/B single-process vs multi-process Chromium on Vercel during the first production validation (memory, CPU, `/tmp`).
- Confirm on the first deploy that the `functions` glob in `vercel.json` matches the route, that BotID works with a streaming POST, and whether Vercel Runtime Cache is available on Hobby.
