/**
 * Shapes of the in-page palette signals (`palette.src.ts` imports these as types only).
 */

export type PaletteSource =
  | "bg" | "text" | "border" | "svg" | "cta" | "link" | "grad" | "logo" | "var" | "meta" | "icon" | "shot" | "pix";

export interface PaletteSignalOptions {
  /** Hard cap on elements visited (DOM order, so the top of the page first). */
  maxElements?: number;
  /** Time budget for overlay hiding and for the DOM walk, ms. */
  walkBudgetMs?: number;
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

/** What `palette.src.ts` installs as `globalThis.__assetsScraperPalette`. */
export interface PaletteInPage {
  collect(options: PaletteSignalOptions): RawPaletteSignals;
  /** Removes every `data-palette-hidden` attribute and the hiding stylesheet. */
  restore(): void;
  /** Rasterizes icon bytes (PNG, ICO, JPEG, WebP, GIF) at 64 px: [#rrggbb, opaque pixel count][]. */
  decodeIconColors(arg: { b64: string; mime: string }): Promise<[string, number][]>;
}
