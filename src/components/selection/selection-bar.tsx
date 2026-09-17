"use client";

import { Download, LoaderCircle } from "lucide-react";
import { cn } from "@/components/common/cn";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatBytes, formatCount } from "@/lib/format";
import { useApp } from "@/lib/client/store";
import { cancelZip, downloadSelection, itemsBytes, selectedItems } from "./zip-actions";

/** `8 selected · 2.4 MB`: the selector returns numbers, so the bar only re-renders when they change. */
function useSelectionSummary(): { count: number; bytes: number } {
  const count = useApp((s) => s.selection.size);
  const bytes = useApp((s) => (s.selection.size ? itemsBytes(selectedItems(s)) : 0));
  return { count, bytes };
}

/**
 * Spec 12.4 floating bar: bottom center, 52 px, 12 px above the edge plus the safe area. Shows the count and size,
 * `Clear` and `Download ZIP`; while zipping, progress in the button and a `Cancel` link.
 */
export function SelectionBar() {
  const { count, bytes } = useSelectionSummary();
  const zip = useApp((s) => s.zip);
  const clearSelection = useApp((s) => s.clearSelection);
  const zipping = zip?.source === "selection";

  if (count === 0 && !zipping) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[calc(12px+env(safe-area-inset-bottom,0px))] z-40 flex justify-center px-3">
      <section
        aria-label="Selection"
        data-motion="move"
        className={cn(
          "pointer-events-auto flex h-[52px] w-full max-w-[560px] items-center gap-2 rounded-xl border border-border bg-surface pr-2 pl-2.5 shadow-float sm:w-auto",
          "animate-in fade-in-0 slide-in-from-bottom-2 duration-200 ease-enter",
        )}
      >
        <span data-testid="selection-count" className="mr-auto inline-flex h-8 min-w-0 items-center truncate rounded-md bg-accent-soft px-2.5 font-mono text-mono whitespace-nowrap text-text tabular-nums sm:mr-3" aria-live="polite">
          {formatCount(count)} selected{bytes > 0 ? ` · ${formatBytes(bytes)}` : ""}
        </span>
        {zipping ? (
          <button type="button" onClick={cancelZip} className="h-8 rounded-md px-2 text-body text-text-2 underline decoration-border-strong underline-offset-4 hover:text-text">
            Cancel
          </button>
        ) : (
          <Button variant="ghost" className="px-2 sm:px-3" onClick={clearSelection}>
            Clear
          </Button>
        )}
        <Button variant="primary" onClick={downloadSelection} disabled={zipping || count === 0} aria-label={zipping ? undefined : "Download ZIP"} className="shrink-0 sm:min-w-[132px]">
          {zipping ? <LoaderCircle className="spinner" aria-hidden="true" /> : <Download aria-hidden="true" />}
          {zipping ? (
            <span className="tabular-nums">{`Zipping ${zip.done} of ${zip.total}`}</span>
          ) : (
            <span>
              <span className="hidden sm:inline">Download </span>ZIP
            </span>
          )}
        </Button>
      </section>
    </div>
  );
}

/** The `Show` list of a ZIP toast: files that could not be fetched. */
export function ZipFailuresDialog() {
  const failures = useApp((s) => s.zipFailures);
  const setZipFailures = useApp((s) => s.setZipFailures);
  return (
    <Dialog open={failures !== null} onOpenChange={(open) => (open ? undefined : setZipFailures(null))}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Files that couldn&apos;t be downloaded</DialogTitle>
          <DialogDescription>They were left out of the ZIP. The site may block downloads from other pages, or the files are gone.</DialogDescription>
        </DialogHeader>
        <ul className="mt-4 max-h-64 overflow-y-auto rounded-md border border-border bg-bg py-1">
          {(failures ?? []).map((failure) => (
            <li key={failure.path} className="truncate px-3 py-1.5 text-small text-text" title={failure.path}>
              {failure.name}
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
