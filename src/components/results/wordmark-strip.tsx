"use client";

import { useApp } from "@/lib/client/store";
import { copyWithToast } from "./asset-actions";
import { wordmarkCss, wordmarkSettings } from "./labels";

/**
 * Spec 12.2: the live text the page sets as its logo, under the palette, from the last `page` event. Each run is its
 * text after a chip of its colour rather than text drawn in that colour: framer.com's wordmark is white, and would not
 * show on this page. Plain React text, never the page's markup.
 */
export function WordmarkStrip() {
  const wordmark = useApp((s) => s.page?.wordmark);
  if (!wordmark) return null;

  return (
    <section aria-label="Wordmark" className="min-w-0">
      <div className="mb-1.5 flex h-6 items-center gap-3">
        <span className="text-small font-medium text-text-2">Wordmark</span>
        <button
          type="button"
          onClick={() => copyWithToast(wordmarkCss(wordmark), "CSS copied")}
          className="rounded-sm text-small text-text-3 underline decoration-border-strong underline-offset-4 hover:text-text hover:decoration-text focus-ring"
        >
          Copy CSS
        </button>
      </div>
      <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-body text-text">
        {wordmark.runs.map((run, index) => (
          <span key={`${index}${run.hex}`} data-testid="wordmark-run" className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="size-3 shrink-0 rounded-sm border border-swatch-edge" style={{ backgroundColor: run.hex }} />
            <span>{run.text.trim()}</span>
            <span className="font-mono text-mono-xs text-text-3">{run.hex}</span>
          </span>
        ))}
      </p>
      <p data-testid="wordmark-settings" className="mt-1 font-mono text-mono text-text-3 tabular-nums">
        {wordmarkSettings(wordmark)}
        {wordmark.withLogo ? ` · beside a ${wordmark.withLogo.width}×${wordmark.withLogo.height} logo` : ""}
      </p>
    </section>
  );
}
