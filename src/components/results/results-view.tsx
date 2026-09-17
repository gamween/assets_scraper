"use client";

import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { rescan } from "@/lib/client/scan-session";
import { getSections, useApp } from "@/lib/client/store";
import { BrandLinks } from "./brand-links";
import { FilterBar } from "./filter-bar";
import { hiddenSummary } from "./labels";
import { PaletteStrip } from "./palette-strip";
import { ResultsHeader } from "./results-header";
import { Sections } from "./sections";

const EMPTY_TAB: Record<string, string> = {
  all: "No SVGs, images or fonts on this page",
  svg: "No SVGs on this page",
  images: "No images on this page",
  fonts: "No fonts on this page",
};

export function EmptyState({ title, line, children }: { title: string; line?: string; children?: React.ReactNode }) {
  return (
    <div className="mt-8 flex flex-col items-start gap-1 rounded-lg border border-dashed border-border-strong px-6 py-10 sm:items-center sm:text-center">
      <p className="text-title font-semibold text-text">{title}</p>
      {line ? <p className="text-body text-text-2">{line}</p> : null}
      {children ? <div className="mt-4 flex gap-2">{children}</div> : null}
    </div>
  );
}

export function PartialBanner() {
  return (
    <div role="status" className="mt-6 flex items-center gap-2.5 rounded-lg border border-[#ecd9b0] bg-[#fdf8ec] px-3.5 py-2.5 text-body text-[#6e4300]">
      <TriangleAlert className="size-4 shrink-0 text-warning" aria-hidden="true" />
      Partial results. The page didn&apos;t finish loading.
    </div>
  );
}

function SectionsOrEmpty() {
  const sections = useApp(getSections);
  const query = useApp((s) => s.query);
  const tab = useApp((s) => s.tab);
  const setQuery = useApp((s) => s.setQuery);

  if (sections.length) return <Sections sections={sections} />;
  if (query.trim()) {
    return (
      <EmptyState title={`Nothing matches "${query.trim()}"`}>
        <Button variant="secondary" onClick={() => setQuery("")}>
          Clear search
        </Button>
      </EmptyState>
    );
  }
  return <EmptyState title={EMPTY_TAB[tab]} />;
}

/** Spec 12.2 results: header, palette, brand links, sticky filters, sections, hidden noise footer. */
export function ResultsView() {
  const partial = useApp((s) => s.done?.partial ?? false);
  const empty = useApp((s) => s.assets.length + s.fonts.length === 0);
  const hidden = useApp((s) => (s.done ? hiddenSummary(s.done.stats.hidden) : null));

  if (empty) {
    return (
      <div data-testid="results" className="page-x">
        <ResultsHeader actions={false} />
        <EmptyState title="No SVGs, images or fonts on this page" line="Some sites only load content after sign-in.">
          <Button variant="secondary" onClick={rescan}>
            Rescan
          </Button>
        </EmptyState>
        {hidden ? <p className="mt-10 text-small text-text-3">{hidden}</p> : null}
      </div>
    );
  }

  return (
    <div data-testid="results">
      <div className="page-x">
        {partial ? <PartialBanner /> : null}
        <ResultsHeader />
        <div className="mt-6 flex flex-wrap items-start justify-between gap-x-12 gap-y-5">
          <PaletteStrip />
          <BrandLinks />
        </div>
      </div>
      <FilterBar />
      <div className="page-x">
        <SectionsOrEmpty />
        {hidden ? <p className="mt-12 text-small text-text-3">{hidden}</p> : null}
      </div>
    </div>
  );
}
