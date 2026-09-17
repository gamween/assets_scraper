"use client";

import { CheckIcon, Copy, Download, ExternalLink } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/common/badge";
import { cn } from "@/components/common/cn";
import { Button, buttonVariants } from "@/components/ui/button";
import type { FontFamily } from "@/lib/contract";
import { getFontFileBlob } from "@/lib/client/asset-bytes";
import { fontKey } from "@/lib/client/filters";
import { specimenFile } from "@/lib/client/font-files";
import { appStore, useApp } from "@/lib/client/store";
import { copyWithToast } from "./asset-actions";
import {
  LICENCE_LABELS,
  SOURCE_LABELS,
  adobeFontsUrl,
  canDownloadTtf,
  downloadFontFiles,
  downloadFontTtf,
  fontMeta,
  googleFontsUrl,
  weightsSummary,
} from "./font-actions";

const ALPHABET = "ABCDEFGHIJKLM abcdefghijklm 0123456789";

type LoadState = "loading" | "ready" | "failed";

/**
 * Loads the family's most representative file as `new FontFace(alias, bytes)` once the row is near the viewport.
 * The alias is unique per family, so a scraped font never changes the app's own text.
 */
function useSpecimenFont(family: FontFamily, alias: string) {
  const ref = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<LoadState>("loading");

  useEffect(() => {
    const element = ref.current;
    const file = specimenFile(family);
    if (!element) return;
    let face: FontFace | null = null;
    let cancelled = false;
    const controller = new AbortController();

    const load = async () => {
      if (!file) throw new Error("No font file");
      const buffer = await (await getFontFileBlob(file, { signal: controller.signal })).arrayBuffer();
      face = new FontFace(alias, buffer);
      await face.load();
      if (cancelled) return;
      document.fonts.add(face);
      setState("ready");
    };

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        load().catch(() => {
          if (!cancelled) setState("failed");
        });
      },
      { rootMargin: "400px 0px" },
    );
    observer.observe(element);
    return () => {
      cancelled = true;
      observer.disconnect();
      controller.abort();
      if (face) document.fonts.delete(face);
    };
  }, [family, alias]);

  return { ref, state };
}

/** Spec 12.3 font row: live specimen, weights, formats and size, source and licence, selection and actions. */
export const FontRow = memo(function FontRow({ font }: { font: FontFamily }) {
  const key = fontKey(font.id);
  const alias = `as-specimen-${font.id.replace(/[^a-z0-9]/gi, "").slice(0, 16)}`;
  const specimenText = useApp((s) => s.page?.title?.trim()) || ALPHABET;
  const selected = useApp((s) => s.selection.has(key));
  const selecting = useApp((s) => s.selection.size > 0 || s.selectionMode);
  const { ref, state } = useSpecimenFont(font, alias);
  const adobe = font.source === "adobe-fonts";
  const ttf = !adobe && font.downloadable && canDownloadTtf(font);

  return (
    <article
      data-testid="font-row"
      data-selected={selected || undefined}
      className={cn(
        "group/font relative overflow-hidden rounded-lg border bg-surface transition-colors duration-100",
        selected ? "border-accent ring-1 ring-accent ring-inset" : "border-border hover:border-border-strong",
      )}
    >
      <div className="grid gap-x-8 gap-y-4 px-5 pt-5 pb-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div ref={ref} className="min-w-0">
          <p
            data-testid="font-specimen"
            data-state={state}
            data-font-alias={alias}
            className={cn(
              "truncate text-[32px] leading-[42px] text-text transition-opacity duration-150",
              state === "failed" && "hidden",
              state === "loading" && "opacity-0",
            )}
            style={{ fontFamily: `"${alias}", ui-sans-serif, system-ui` }}
          >
            {specimenText}
          </p>
          {state === "failed" ? (
            <div className="flex h-[42px] items-baseline gap-3">
              <span className="truncate text-[24px] leading-[42px] font-semibold text-text">{font.name}</span>
              <span className="shrink-0 text-small text-text-3">Preview unavailable</span>
            </div>
          ) : null}
          <p
            className={cn("mt-1 truncate text-[16px] leading-6 text-text-2 transition-opacity duration-150", state !== "ready" && "opacity-0")}
            style={{ fontFamily: `"${alias}", ui-sans-serif, system-ui` }}
            aria-hidden={state !== "ready"}
          >
            {ALPHABET}
          </p>
        </div>

        <div className="min-w-0 lg:border-l lg:border-border lg:pl-6">
          <div className="flex items-start justify-between gap-3">
            <h3 className="truncate text-title font-semibold text-text">{font.name}</h3>
            <button
              type="button"
              role="checkbox"
              aria-checked={selected}
              aria-label={`Select ${font.name}`}
              onClick={(event) => (event.shiftKey ? appStore.getState().selectRange(key) : appStore.getState().toggle(key))}
              className={cn(
                "mt-0.5 grid size-5 shrink-0 place-items-center rounded-sm border-[1.5px] transition-[opacity,background-color,border-color] duration-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent",
                selected ? "border-accent bg-accent text-accent-fg" : "border-border-strong bg-surface text-transparent hover:border-text-3",
                selected || selecting ? "opacity-100" : "opacity-0 group-hover/font:opacity-100 pointer-coarse:opacity-100",
              )}
            >
              <CheckIcon className="size-3" strokeWidth={3} aria-hidden="true" />
            </button>
          </div>
          <p data-testid="font-weights" className="mt-0.5 text-small text-text-2">
            {weightsSummary(font)}
          </p>
          <p data-testid="font-meta" className="mt-0.5 font-mono text-mono text-text-3 tabular-nums">
            {fontMeta(font)}
          </p>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            <Badge className="font-sans text-[11px] tracking-normal">{font.source === "third-party" && font.sourceHost ? font.sourceHost : SOURCE_LABELS[font.source]}</Badge>
            <Badge tone={font.license.kind === "open" ? "success" : "neutral"} className="font-sans text-[11px] tracking-normal">
              {LICENCE_LABELS[font.license.kind]}
            </Badge>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border bg-bg/60 px-5 py-2.5">
        <span className="mr-auto text-small text-text-3">
          {font.usedOnPage ? `Used for ${Math.max(1, Math.round(font.usage * 100))}% of the text` : "Declared, not used"}
        </span>
        <Button variant="ghost" size="sm" onClick={() => copyWithToast(font.name, "Font name copied")}>
          <Copy className="size-3.5" aria-hidden="true" />
          Copy name
        </Button>
        {adobe ? (
          <a href={adobeFontsUrl(font.name)} target="_blank" rel="noopener noreferrer" className={cn(buttonVariants({ variant: "secondary", size: "sm" }))}>
            Adobe Fonts
            <ExternalLink className="size-3.5" aria-hidden="true" />
          </a>
        ) : null}
        {!adobe && font.googleFamily ? (
          <a href={googleFontsUrl(font.googleFamily)} target="_blank" rel="noopener noreferrer" className={cn(buttonVariants({ variant: "secondary", size: "sm" }))}>
            Google Fonts
            <ExternalLink className="size-3.5" aria-hidden="true" />
          </a>
        ) : null}
        {ttf ? (
          <Button variant="secondary" size="sm" onClick={() => downloadFontTtf(font)}>
            Download TTF
          </Button>
        ) : null}
        {!adobe && font.downloadable ? (
          <Button variant="secondary" size="sm" onClick={() => downloadFontFiles(font)}>
            <Download className="size-3.5" aria-hidden="true" />
            Download
          </Button>
        ) : null}
      </div>
    </article>
  );
});
