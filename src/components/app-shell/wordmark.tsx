import { cn } from "cn";

/** App mark: an ink tile holding a transparency checker, the one image every asset tool shows. */
export function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" className={cn("size-5 shrink-0", className)}>
      <rect width="20" height="20" rx="5" fill="var(--ink)" />
      <rect x="5" y="5" width="5" height="5" rx="0.75" fill="var(--ink-fg)" />
      <rect x="10" y="10" width="5" height="5" rx="0.75" fill="var(--ink-fg)" />
      <rect x="10" y="5" width="5" height="5" rx="0.75" fill="var(--ink-fg)" opacity="0.28" />
      <rect x="5" y="10" width="5" height="5" rx="0.75" fill="var(--ink-fg)" opacity="0.28" />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 text-body font-semibold tracking-[-0.01em] text-text", className)}>
      <Mark />
      Assets Scraper
    </span>
  );
}
