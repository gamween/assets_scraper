import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cn } from "@/components/common/cn";
import { buttonVariants, type ButtonVariants } from "./button-variants";

/** The Base UI button with the spec 12.6 styles. Links styled as buttons take `buttonVariants` from ./button-variants. */
function Button({ className, variant, size, ...props }: ButtonPrimitive.Props & ButtonVariants) {
  return <ButtonPrimitive data-slot="button" className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

export { Button };
