import { cn } from "cn";

/** Shortcut chip: mono-xs, radius 4. `onInk` for chips inside primary buttons. */
export function Kbd({ children, className, onInk = false }: { children: React.ReactNode; className?: string; onInk?: boolean }) {
  return (
    <kbd
      className={cn(
        "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-sm border px-1 font-mono text-mono-xs font-medium",
        onInk ? "border-white/15 bg-white/10 text-ink-fg/75" : "border-border bg-surface text-text-3",
        className,
      )}
    >
      {children}
    </kbd>
  );
}
