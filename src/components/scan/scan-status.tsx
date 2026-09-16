"use client";

import { CheckIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Spinner } from "@/components/common/spinner";
import { Button } from "@/components/ui/button";
import type { StepId } from "@/lib/contract";
import { cancelScan } from "@/lib/client/scan-session";
import { STEP_ORDER, useApp, type AppState } from "@/lib/client/store";

const SLOW_SCAN_SECONDS = 20;

function stepLabel(step: StepId, host: string): string {
  switch (step) {
    case "open":
      return `Opening ${host}`;
    case "queue":
      return "Waiting for a free browser";
    case "load":
      return "Waiting for the page to load";
    case "scroll":
      return "Scrolling to load lazy images";
    case "collect":
      return "Collecting SVGs, images and fonts";
    case "process":
      return "Finding originals";
  }
}

type RowState = "done" | "active" | "pending";

/** Rows in display order: the queue row only once a `step queue` event arrived. */
export function stepRows(steps: AppState["steps"]): { step: StepId; state: RowState; current: boolean }[] {
  const visible = STEP_ORDER.filter((step) => step !== "queue" || steps.queue);
  const started = Object.keys(steps).length > 0;
  const rows = visible.map((step) => ({ step, state: (steps[step] ?? (!started && step === "open" ? "active" : "pending")) as RowState }));
  // The spinner sits on the latest active step; an earlier step still active (Opening while queued) shows as active only.
  let currentIndex = -1;
  rows.forEach((row, index) => {
    if (row.state === "active") currentIndex = index;
  });
  return rows.map((row, index) => ({ ...row, current: index === currentIndex }));
}

function useElapsedSeconds(startedAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, []);
  return startedAt ? Math.max(0, Math.floor((now - startedAt) / 1000)) : 0;
}

/** Spec 12.2 scanning status block: steps with checks, a spinner on the current one, elapsed seconds and Cancel. */
export function ScanStatus({ host }: { host: string }) {
  const steps = useApp((s) => s.steps);
  const startedAt = useApp((s) => s.startedAt);
  const elapsed = useElapsedSeconds(startedAt);
  const rows = stepRows(steps);

  return (
    <section data-testid="scan-status" aria-label="Scan progress" className="mt-6 max-w-[640px] overflow-hidden rounded-lg border border-border bg-surface">
      <div className="flex flex-col gap-3 px-4 pt-3.5 pb-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
        <ol className="flex min-w-0 flex-col gap-2" aria-live="polite">
          {rows.map(({ step, state, current }) => (
            <li key={step} data-state={state} aria-current={current ? "step" : undefined} className="flex h-6 items-center gap-2.5 text-body">
              <span className="grid size-4 shrink-0 place-items-center" aria-hidden="true">
                {current ? (
                  <span data-testid="step-spinner" className="grid place-items-center text-text">
                    <Spinner />
                  </span>
                ) : state === "done" ? (
                  <CheckIcon className="size-3.5 text-text-2 fade-in" strokeWidth={2.25} />
                ) : state === "active" ? (
                  <span className="size-1.5 rounded-full bg-text-2" />
                ) : (
                  <span className="size-1.5 rounded-full bg-border-strong" />
                )}
              </span>
              <span className={current ? "truncate font-medium text-text" : state === "done" ? "truncate text-text-2" : "truncate text-text-3"}>
                {stepLabel(step, host)}
              </span>
            </li>
          ))}
        </ol>
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border pt-3 sm:justify-start sm:border-0 sm:pt-0">
          <span data-testid="scan-elapsed" className="font-mono text-mono text-text-3 tabular-nums" aria-label={`${elapsed} seconds elapsed`}>
            {elapsed}s
          </span>
          <Button variant="secondary" size="sm" onClick={cancelScan}>
            Cancel
          </Button>
        </div>
      </div>
      {elapsed >= SLOW_SCAN_SECONDS ? (
        <p className="border-t border-border bg-bg px-4 py-2.5 text-small text-text-2 fade-in">Large pages can take up to a minute.</p>
      ) : null}
    </section>
  );
}
