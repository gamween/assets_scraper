import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/components/common/cn";

/**
 * Spec 12.6 buttons: primary is ink, secondary is a bordered surface, ghost is text with a well on hover.
 * Heights 28 (inline and icon), 32 (toolbar), 40 (landing). Radius 6. Disabled at 40 percent.
 */
const buttonVariants = cva(
  "group/button relative inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border border-transparent font-medium whitespace-nowrap select-none transition-[background-color,border-color,color,opacity] duration-100 ease-enter focus-ring disabled:pointer-events-none disabled:opacity-40 aria-disabled:pointer-events-none aria-disabled:opacity-40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        primary: "bg-ink text-ink-fg hover:bg-ink-hover active:bg-ink-active",
        secondary: "border-border bg-surface text-text hover:border-border-strong hover:bg-well/60 active:bg-well",
        ghost: "text-text-2 hover:bg-well hover:text-text active:bg-border/60",
        link: "h-auto! px-0! text-text underline decoration-border-strong underline-offset-4 hover:decoration-text",
      },
      size: {
        sm: "h-7 px-2.5 text-small",
        md: "h-8 px-3 text-body",
        lg: "h-10 px-4 text-body",
        "icon-sm": "size-7 text-body",
        icon: "size-8 text-body",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

function Button({ className, variant, size, ...props }: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return <ButtonPrimitive data-slot="button" className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

export { Button, buttonVariants };
