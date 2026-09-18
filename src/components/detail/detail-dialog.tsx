"use client";

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { ChevronDown, ChevronLeft, ChevronRight, CodeXml, Copy, Download, ExternalLink, XIcon } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Badge } from "@/components/common/badge";
import { cn } from "@/components/common/cn";
import { Kbd } from "@/components/common/kbd";
import { copySvgCode, copyWithToast, downloadAsset, openSource, sourceUrl, svgMarkup } from "@/components/results/asset-actions";
import { AssetPreview, DETAIL_FRAME, WELL_CLASSES, wellBackground } from "@/components/results/asset-preview";
import { BackgroundControl } from "@/components/results/filter-bar";
import { foundInLabel, roleLabel } from "@/components/results/labels";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Asset } from "@/lib/contract";
import { formatBytes, formatCount, formatDimensions } from "@/lib/format";
import { assetBytes, type Background } from "@/lib/client/filters";
import { syncDetailToLocation } from "@/lib/client/scan-session";
import { appStore, findAsset, getDetailList, useApp } from "@/lib/client/store";

const ACTION_CLASS =
  "group/action flex h-9 w-full items-center gap-2.5 rounded-md border px-3 text-body font-medium transition-colors duration-100 focus-ring [&_svg]:size-4 [&_svg]:shrink-0";

function ActionButton({ label, shortcut, primary = false, onClick, icon }: { label: string; shortcut?: string; primary?: boolean; onClick: () => void; icon: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-keyshortcuts={shortcut}
      className={cn(ACTION_CLASS, primary ? "border-ink bg-ink text-ink-fg hover:bg-ink-hover" : "border-border bg-surface text-text hover:border-border-strong hover:bg-well/60")}
    >
      {icon}
      <span className="flex-1 text-left">{label}</span>
      {shortcut ? <Kbd onInk={primary}>{shortcut}</Kbd> : null}
    </button>
  );
}

function Metadata({ asset }: { asset: Asset }) {
  const source = sourceUrl(asset);
  const bytes = assetBytes(asset);
  const rows: [string, React.ReactNode][] = [
    ["Format", asset.format === "other" ? "File" : asset.format.toUpperCase()],
    ["Dimensions", formatDimensions(asset.original?.width ?? asset.width, asset.original?.height ?? asset.height) || "Unknown"],
    ["File size", bytes ? formatBytes(bytes) : "Unknown"],
    ["Found in", foundInLabel(asset.foundIn)],
    ["Used", asset.usedCount === 1 ? "Once" : formatCount(asset.usedCount, "time")],
  ];
  rows.push([
    "Source",
    source ? (
      // The URL used to be middle-truncated and then wrapped anyway, so it was cut for nothing. It now reads as far as
      // three lines of the real address, with the whole value on hover and one click to copy it.
      <span className="flex items-start gap-1.5">
        <a
          href={source}
          target="_blank"
          rel="noopener noreferrer"
          title={source}
          className="line-clamp-3 min-w-0 break-all underline decoration-border-strong underline-offset-4 hover:decoration-text"
        >
          {source}
        </a>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label="Copy source URL"
                onClick={() => copyWithToast(source, "Source URL copied")}
                className="focus-ring-tight -mt-0.5 grid size-5 shrink-0 place-items-center rounded-sm text-text-3 transition-colors hover:bg-well hover:text-text"
              />
            }
          >
            <Copy className="size-3.5" aria-hidden="true" />
          </TooltipTrigger>
          <TooltipContent>Copy source URL</TooltipContent>
        </Tooltip>
      </span>
    ) : (
      "Inline in the page"
    ),
  ]);

  return (
    <dl data-testid="detail-meta" className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-2 text-small">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-text-3">{label}</dt>
          <dd className="min-w-0 font-mono text-mono leading-[18px] break-words text-text tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function CodeBlock({ asset }: { asset: Asset }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<string | null>(asset.inline && "text" in asset.inline ? asset.inline.text : null);
  const [failed, setFailed] = useState(false);
  // The block is 240 px tall over markup that is usually far longer, and it used to cut the last line through the
  // glyphs with nothing saying so. A fade marks the edge until the end of the markup is on screen. The same
  // measurement runs from the ref and from the scroll handler, so a re-render cannot disagree with a scroll.
  const [moreBelow, setMoreBelow] = useState(false);
  const measure = (element: HTMLElement | null) => setMoreBelow(!!element && element.scrollTop + element.clientHeight < element.scrollHeight - 1);

  return (
    <div className="rounded-lg border border-border">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          if (!open && text === null && !failed) {
            svgMarkup(asset)
              .then(setText)
              .catch(() => setFailed(true));
          }
        }}
        className="flex h-9 w-full items-center gap-2 rounded-lg px-3 text-body font-medium text-text hover:bg-well/60 focus-ring"
      >
        <CodeXml className="size-4 text-text-3" aria-hidden="true" />
        <span className="flex-1 text-left">Code</span>
        <ChevronDown className={cn("size-4 text-text-3 transition-transform duration-150", open && "rotate-180")} aria-hidden="true" />
      </button>
      {open ? (
        <div className="relative">
          <pre
            data-testid="detail-code"
            onScroll={(event) => measure(event.currentTarget)}
            ref={measure}
            className="scrollbar-thin max-h-[240px] overflow-auto border-t border-border bg-bg px-3 py-2.5 font-mono text-mono-xs leading-[17px] font-normal tracking-normal break-all whitespace-pre-wrap text-text-2"
          >
            {failed ? "The markup couldn't be loaded." : (text ?? "Loading")}
          </pre>
          <span
            aria-hidden="true"
            data-testid="detail-code-fade"
            className={cn(
              "pointer-events-none absolute inset-x-px bottom-px h-6 rounded-b-lg bg-linear-to-b from-transparent to-bg transition-opacity duration-100",
              !moreBelow && "opacity-0",
            )}
          />
        </div>
      ) : null}
    </div>
  );
}

