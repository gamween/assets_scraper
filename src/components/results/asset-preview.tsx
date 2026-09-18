"use client";

import { useRef, useState, type CSSProperties } from "react";
import { cn } from "@/components/common/cn";
import type { Asset, Tone } from "@/lib/contract";
import { previewSrc } from "@/lib/client/asset-bytes";
import type { Background } from "@/lib/client/filters";
import { inlinePreviewUrl } from "@/lib/client/preview-urls";

export type WellBackground = "light" | "dark" | "grid" | "plain";

/**
 * Spec 12.3 Auto: light assets show on the dark color, dark on light, and everything else on the plain well.
 *
 * `mixed` and `unknown` used to take the checkerboard, which is most of what a page holds: on stripe.com the 158 tiles
 * split into four well treatments that interleaved down every row, against spec 12.6's quiet neutral table, and a
 * JPEG landed on a checkerboard claiming a transparency the format cannot carry. Auto no longer picks the
 * checkerboard: a light or dark asset gets the ground it shows against, and the explicit `Grid` control is still
 * there for anyone looking at transparency.
 */
export function wellBackground(tone: Tone, override: Background): WellBackground {
  if (override !== "auto") return override;
  switch (tone) {
    case "light":
      return "dark";
    case "dark":
      return "light";
    default:
      return "plain";
  }
}

export const WELL_CLASSES: Record<WellBackground, string> = {
  light: "bg-preview-light",
  dark: "bg-preview-dark",
  grid: "bg-grid",
  plain: "bg-well",
};

/** The fraction of the detail well a preview fills. The detail dialog opens at a height computed from it. */
export const DETAIL_FRAME = 0.82;

/**
 * Vectors scale to 76 percent of the well, at most 6x their size. Rasters are never enlarged beyond 2x.
 * The box is sized in CSS and the image fits inside it with `object-fit: contain`.
 *
 * Both branches are percentages of the well, so the image is positioned absolutely inside it (see below): a grid item
 * resolves a percentage size against its grid area, an implicit row here, which is auto and makes the percentage
 * cyclic. The browser then drops it and keeps only the pixel half of the `min()`, so a 308 px tall raster painted at
 * 308 px inside a 164 px well and `overflow-hidden` cut half the artwork away.
 */
function frameStyle(asset: Asset, variant: "tile" | "detail"): CSSProperties {
  const source = variant === "tile" ? (asset.display ?? asset.original) : (asset.original ?? asset.display);
  const width = source?.width ?? asset.width;
  const height = source?.height ?? asset.height;
  if (asset.kind === "svg") {
    const box = variant === "tile" ? "76%" : `${DETAIL_FRAME * 100}%`;
    return { width: width ? `min(${box}, ${width * 6}px)` : box, height: height ? `min(${box}, ${height * 6}px)` : box };
  }
  const box = variant === "tile" ? "calc(100% - 24px)" : "calc(100% - 48px)";
  return { width: width ? `min(${box}, ${width * 2}px)` : box, height: height ? `min(${box}, ${height * 2}px)` : box };
}

type LoadState = "direct" | "proxy" | "failed";

/** Tile GIFs (spec 12.3, play on hover only): the first frame waits on a canvas until then. */
type StillState = "pending" | "ready" | "unavailable";

/**
 * The preview image of an asset. Inline SVG and inline bytes load from object URLs; remote files load directly with no
 * referrer, then through the signed proxy when that fails; `http:` goes through the proxy from the start. A source
 * past the signing cap (`proxy: ""`) only loads directly and shows `No preview` when that fails.
 * Remount with `key={asset.id}` to reset the fallback state for another asset.
 *
 * GIF tiles draw their first frame on a canvas once the image has loaded, then unmount the image: it only mounts again
 * while `playing` (the card is hovered), and covers the still frame once loaded. When no frame can be drawn, the tile
 * shows its format instead until hovered, so the animation still never runs on its own.
 *
 * The image is centred absolutely, so every caller must give it a positioned parent with a definite height.
 */
export function AssetPreview({ asset, variant, playing = false, className }: { asset: Asset; variant: "tile" | "detail"; playing?: boolean; className?: string }) {
  const source = variant === "tile" ? (asset.display ?? asset.original) : (asset.original ?? asset.display);
  const inlineUrl = asset.inline ? inlinePreviewUrl(asset) : null;
  const [state, setState] = useState<LoadState>("direct");
  const [loaded, setLoaded] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gifTile = variant === "tile" && asset.format === "gif";
  const [still, setStill] = useState<StillState>("pending");

  const direct = inlineUrl ?? (source ? previewSrc(source) : null);
  const src = state === "direct" ? direct : state === "proxy" ? (source?.proxy ?? null) : null;

  if (!src) {
    return (
      <div className={cn("flex flex-col items-center gap-1 text-center", className)}>
        <span className="font-mono text-mono-xs font-medium text-text-3">{asset.format.toUpperCase()}</span>
        <span className="text-small text-text-3">No preview</span>
      </div>
    );
  }

  const frame = frameStyle(asset, variant);
  const showImage = !gifTile || still === "pending" || playing;

  return (
    <>
      {showImage ? (
        <img
          src={src}
          alt=""
          draggable={false}
          referrerPolicy="no-referrer"
          loading={variant === "tile" ? "lazy" : "eager"}
          decoding="async"
          style={frame}
          className={cn(
            "absolute top-1/2 left-1/2 block max-h-full max-w-full -translate-x-1/2 -translate-y-1/2 object-contain transition-opacity duration-[120ms] ease-enter select-none",
            gifTile && "peer/gif",
            !gifTile ? (loaded ? "opacity-100" : "opacity-0") : still === "pending" ? "opacity-0" : "opacity-0 data-loaded:opacity-100",
            className,
          )}
          onLoad={(event) => {
            const image = event.currentTarget;
            image.dataset.loaded = "";
            setLoaded(true);
            if (!gifTile || still !== "pending") return;
            const canvas = canvasRef.current;
            try {
              const context = canvas?.getContext("2d");
              if (!canvas || !context || !image.naturalWidth) throw new Error("No canvas");
              canvas.width = image.naturalWidth;
              canvas.height = image.naturalHeight;
              // Canvas draws use the first frame of an animated image (HTML spec), whatever frame is on screen.
              context.drawImage(image, 0, 0);
              setStill("ready");
            } catch {
              setStill("unavailable");
            }
          }}
          onError={() => {
            setLoaded(false);
            // Inline previews and proxied sources have no further fallback.
            setState(state === "direct" && !inlineUrl && source?.proxy && source.proxy !== direct ? "proxy" : "failed");
          }}
        />
      ) : null}
      {gifTile ? (
        <canvas
          ref={canvasRef}
          aria-hidden="true"
          data-testid="gif-still"
          data-state={still}
          style={frame}
          className={cn(
            "pointer-events-none absolute top-1/2 left-1/2 block max-h-full max-w-full -translate-x-1/2 -translate-y-1/2 object-contain transition-opacity duration-[120ms] ease-enter",
            still === "ready" ? "opacity-100 peer-data-loaded/gif:opacity-0" : "opacity-0",
            still === "unavailable" && "hidden",
          )}
        />
      ) : null}
      {gifTile && still === "unavailable" ? (
        <span
          data-testid="gif-placeholder"
          className="pointer-events-none font-mono text-mono-xs font-medium text-text-3 transition-opacity duration-[120ms] ease-enter [grid-area:1/1] peer-data-loaded/gif:opacity-0"
        >
          GIF
        </span>
      ) : null}
    </>
  );
}
