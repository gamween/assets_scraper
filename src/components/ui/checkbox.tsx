"use client";

import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { cn } from "@/components/common/cn";
import { CheckIcon } from "lucide-react";

/** Spec 12.6: 16 px, radius 4, 1.5 px strong border; checked is the accent fill with a white check. */
function Checkbox({ className, ...props }: CheckboxPrimitive.Root.Props) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer relative flex size-4 shrink-0 items-center justify-center rounded-sm border-[1.5px] border-border-strong bg-surface text-accent-fg transition-colors duration-100 outline-none after:absolute after:-inset-2 hover:border-text-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent data-checked:border-accent data-checked:bg-accent",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator data-slot="checkbox-indicator" className="grid place-content-center text-current">
        <CheckIcon className="size-3" strokeWidth={3} />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
