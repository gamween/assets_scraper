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

/**
 * The preview image of an asset. Inline SVG and inline bytes load from object URLs; remote files load directly with no
 * referrer, then through the signed proxy when that fails; `http:` goes through the proxy from the start.
 * Remount with `key={asset.id}` to reset the fallback state for another asset.
 */
export function AssetPreview({ asset, variant, className }: { asset: Asset; variant: "tile" | "detail"; className?: string }) {
  const source = variant === "tile" ? (asset.display ?? asset.original) : (asset.original ?? asset.display);
  const inlineUrl = asset.inline ? inlinePreviewUrl(asset) : null;
  const [state, setState] = useState<LoadState>("direct");
  const [loaded, setLoaded] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [still, setStill] = useState(false);

  const direct = inlineUrl ?? (source ? previewSrc(source) : null);
  const src = state === "direct" ? direct : state === "proxy" ? (source?.proxy ?? null) : null;
  const animatedTile = variant === "tile" && asset.format === "gif" && !inlineUrl;

  if (!src) {
    return (
      <div className={cn("flex flex-col items-center gap-1 text-center", className)}>
        <span className="font-mono text-mono-xs font-medium text-text-3">{asset.format.toUpperCase()}</span>
        <span className="text-small text-text-3">No preview</span>
      </div>
    );
  }

  return (
    <>
      <img
        src={src}
        alt=""
        draggable={false}
        referrerPolicy="no-referrer"
        loading={variant === "tile" ? "lazy" : "eager"}
        decoding="async"
        style={frameStyle(asset, variant)}
        className={cn(
          "block max-h-full max-w-full object-contain transition-opacity duration-150 ease-enter select-none",
          loaded ? "opacity-100" : "opacity-0",
          animatedTile && still && "opacity-0 group-hover/card:opacity-100",
          className,
        )}
        onLoad={(event) => {
          setLoaded(true);
          if (!animatedTile) return;
          const image = event.currentTarget;
          const canvas = canvasRef.current;
          if (!canvas || !image.naturalWidth) return;
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          canvas.getContext("2d")?.drawImage(image, 0, 0);
          setStill(true);
        }}
        onError={() => {
          setLoaded(false);
          // Inline previews and proxied sources have no further fallback.
          setState(state === "direct" && !inlineUrl && source?.proxy && source.proxy !== direct ? "proxy" : "failed");
        }}
      />
      {animatedTile ? (
        <canvas
          ref={canvasRef}
          aria-hidden="true"
          style={frameStyle(asset, variant)}
          className={cn("pointer-events-none absolute object-contain", still ? "opacity-100 group-hover/card:opacity-0" : "opacity-0")}
        />
      ) : null}
    </>
  );
}
