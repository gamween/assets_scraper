"use client";

import { TopBar } from "@/components/app-shell/top-bar";
import { DetailDialog } from "@/components/detail/detail-dialog";
import { ResultsView } from "@/components/results/results-view";
import { ErrorView } from "@/components/scan/error-view";
import { ScanStatus } from "@/components/scan/scan-status";
import { SkeletonGrid } from "@/components/scan/skeleton-grid";
import { SiteHeader } from "@/components/scan/site-header";
import { SelectionBar, ZipFailuresDialog } from "@/components/selection/selection-bar";
import { useApp } from "@/lib/client/store";
import { useResultsShortcuts } from "./shortcuts";

/** The results layout, used from the first scan event on (spec 12.2: the landing never shows again during a scan). */
export function Workspace({ pendingHost }: { pendingHost: string | null }) {
  const phase = useApp((s) => s.phase);
  const host = useApp((s) => s.host) ?? pendingHost ?? "";
  const scanning = phase === "scanning" || (phase === "idle" && pendingHost !== null);
  useResultsShortcuts();

  return (
    <div className="flex min-h-dvh flex-col">
      <TopBar />
      <main className="w-full flex-1 pb-32">
        {scanning ? (
          <div className="page-x">
            <SiteHeader host={host} />
            <ScanStatus host={host} />
            <SkeletonGrid />
          </div>
        ) : null}
        {phase === "results" ? <ResultsView /> : null}
        {phase === "error" ? <ErrorView /> : null}
      </main>
      <SelectionBar />
      <DetailDialog />
      <ZipFailuresDialog />
    </div>
  );
}
