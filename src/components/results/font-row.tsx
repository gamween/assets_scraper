"use client";

import type { FontFamily } from "@/lib/contract";

/** Font family row (spec 12.3). */
export function FontRow({ font }: { font: FontFamily }) {
  return (
    <article data-testid="font-row" className="rounded-lg border border-border bg-surface px-5 py-4">
      <h3 className="text-body font-medium text-text">{font.name}</h3>
    </article>
  );
}
