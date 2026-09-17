"use client";

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { ChevronDown, ChevronLeft, ChevronRight, CodeXml, Copy, Download, ExternalLink, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/common/badge";
import { cn } from "@/components/common/cn";
import { Kbd } from "@/components/common/kbd";
import { copySvgCode, downloadAsset, openSource, sourceUrl, svgMarkup } from "@/components/results/asset-actions";
import { AssetPreview, WELL_CLASSES, wellBackground } from "@/components/results/asset-preview";
import { BackgroundControl } from "@/components/results/filter-bar";
import { foundInLabel, roleBadge } from "@/components/results/labels";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Asset } from "@/lib/contract";
import { formatBytes, formatCount, formatDimensions } from "@/lib/format";
import { assetBytes, type Background } from "@/lib/client/filters";
import { syncDetailToLocation } from "@/lib/client/scan-session";
import { appStore, findAsset, getDetailList, useApp } from "@/lib/client/store";

const ACTION_CLASS =
  "group/action flex h-9 w-full items-center gap-2.5 rounded-md border px-3 text-body font-medium transition-colors duration-100 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent [&_svg]:size-4 [&_svg]:shrink-0";

function ActionButton({ label, shortcut, primary = false, onClick, icon }: { label: string; shortcut?: string; primary?: boolean; onClick: () => void; icon: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-keyshortcuts={shortcut}
      className={cn(ACTION_CLASS, primary ? "border-ink bg-ink text-ink-fg hover:bg-[#2c2c31]" : "border-border bg-surface text-text hover:border-border-strong hover:bg-well/60")}
    >
      {icon}
      <span className="flex-1 text-left">{label}</span>
      {shortcut ? <Kbd onInk={primary}>{shortcut}</Kbd> : null}
    </button>
  );
}

function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = `${parsed.pathname}${parsed.search}`;
    return `${parsed.host}${path.length > 42 ? `${path.slice(0, 20)}…${path.slice(-18)}` : path}`;
  } catch {
    return url;
  }
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
      <a href={source} target="_blank" rel="noopener noreferrer" className="break-all underline decoration-border-strong underline-offset-4 hover:decoration-text" title={source}>
        {shortUrl(source)}
      </a>
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
        className="flex h-9 w-full items-center gap-2 rounded-lg px-3 text-body font-medium text-text outline-none hover:bg-well/60 focus-visible:outline-2 focus-visible:outline-accent"
      >
        <CodeXml className="size-4 text-text-3" aria-hidden="true" />
        <span className="flex-1 text-left">Code</span>
        <ChevronDown className={cn("size-4 text-text-3 transition-transform duration-150", open && "rotate-180")} aria-hidden="true" />
      </button>
      {open ? (
        <pre
          data-testid="detail-code"
          className="max-h-[240px] overflow-auto border-t border-border bg-bg px-3 py-2.5 font-mono text-mono-xs leading-[17px] font-normal tracking-normal break-all whitespace-pre-wrap text-text-2"
        >
          {failed ? "The markup couldn't be loaded." : (text ?? "Loading")}
        </pre>
      ) : null}
    </div>
  );
}

function NavButton({ direction, onClick }: { direction: "previous" | "next"; onClick: () => void }) {
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
              "absolute top-1/2 z-10 grid size-9 -translate-y-1/2 place-items-center rounded-md border border-border bg-surface/95 text-text-2 shadow-[0_1px_2px_rgb(0_0_0/0.06)] transition-colors hover:border-border-strong hover:text-text focus-visible:outline-2 focus-visible:outline-accent",
              direction === "previous" ? "left-3" : "right-3",
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
  const badge = roleBadge(asset);
  const svg = asset.kind === "svg";
  const remote = sourceUrl(asset) !== null;
  const formatLabel = (asset.original?.format ?? asset.format).toUpperCase();
  const { nextDetail, previousDetail } = appStore.getState();

  return (
    <div className="flex h-full min-h-0 flex-col md:grid md:grid-cols-[minmax(0,1fr)_340px]">
      <div className={cn("relative h-[44dvh] shrink-0 md:h-full", WELL_CLASSES[well])} data-testid="detail-well" data-background={well}>
        <div className="absolute inset-x-3 top-3 z-10 flex items-center justify-between gap-3">
          <BackgroundControl value={background} onChange={setOverride} className="bg-well/95" />
          {index >= 0 ? (
            <span data-testid="detail-counter" className="rounded-md border border-border bg-surface/95 px-2 py-1 font-mono text-mono text-text-2 tabular-nums">
              {index + 1} of {list.length}
            </span>
          ) : null}
        </div>
        <div className="grid h-full w-full place-items-center overflow-hidden p-6 pt-14">
          <div className="relative grid size-full place-items-center">
            <AssetPreview key={asset.id} asset={asset} variant="detail" />
          </div>
        </div>
        {list.length > 1 ? (
          <>
            <NavButton direction="previous" onClick={previousDetail} />
            <NavButton direction="next" onClick={nextDetail} />
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
              {badge ? (
                <Badge data-testid="detail-badge" className="font-sans text-[11px] tracking-normal">
                  {badge}
                </Badge>
              ) : null}
              <span className="truncate font-mono text-mono text-text-3">{asset.filename}</span>
            </div>
          </div>
          <DialogPrimitive.Close
            aria-label="Close"
            className="-mt-1 -mr-2 grid size-8 shrink-0 place-items-center rounded-md text-text-3 transition-colors hover:bg-well hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
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
            <p className="rounded-md border border-[#ecd9b0] bg-[#fdf8ec] px-3 py-2 text-small text-[#6e4300]">Text in this SVG uses a web font. Outside the page it may render in a fallback font.</p>
          ) : null}

          <Metadata asset={asset} />

          {svg ? <CodeBlock key={asset.id} asset={asset} /> : null}
        </div>
      </div>
    </div>
  );
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
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-[#18181b]/30 transition-opacity duration-150 ease-enter data-ending-style:opacity-0 data-ending-style:duration-100 data-starting-style:opacity-0" />
        <DialogPrimitive.Popup
          ref={popupRef}
          initialFocus={popupRef}
          finalFocus={() => (shown ? (document.querySelector<HTMLElement>(`[data-asset-id="${CSS.escape(shown.id)}"] [data-card-main]`) ?? true) : true)}
          className={cn(
            "fixed inset-0 z-50 flex flex-col overflow-hidden bg-surface text-text outline-none",
            "md:inset-auto md:top-1/2 md:left-1/2 md:h-[min(calc(100dvh-96px),880px)] md:w-[min(1120px,calc(100vw-48px))] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-xl md:border md:border-border md:shadow-float",
            "transition-[opacity,scale] duration-150 ease-enter data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-ending-style:duration-100 data-ending-style:ease-exit data-starting-style:scale-[0.98] data-starting-style:opacity-0",
          )}
        >
          {shown ? <DetailBody asset={shown} /> : null}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
