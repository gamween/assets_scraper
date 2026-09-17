"use client";

import { useRef, useState, type CSSProperties } from "react";
import { cn } from "@/components/common/cn";
import type { Asset, Tone } from "@/lib/contract";
import { previewSrc } from "@/lib/client/asset-bytes";
import type { Background } from "@/lib/client/filters";
import { inlinePreviewUrl } from "@/lib/client/preview-urls";

export type WellBackground = "light" | "dark" | "grid" | "plain";

/** Spec 12.3 Auto: light assets show on the dark color, dark on light, opaque on the plain well, the rest on the grid. */
export function wellBackground(tone: Tone, override: Background): WellBackground {
  if (override !== "auto") return override;
  switch (tone) {
    case "light":
      return "dark";
    case "dark":
      return "light";
    case "opaque":
      return "plain";
    default:
      return "grid";
  }
}

export const WELL_CLASSES: Record<WellBackground, string> = {
  light: "bg-preview-light",
  dark: "bg-preview-dark",
  grid: "bg-grid",
  plain: "bg-well",
};

/**
 * Vectors scale to 76 percent of the well, at most 6x their size. Rasters are never enlarged beyond 2x.
 * The box is sized in CSS and the image fits inside it with `object-fit: contain`.
 */
function frameStyle(asset: Asset, variant: "tile" | "detail"): CSSProperties {
  const source = variant === "tile" ? (asset.display ?? asset.original) : (asset.original ?? asset.display);
  const width = source?.width ?? asset.width;
  const height = source?.height ?? asset.height;
  if (asset.kind === "svg") {
    const box = variant === "tile" ? "76%" : "82%";
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
 * referrer, then through the signed proxy when that fails; `http:` goes through the proxy from the start.
 * Remount with `key={asset.id}` to reset the fallback state for another asset.
 *
 * GIF tiles draw their first frame on a canvas once the image has loaded, then unmount the image: it only mounts again
 * while `playing` (the card is hovered), and covers the still frame once loaded.
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

  const stillReady = gifTile && still === "ready";
  const frame = frameStyle(asset, variant);

  return (
    <>
      {!stillReady || playing ? (
        <img
          src={src}
          alt=""
          draggable={false}
          referrerPolicy="no-referrer"
          loading={variant === "tile" ? "lazy" : "eager"}
          decoding="async"
          style={frame}
          className={cn(
            "block max-h-full max-w-full object-contain transition-opacity duration-[120ms] ease-enter select-none",
            gifTile && "peer/gif [grid-area:1/1]",
            stillReady ? "opacity-0 data-loaded:opacity-100" : gifTile && still === "pending" ? "opacity-0" : loaded ? "opacity-100" : "opacity-0",
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
            "pointer-events-none block max-h-full max-w-full object-contain transition-opacity duration-[120ms] ease-enter [grid-area:1/1]",
            stillReady ? "opacity-100 peer-data-loaded/gif:opacity-0" : "opacity-0",
            still === "unavailable" && "hidden",
          )}
        />
      ) : null}
    </>
  );
}
