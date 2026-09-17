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

/** `proxy` is the signed `/api/asset` path, or "" past the per-scan signing cap (spec 11.2): direct fetch only. */
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
export type InlineSvg = z.infer<typeof InlineSvg>;

export const InlineBytes = z.object({ mime: z.string(), base64: z.string() });
export type InlineBytes = z.infer<typeof InlineBytes>;
// `InlineBytes.mime` is any string, so `mime` does not narrow `Asset.inline`: use `"text" in inline` (SVG markup)
// or `"base64" in inline` (bytes).

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

export const FontFormat = z.enum(["woff2", "woff", "ttf", "otf", "eot", "other"]);
export type FontFormat = z.infer<typeof FontFormat>;

/**
 * A remote font file has its absolute http(s) `url`, a signed `proxy` and no `inline`. Past the per-scan signing cap
 * (spec 11.2) its `proxy` is "": clients fetch it directly only, and mark it unavailable when that fails.
 * A file declared as a `data:` URI (family `source: "data-uri"`) has no network path: the asset proxy only fetches
 * http(s), and the app CSP (`connect-src 'self' https:`) blocks `fetch("data:...")`. Its bytes travel in `inline` as
 * base64, whatever the encoding of the URI was, and `url` and `proxy` are both "". Clients read `inline` first, as for
 * assets, and do not key or name files by `url`.
 * The `fonts` event is one line, not batched like `assets`, so inline files can take it past the `ndjsonLineBytes`
 * target (256 KB). That target is not a hard cap: clients read lines of any length.
 */
export const FontFile = z.object({
  url: z.string(),
  proxy: z.string(),
  format: FontFormat,
  bytes: z.number().optional(),
  unicodeRange: z.string().optional(),
  coversLatin: z.boolean(),
  inline: InlineBytes.optional(),
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

/**
 * Why a URL or SVG was dropped as noise (spec 8.1, 8.2). Producers count drops under these names in `ScanStats.hidden`
 * and the UI turns them into the footer line (spec 12.2). The record stays open, so an unknown key still validates.
 */
export const HiddenReason = z.enum([
  "tracker",             // tracker hosts, tracking paths 2 px wide or less
  "spacer",              // spacer file names (pixel.gif, blank.png)
  "pixel",               // decoded image of 2x2 px or less
  "tiny-data-uri",       // raster data URI under 64 px or under 1 KB
  "placeholder",         // SVG data URI with nothing drawable, blur placeholder
  "not-image",           // response that is not an image (HTML error page)
  "consent",             // consent manager host
  "widget",              // third-party widget host (reCAPTCHA, hCaptcha, Intercom, maps)
  "probe-failed",        // declared URL whose probe failed
  "probe-skipped",       // declared URL the scan ran out of probe budget to check
  "blob-unavailable",    // blob: URL without bytes
  "lottie-frame",        // SVG frame of a Lottie animation
  "tiny-svg",            // visible SVG under 6 px
  "svg-too-large",       // SVG markup over the size cap
  "unreferenced-symbol", // sprite symbol never referenced by <use>
]);
export type HiddenReason = z.infer<typeof HiddenReason>;

export const ScanStats = z.object({
  assets: z.number(),
  svg: z.number(),
  images: z.number(),
  fonts: z.number(),
  hidden: z.record(z.string(), z.number()), // HiddenReason -> count
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
  // Outcome of every CDN original probe (spec 8.4): a group that adopts none falls back to the page's own bytes,
  // which looks identical from the result whatever went wrong, so these counters are the only way to tell why.
  // `attempted` counts requests that went out; `captured` is the separate case of an original the page declared and
  // the browser already had, so no probe was needed.
  originals: z
    .object({ attempted: z.number(), adopted: z.number(), captured: z.number(), failed: z.number(), noise: z.number(), skipped: z.number() })
    .optional(),
  blockReason: z.string().optional(),
  // `none`: the collector never started (a blocked page, a failed navigation, a scan stopped before collection).
  collector: z.enum(["isolated", "main", "none"]),
  version: z.string(),
});
export type Diagnostics = z.infer<typeof Diagnostics>;

export const ScanEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("accepted"), scanId: z.string(), url: z.string() }),
  z.object({ type: z.literal("step"), step: StepId, state: z.enum(["start", "done"]) }),
  // Sent twice (spec 7.2). Early, after navigation, so the UI can show the site header: `brandLinks` is empty and
  // there is no `favicon`. Final, after post-processing and before `palette`: brand links from the collector and the
  // signed favicon. The client replaces its page info with each `page` event, so the last one wins.
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