function NavButton({ direction, onClick, className }: { direction: "previous" | "next"; onClick: () => void; className?: string }) {
  const Icon = direction === "previous" ? ChevronLeft : ChevronRight;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={direction === "previous" ? "Previous" : "Next"}
            onClick={onClick}
            className={cn(
              "z-10 grid size-9 place-items-center rounded-md border border-border bg-surface/95 text-text-2 transition-colors hover:border-border-strong hover:text-text focus-ring",
              className,
            )}
          />
        }
      >
        <Icon className="size-4" aria-hidden="true" />
      </TooltipTrigger>
      <TooltipContent>
        {direction === "previous" ? "Previous" : "Next"} <Kbd onInk>{direction === "previous" ? "←" : "→"}</Kbd>
      </TooltipContent>
    </Tooltip>
  );
}

function DetailBody({ asset }: { asset: Asset }) {
  const list = useApp(getDetailList);
  const globalBackground = useApp((s) => s.background);
  const [override, setOverride] = useState<Background | null>(null);
  const background = override ?? globalBackground;
  const well = wellBackground(asset.tone, background);
  const index = list.findIndex((item) => item.id === asset.id);
  const svg = asset.kind === "svg";
  const remote = sourceUrl(asset) !== null;
  const formatLabel = (asset.original?.format ?? asset.format).toUpperCase();
  const { nextDetail, previousDetail } = appStore.getState();

  // The grid row is explicit: an implicit `auto` row makes `md:h-full` on the preview column cyclic, so the column
  // grew to the height of the asset (1243 px inside an 860 px dialog) and the dialog clipped what did not fit.
  return (
    <div className="flex h-full min-h-0 flex-col md:grid md:grid-cols-[minmax(0,1fr)_var(--detail-panel)] md:grid-rows-[minmax(0,1fr)]">
      <div className={cn("relative h-[44dvh] shrink-0 md:h-full md:min-h-0", WELL_CLASSES[well])} data-testid="detail-well" data-background={well}>
        <div className="absolute inset-x-3 top-3 z-10 flex items-center justify-between gap-3">
          <BackgroundControl value={background} onChange={setOverride} className="bg-well/95" />
          {/*
           * On a phone the well is 44dvh over a 390 px screen and the arrows sat inside it, about 7 px from the
           * artwork on each side. They ride with the counter instead, out of the band the asset is in.
           */}
          <div className="flex shrink-0 items-center gap-1.5">
            {list.length > 1 ? <NavButton direction="previous" onClick={previousDetail} className="md:hidden" /> : null}
            {index >= 0 ? (
              <span data-testid="detail-counter" className="rounded-md border border-border bg-surface/95 px-2 py-1 font-mono text-mono whitespace-nowrap text-text-2 tabular-nums">
                {index + 1} of {list.length}
              </span>
            ) : null}
            {list.length > 1 ? <NavButton direction="next" onClick={nextDetail} className="md:hidden" /> : null}
          </div>
        </div>
        <div className="absolute inset-0 overflow-hidden p-6 pt-14">
          <div className="relative size-full">
            <AssetPreview key={asset.id} asset={asset} variant="detail" />
            {/*
             * Spec 11.4: a blob: URL of a scraped SVG is never opened in a tab. This layer takes the pointer, so the
             * context menu, long press and drag act on the page, not on the preview image ("Open image in new tab").
             */}
            <div aria-hidden="true" data-testid="detail-preview-shield" className="absolute inset-0" />
          </div>
        </div>
        {list.length > 1 ? (
          <>
            <NavButton direction="previous" onClick={previousDetail} className="absolute top-1/2 left-3 hidden -translate-y-1/2 md:grid" />
            <NavButton direction="next" onClick={nextDetail} className="absolute top-1/2 right-3 hidden -translate-y-1/2 md:grid" />
          </>
        ) : null}
      </div>

      <div className="flex min-h-0 flex-1 flex-col border-border bg-surface md:border-l">
        <div className="flex items-start gap-3 px-5 pt-4 pb-3 md:pt-5">
          <div className="min-w-0 flex-1">
            <DialogPrimitive.Title render={<h2 />} className="text-title font-semibold break-words text-text">
              {asset.name}
            </DialogPrimitive.Title>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <Badge data-testid="detail-badge" className="font-sans text-[11px] tracking-normal">
                {roleLabel(asset)}
              </Badge>
              <span className="truncate font-mono text-mono text-text-3">{asset.filename}</span>
            </div>
          </div>
          <DialogPrimitive.Close
            aria-label="Close"
            className="-mt-1 -mr-2 grid size-8 shrink-0 place-items-center rounded-md text-text-3 transition-colors hover:bg-well hover:text-text focus-ring"
          >
            <XIcon className="size-4" aria-hidden="true" />
          </DialogPrimitive.Close>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 pb-5">
          <div className="flex flex-col gap-2">
            {svg ? <ActionButton primary label="Copy SVG code" shortcut="C" icon={<Copy aria-hidden="true" />} onClick={() => copySvgCode(asset)} /> : null}
            <ActionButton primary={!svg} label={`Download ${formatLabel}`} shortcut="D" icon={<Download aria-hidden="true" />} onClick={() => downloadAsset(asset)} />
            {!svg && asset.aspectChanged && asset.display ? (
              <ActionButton label="Download as displayed" icon={<Download aria-hidden="true" />} onClick={() => downloadAsset(asset, "display")} />
            ) : null}
            {remote ? <ActionButton label="Open source" shortcut="O" icon={<ExternalLink aria-hidden="true" />} onClick={() => openSource(asset)} /> : null}
          </div>

          {asset.hasLiveText ? (
            <p className="rounded-md border border-warning-line bg-warning-soft px-3 py-2 text-small text-warning">Text in this SVG uses a web font. Outside the page it may render in a fallback font.</p>
          ) : null}

          <Metadata asset={asset} />

          {svg ? <CodeBlock key={asset.id} asset={asset} /> : null}
        </div>
      </div>
    </div>
  );
}

