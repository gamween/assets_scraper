/**
 * Shapes of the in-page palette signals (`palette.src.ts` imports these as types only).
 */

export type PaletteSource =
  | "bg" | "text" | "border" | "svg" | "cta" | "link" | "grad" | "logo" | "var" | "meta" | "icon" | "shot" | "pix";

export interface PaletteSignalOptions {
  /** Hard cap on elements visited (DOM order, so the top of the page first). */
  maxElements?: number;
  /** Time budget for the DOM walk, ms (default 600). */
  walkBudgetMs?: number;
  /** Separate time budget for finding the overlays to hide, ms (default 300). */
  overlayBudgetMs?: number;
  /** Hide consent banners, modal dialogs and full-screen backdrops (for the walk and the screenshot). */
  hideOverlays?: boolean;
}

/** CSS px in the viewport. */
export type RectTuple = [x: number, y: number, width: number, height: number];
export type MediaKind = "img" | "video" | "canvas" | "iframe" | "bgimg";
export type MediaRect = [x: number, y: number, width: number, height: number, kind: MediaKind];

export interface RawPaletteSignals {
  url: string;
  vw: number;
  vh: number;
  docH: number;
  /** Aggregated samples: [source, #rrggbb, weight, elementCount]. */
  samples: [PaletteSource, string, number, number][];
  /** Brand-like CSS custom properties: [name, #rrggbb, nameScore]. */
  vars: [string, string, number][];
  meta: {
    themeColor: string | null;
    tileColor: string | null;
    maskIconColor: string | null;
    manifestTheme: string | null;
    manifestBackground: string | null;
  };
  /** Raster, video, canvas, iframe and background-image content, for screenshot masking. */
  mediaRects: MediaRect[];
  /** `<img>` and background-image logos: their colors are sampled from the screenshot. */
  logoImageRects: RectTuple[];
  /** DOM backdrop color behind the logo, left out when sampling logo pixels. */
  logoBackdrop: string | null;
  logoFound: boolean;
  /** Best icon candidates (apple-touch-icon first), then the conventional /apple-touch-icon.png. */
  iconUrls: string[];
  manifestUrl: string | null;
  stats: { visited: number; walkMs: number; hidden: number; truncated: boolean };
}

/** What `palette.src.ts` installs as `__assetsScraperPalette` on the object that shadows `globalThis` (`palette/index.ts`). */
export interface PaletteInPage {
  collect(options: PaletteSignalOptions): RawPaletteSignals;
  /** Shows the hidden overlays again: puts back each one's `style` attribute and removes `data-palette-hidden`. */
  restore(): void;
  /** Rasterizes icon bytes (PNG, ICO, JPEG, WebP, GIF) at 64 px: [#rrggbb, opaque pixel count][]. */
  decodeIconColors(arg: { b64: string; mime: string }): Promise<[string, number][]>;
}

const HEX = /^#[0-9a-f]{6}$/;
/** Sources the in-page collector produces (`icon`, `shot` and `pix` are added in Node). */
const INPAGE_SOURCES = new Set<string>(["bg", "text", "border", "svg", "cta", "link", "grad", "logo"]);
const MEDIA_KINDS = new Set<string>(["img", "video", "canvas", "iframe", "bgimg"]);
const MAX_SAMPLES = 20_000;
const MAX_VARS = 400;
const MAX_MEDIA_RECTS = 2_000;
const MAX_LOGO_RECTS = 20;
const MAX_ICON_URLS = 3;
const MAX_ICON_COLORS = 4_096;
const MAX_URL_LENGTH = 2_048;
const MAX_VAR_NAME_LENGTH = 100;

const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isHex = (v: unknown): v is string => typeof v === "string" && HEX.test(v);
const hexOrNull = (v: unknown): string | null => (isHex(v) ? v : null);
const isHttpUrl = (v: unknown): v is string => typeof v === "string" && v.length <= MAX_URL_LENGTH && /^https?:\/\//i.test(v);
const isRect = (v: unknown): v is RectTuple => Array.isArray(v) && v.length >= 4 && v.slice(0, 4).every(isNumber);
const entries = (v: unknown): unknown[][] => (Array.isArray(v) ? v.filter(Array.isArray) : []);

/**
 * Validates what the page returned. Page scripts can tamper with in-page code, so every list and string is capped and
 * every malformed entry dropped: build time and size stay bounded and a bad color never fails the palette. Returns null
 * when the value is not signals at all.
 */
export function readSignals(value: unknown): RawPaletteSignals | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (!isNumber(v.vw) || !isNumber(v.vh) || v.vw <= 0 || v.vh <= 0) return null;
  const meta = (v.meta && typeof v.meta === "object" ? v.meta : {}) as Record<string, unknown>;
  const stats = (v.stats && typeof v.stats === "object" ? v.stats : {}) as Record<string, unknown>;
  return {
    url: typeof v.url === "string" && v.url.length <= MAX_URL_LENGTH ? v.url : "",
    vw: v.vw,
    vh: v.vh,
    docH: isNumber(v.docH) ? v.docH : v.vh,
    samples: entries(v.samples)
      .filter((s) => INPAGE_SOURCES.has(s[0] as string) && isHex(s[1]) && isNumber(s[2]) && s[2] > 0 && isNumber(s[3]))
      .slice(0, MAX_SAMPLES)
      .map((s) => [s[0], s[1], s[2], s[3]] as RawPaletteSignals["samples"][number]),
    vars: entries(v.vars)
      .filter((s) => typeof s[0] === "string" && s[0].length <= MAX_VAR_NAME_LENGTH && isHex(s[1]) && isNumber(s[2]))
      .slice(0, MAX_VARS)
      .map((s) => [s[0], s[1], s[2]] as [string, string, number]),
    meta: {
      themeColor: hexOrNull(meta.themeColor),
      tileColor: hexOrNull(meta.tileColor),
      maskIconColor: hexOrNull(meta.maskIconColor),
      manifestTheme: null,
      manifestBackground: null,
    },
    mediaRects: entries(v.mediaRects)
      .filter((r) => MEDIA_KINDS.has(r[4] as string) && isRect(r))
      .slice(0, MAX_MEDIA_RECTS)
      .map((r) => r.slice(0, 5) as MediaRect),
    logoImageRects: entries(v.logoImageRects).filter(isRect).slice(0, MAX_LOGO_RECTS).map((r) => r.slice(0, 4) as RectTuple),
    logoBackdrop: hexOrNull(v.logoBackdrop),
    logoFound: v.logoFound === true,
    iconUrls: (Array.isArray(v.iconUrls) ? v.iconUrls : []).filter(isHttpUrl).slice(0, MAX_ICON_URLS),
    manifestUrl: isHttpUrl(v.manifestUrl) ? v.manifestUrl : null,
    stats: {
      visited: isNumber(stats.visited) ? stats.visited : 0,
      walkMs: isNumber(stats.walkMs) ? stats.walkMs : 0,
      hidden: isNumber(stats.hidden) ? stats.hidden : 0,
      truncated: stats.truncated === true,
    },
  };
}

/** Validates the in-page icon decoding result: [#rrggbb, count][]. */
export function readIconColors(value: unknown): [string, number][] {
  return entries(value)
    .filter((c) => isHex(c[0]) && isNumber(c[1]) && c[1] > 0)
    .slice(0, MAX_ICON_COLORS)
    .map((c) => [c[0], c[1]] as [string, number]);
}
