"use client";

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
          className="size-8 rounded-md border border-swatch-edge transition-transform duration-100 ease-enter group-hover/swatch:scale-[1.06] motion-reduce:transform-none"
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
      <div className="-ml-3.5 flex flex-wrap items-start">
        {palette.brand.map((swatch, index) => (
          <SwatchButton key={`b${index}${swatch.hex}`} swatch={swatch} group="brand" />
        ))}
        {palette.brand.length && palette.neutrals.length ? <span aria-hidden="true" className="mx-2 mt-1 hidden h-8 w-px bg-border sm:block" /> : null}
        {palette.neutrals.map((swatch, index) => (
          <SwatchButton key={`n${index}${swatch.hex}`} swatch={swatch} group="neutral" />
        ))}
      </div>
    </section>
  );
}