/** Below this the info panel starts scrolling for no reason; above it the dialog leaves the screen. */
const DIALOG_MIN_HEIGHT = 460;
const DIALOG_MAX_HEIGHT = 880;

/**
 * The geometry `dialogHeight` reasons about, shared with the layout so the two cannot drift: `DIALOG_WIDTH` and
 * `PANEL_WIDTH` reach the popup as `--detail-width` and `--detail-panel` and are read by `md:w-[...]` and the grid
 * columns of `DetailBody`, and `DETAIL_FRAME` is the fraction of the well a detail preview fills (asset-preview).
 * `WELL_PADDING` mirrors `p-6` on the well (24 px a side) and `CONTROL_BAND` the 56 px control band with its padding;
 * both are plain Tailwind classes, so an edit there belongs here too.
 */
const DIALOG_WIDTH = 1120;
const PANEL_WIDTH = 340;
const WELL_PADDING = 48;
const CONTROL_BAND = 104;

/**
 * Height the dialog opens at. It used to be 880 px whatever the asset, so a 60x25 logo sat in a 780x845 white void
 * with 420 px of empty panel under its six metadata rows. The preview the asset will get decides instead, clamped so
 * the panel always has room and the dialog never leaves the screen.
 */
function dialogHeight(asset: Asset): number {
  const source = asset.original ?? asset.display;
  const width = source?.width ?? asset.width ?? 0;
  const height = source?.height ?? asset.height ?? 0;
  if (!width || !height) return DIALOG_MAX_HEIGHT;
  // The preview column is what the dialog leaves beside the panel, less its padding, and the frame takes 82 percent of
  // the well: a wide asset runs out of width before it reaches its 6x (vectors) or 2x (rasters).
  const room = (DIALOG_WIDTH - PANEL_WIDTH - WELL_PADDING) * DETAIL_FRAME;
  const shown = Math.min(height * (asset.kind === "svg" ? 6 : 2), (room * height) / width);
  // Back out the well the frame needs, plus the control band and the padding around it.
  return Math.round(Math.min(DIALOG_MAX_HEIGHT, Math.max(DIALOG_MIN_HEIGHT, shown / DETAIL_FRAME + CONTROL_BAND)));
}

