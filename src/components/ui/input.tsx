import * as React from "react";
import { Input as InputPrimitive } from "@base-ui/react/input";
import { cn } from "@/components/common/cn";

/** Spec 12.6 input: surface, 1 px border, radius 6, focus ring in the accent with a 2 px gap. */
function Input({ className, type = "text", ...props }: React.ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        "h-8 w-full min-w-0 rounded-md border border-border bg-surface px-2.5 text-body text-text transition-[border-color,box-shadow] duration-100 outline-none placeholder:text-text-3/80 hover:border-border-strong focus-visible:border-accent focus-visible:shadow-[0_0_0_3px_var(--accent-soft)] focus-visible:outline-none disabled:opacity-40 aria-invalid:border-danger aria-invalid:focus-visible:shadow-[0_0_0_3px_color-mix(in_srgb,var(--danger)_12%,transparent)]",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
