import { cn } from "cn";

/** The only looping animation in the app. Reduced motion turns it into a static dot. */
export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("spinner inline-block size-3.5 shrink-0 rounded-full border-[1.5px] border-current border-r-transparent", className)}
    />
  );
}
