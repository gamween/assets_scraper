import { cn } from "@/components/common/cn";

/** Spec 12.6 badge: mono-xs, well fill, 1 px border, radius 4. Uppercase only for formats. */
export function Badge({
  children,
  className,
  tone = "neutral",
  ...props
}: React.ComponentProps<"span"> & { tone?: "neutral" | "surface" | "success" }) {
  return (
    <span
      {...props}
      className={cn(
        "inline-flex h-5 items-center rounded-sm border px-1.5 font-mono text-mono-xs font-medium whitespace-nowrap",
        tone === "neutral" && "border-border bg-well text-text-2",
        tone === "surface" && "border-border bg-surface/95 text-text-2",
        tone === "success" && "border-success-line bg-success-soft text-success",
        className,
      )}
    >
      {children}
    </span>
  );
}
