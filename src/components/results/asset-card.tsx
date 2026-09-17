"use client";

import { CheckIcon, CodeXml, Download } from "lucide-react";
import { memo, type MouseEvent } from "react";
import { Badge } from "@/components/common/badge";
import { cn } from "@/components/common/cn";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Asset } from "@/lib/contract";
import { assetKey } from "@/lib/client/filters";
import { appStore, useApp } from "@/lib/client/store";
import { copySvgCode, downloadAsset } from "./asset-actions";
import { AssetPreview, WELL_CLASSES, wellBackground } from "./asset-preview";
import { assetMetaParts, roleBadge, splitExtension } from "./labels";

/**
 * Spec 12.4 click model: checkbox or Cmd/Ctrl+click toggles, Shift+click selects a range in visual order, and once
 * something is selected (or selection mode is on) a plain click toggles too. Otherwise a click opens the detail view.
 */
export function activateItem(key: string, event: Pick<MouseEvent, "metaKey" | "ctrlKey" | "shiftKey">, open: () => void) {
  const state = appStore.getState();
  if (event.shiftKey) state.selectRange(key);
  else if (event.metaKey || event.ctrlKey || state.selection.size > 0 || state.selectionMode) state.toggle(key);
  else open();
}

function IconAction({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            tabIndex={-1}
            aria-label={label}
            onClick={(event) => {
              event.stopPropagation();
              onClick();
            }}
            className="grid size-7 place-items-center rounded-md border border-border bg-surface text-text-2 shadow-[0_1px_2px_rgb(0_0_0/0.06)] transition-colors duration-100 hover:border-border-strong hover:text-text focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent [&_svg]:size-3.5"
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export const AssetCard = memo(function AssetCard({ asset }: { asset: Asset }) {
  const key = assetKey(asset.id);
  const selected = useApp((s) => s.selection.has(key));
  const selecting = useApp((s) => s.selection.size > 0 || s.selectionMode);
  const background = useApp((s) => s.background);
  const well = wellBackground(asset.tone, background);
  const badge = roleBadge(asset);
  const [base, extension] = splitExtension(asset.filename);

  return (
    <article
      data-testid="asset-card"
      data-asset-id={asset.id}
      data-role={asset.role}
      data-name={asset.name}
      data-filename={asset.filename}
      data-selected={selected || undefined}
      className={cn(
        "group/card relative flex min-w-0 flex-col overflow-hidden rounded-lg border bg-surface transition-colors duration-100",
        selected ? "border-accent" : "border-border hover:border-border-strong",
        "has-[[data-card-main]:focus-visible]:outline-2 has-[[data-card-main]:focus-visible]:outline-offset-2 has-[[data-card-main]:focus-visible]:outline-accent",
      )}
    >
      <div data-testid="preview-well" data-background={well} className={cn("relative grid aspect-[4/3] w-full place-items-center overflow-hidden", WELL_CLASSES[well])}>
        <AssetPreview key={asset.id} asset={asset} variant="tile" />
        {badge ? (
          <Badge tone="surface" className="pointer-events-none absolute top-2 left-2 z-10 font-sans text-[11px] font-medium tracking-normal">
            {badge}
          </Badge>
        ) : null}

        <button
          type="button"
          role="checkbox"
          tabIndex={-1}
          aria-checked={selected}
          aria-label={`Select ${asset.name}`}
          onClick={(event) => {
            if (event.shiftKey) appStore.getState().selectRange(key);
            else appStore.getState().toggle(key);
          }}
          className={cn(
            "absolute top-2 right-2 z-10 grid size-5 place-items-center rounded-sm border-[1.5px] transition-[opacity,background-color,border-color] duration-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent",
            selected ? "border-accent bg-accent text-accent-fg" : "border-border-strong bg-surface text-transparent hover:border-text-3",
            selected || selecting ? "opacity-100" : "opacity-0 group-hover/card:opacity-100",
          )}
        >
          <CheckIcon className="size-3" strokeWidth={3} aria-hidden="true" />
        </button>

        <div className="absolute right-2 z-10 flex gap-1 opacity-0 transition-opacity duration-100 group-focus-within/card:opacity-100 group-hover/card:opacity-100 bottom-2 pointer-coarse:hidden">
          {asset.kind === "svg" ? (
            <IconAction label="Copy SVG code" onClick={() => copySvgCode(asset)}>
              <CodeXml />
            </IconAction>
          ) : null}
          <IconAction label="Download" onClick={() => downloadAsset(asset)}>
            <Download />
          </IconAction>
        </div>
      </div>
      <div className="flex min-w-0 flex-col gap-0.5 border-t border-border px-3 pt-2 pb-2.5">
        <span data-testid="asset-filename" className="flex min-w-0 text-small text-text">
          <span className="truncate">{base}</span>
          <span className="shrink-0">{extension}</span>
        </span>
        <span data-testid="asset-meta" id={`meta-${asset.id}`} className="truncate font-mono text-mono text-text-3 tabular-nums">
          {assetMetaParts(asset).map((part, index) => (
            <span key={index}>
              {/* Mono spaces are wide: pull the separator in so the reference 221 px tile fits the whole line. */}
              {index > 0 ? <span className="-mx-[4px] text-text-3/60">{" · "}</span> : null}
              {part}
            </span>
          ))}
        </span>
      </div>

      {/* The whole tile is one button (one tab stop: Space selects, D downloads, C copies SVG code); the controls sit above it. */}
      <button
        type="button"
        data-card-main=""
        aria-label={asset.name}
        aria-describedby={`meta-${asset.id}`}
        title={asset.filename}
        className="absolute inset-0 z-0 outline-none"
        onClick={(event) => activateItem(key, event, () => appStore.getState().openDetail(asset.id))}
        onKeyDown={(event) => {
          if (event.metaKey || event.ctrlKey || event.altKey) return;
          if (event.key === " ") {
            event.preventDefault();
            appStore.getState().toggle(key);
          } else if (event.key === "d" || event.key === "D") {
            event.preventDefault();
            downloadAsset(asset);
          } else if ((event.key === "c" || event.key === "C") && asset.kind === "svg") {
            event.preventDefault();
            copySvgCode(asset);
          }
        }}
      />

      {selected ? <span aria-hidden="true" className="pointer-events-none absolute inset-0 z-20 rounded-lg ring-2 ring-accent ring-inset" /> : null}
    </article>
  );
});
