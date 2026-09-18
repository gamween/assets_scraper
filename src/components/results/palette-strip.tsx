"use client";

import { cn } from "@/components/common/cn";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Swatch } from "@/lib/contract";
import { useApp } from "@/lib/client/store";
import { copyWithToast } from "./asset-actions";

const ROLE_LABELS: Record<NonNullable<Swatch["role"]>, string> = {
  primary: "Primary",
  accent: "Accent",
  background: "Background",
  surface: "Surface",
  text: "Text",
};

const channel = (value: number) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);

function luminance(hex: string): number | null {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const value = Number.parseInt(match[1], 16);
  const [r, g, b] = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((part) => channel(part / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Relative luminance of `--bg` (#fafafa), the ground every swatch is painted on. */
const PAGE_LUMINANCE = luminance("#fafafa")!;

/**
 * True when the fill cannot be told from the page it sits on, so the border has to carry the boundary by itself.
 * A `#ffffff` swatch differs from the page by 5 of 255 and read as a hole in the palette row.
 */
function needsStrongEdge(hex: string): boolean {
  const own = luminance(hex);
  if (own === null) return false;
  return (Math.max(own, PAGE_LUMINANCE) + 0.05) / (Math.min(own, PAGE_LUMINANCE) + 0.05) < 3;
}

function SwatchButton({ swatch, group }: { swatch: Swatch; group: "brand" | "neutral" }) {
  const label = swatch.role ? ROLE_LABELS[swatch.role] : group === "brand" ? "Brand" : "Neutral";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={`Copy ${swatch.hex}`}
            onClick={() => copyWithToast(swatch.hex, `Copied ${swatch.hex}`)}
            className="group/swatch flex w-[60px] flex-col items-center gap-1.5 rounded-md pt-1 pb-0.5 focus-ring"
          />
        }
      >
        <span
          aria-hidden="true"
          data-testid="swatch-chip"
          className={cn(
            "size-8 rounded-md border transition-transform duration-100 ease-enter group-hover/swatch:scale-[1.06] motion-reduce:transform-none",
            needsStrongEdge(swatch.hex) ? "border-swatch-edge-strong" : "border-swatch-edge",
          )}
          style={{ backgroundColor: swatch.hex }}
        />
        <span className="font-mono text-mono-xs text-text-3 transition-colors group-hover/swatch:text-text">{swatch.hex}</span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** Spec 12.2 palette strip: brand swatches, then neutrals. Click copies a hex; `Copy all` copies `#hex role` lines. */
export function PaletteStrip() {
  const palette = useApp((s) => s.palette);
  if (!palette || palette.brand.length + palette.neutrals.length === 0) return null;
  const lines = [
    ...palette.brand.map((swatch) => `${swatch.hex} ${swatch.role ?? "brand"}`),
    ...palette.neutrals.map((swatch) => `${swatch.hex} ${swatch.role ?? "neutral"}`),
  ];

  return (
    <section aria-label="Palette" className="min-w-0">
      <div className="mb-1.5 flex h-6 items-center gap-3">
        <span className="text-small font-medium text-text-2">Palette</span>
        <button
          type="button"
          onClick={() => copyWithToast(lines.join("\n"), "Palette copied")}
          className="rounded-sm text-small text-text-3 underline decoration-border-strong underline-offset-4 hover:text-text hover:decoration-text focus-ring"
        >
          Copy all
        </button>
      </div>
      {/*
       * Two groups, not one list with a rule in it: below 640 the swatches wrap onto their own rows and the inline
       * divider is hidden, so the grouping disappeared. Each group wraps on its own and the neutrals name themselves
       * when they land on a row of their own.
       */}
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="-ml-3.5 flex flex-wrap items-start">
          {palette.brand.map((swatch, index) => (
            <SwatchButton key={`b${index}${swatch.hex}`} swatch={swatch} group="brand" />
          ))}
        </div>
        {palette.brand.length && palette.neutrals.length ? <span aria-hidden="true" className="mt-1 hidden h-8 w-px bg-border sm:block" /> : null}
        <div className="flex flex-col">
          {palette.brand.length && palette.neutrals.length ? (
            <span aria-hidden="true" className="text-mono-xs text-text-3 sm:hidden">
              Neutrals
            </span>
          ) : null}
          <div className="-ml-3.5 flex flex-wrap items-start">
            {palette.neutrals.map((swatch, index) => (
              <SwatchButton key={`n${index}${swatch.hex}`} swatch={swatch} group="neutral" />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
