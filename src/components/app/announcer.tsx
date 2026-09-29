"use client";

import { useEffect, useState } from "react";
import { stepLabel, stepRows } from "@/components/scan/scan-status";
import { formatCount } from "@/lib/format";
import { appStore, type AppState } from "@/lib/client/store";

type Watched = Pick<AppState, "phase" | "steps" | "host" | "assets" | "fonts" | "selection">;

/**
 * What a screen reader should hear after a store change, or null for nothing new: the step a scan moves to, the end of
 * a scan, and the size of the selection. The error panel is an alert of its own, so a failed scan says nothing here.
 */
export function announcement(previous: Watched, next: Watched): string | null {
  if (next.phase === "scanning") {
    const current = stepRows(next.steps).find((row) => row.current);
    // A scan of another page started while one was still on its first step stands on the same step, and is still news.
    const before = previous.phase === "scanning" && previous.host === next.host ? stepRows(previous.steps).find((row) => row.current) : undefined;
    return current && current.step !== before?.step ? stepLabel(current.step, next.host ?? "") : null;
  }
  if (next.phase === "results" && previous.phase !== "results") {
    const fonts = next.fonts.length ? ` and ${formatCount(next.fonts.length, "font")}` : "";
    return `Scan finished, ${formatCount(next.assets.length, "asset")}${fonts}`;
  }
  if (next.selection.size !== previous.selection.size && next.phase === previous.phase) {
    return next.selection.size ? `${formatCount(next.selection.size)} selected` : "Selection cleared";
  }
  return null;
}

/**
 * One polite status region, mounted for the life of the page. A live region only announces changes to content it
 * already holds: the step list restyled rows that were there from the start, and the selection count arrived together
 * with its bar, so neither was ever read out. This one stays in place and only its text changes.
 */
export function Announcer() {
  const [message, setMessage] = useState("");
  useEffect(
    () =>
      appStore.subscribe((next, previous) => {
        const text = announcement(previous, next);
        if (text) setMessage(text);
      }),
    [],
  );
  return (
    <p role="status" data-testid="announcer" className="sr-only">
      {message}
    </p>
  );
}