/**
 * Spec 12.2 detail: a 1120 px modal (preview left, 340 px info right), a full-screen sheet on phones. Keys: arrows move
 * within the current tab and search, D downloads, C copies SVG code, O opens remote sources, Esc closes.
 */
export function DetailDialog() {
  const detailId = useApp((s) => s.detailId);
  const phase = useApp((s) => s.phase);
  const asset = useApp((s) => findAsset(s, s.detailId));
  // Keep showing the last asset while the dialog fades out after closing.
  const [shown, setShown] = useState<Asset | null>(asset);
  if (asset && asset !== shown) setShown(asset);
  const open = Boolean(detailId && asset);
  const popupRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (phase === "results" || phase === "error") syncDetailToLocation(detailId);
  }, [detailId, phase]);

  // Keys work as soon as the dialog opens, even before focus has moved into it.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // Base UI handles arrow keys inside the popup and stops them there, so this listens in the capture phase.
      if (event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable=true], [role=radiogroup]")) return;
      const state = appStore.getState();
      const current = findAsset(state, state.detailId);
      if (!current) return;
      switch (event.key) {
        case "ArrowLeft":
          event.preventDefault();
          state.previousDetail();
          break;
        case "ArrowRight":
          event.preventDefault();
          state.nextDetail();
          break;
        case "d":
        case "D":
          event.preventDefault();
          downloadAsset(current);
          break;
        case "c":
        case "C":
          if (current.kind === "svg" && !window.getSelection()?.toString()) {
            event.preventDefault();
            copySvgCode(current);
          }
          break;
        case "o":
        case "O":
          event.preventDefault();
          openSource(current);
          break;
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open]);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(next) => (next ? undefined : appStore.getState().closeDetail())}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-ink/30 transition-opacity duration-150 ease-enter data-ending-style:opacity-0 data-ending-style:duration-100 data-starting-style:opacity-0" />
        <DialogPrimitive.Popup
          ref={popupRef}
          initialFocus={popupRef}
          finalFocus={() => (shown ? (document.querySelector<HTMLElement>(`[data-asset-id="${CSS.escape(shown.id)}"] [data-card-main]`) ?? true) : true)}
          data-testid="detail-popup"
          style={{ "--detail-height": `${shown ? dialogHeight(shown) : DIALOG_MAX_HEIGHT}px`, "--detail-width": `${DIALOG_WIDTH}px`, "--detail-panel": `${PANEL_WIDTH}px` } as CSSProperties}
          className={cn(
            "fixed inset-0 z-50 flex flex-col overflow-hidden bg-surface text-text outline-none",
            "md:inset-auto md:top-1/2 md:left-1/2 md:h-[min(calc(100dvh-96px),var(--detail-height))] md:w-[min(var(--detail-width),calc(100vw-48px))] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-xl md:border md:border-border md:shadow-float",
            "transition-[opacity,scale] duration-150 ease-enter data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-ending-style:duration-100 data-ending-style:ease-exit data-starting-style:scale-[0.98] data-starting-style:opacity-0",
          )}
        >
          {shown ? <DetailBody asset={shown} /> : null}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
