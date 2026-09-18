"use client";

import { Toast as ToastPrimitive } from "@base-ui/react/toast";
import { cn } from "@/components/common/cn";
import { XIcon } from "lucide-react";

/**
 * One app-wide toast manager (spec 12.6: surface, border, float shadow, radius 12, 13 px text, at most one action).
 * Toasts sit bottom left, and step over the selection bar in the bottom center while it is up (see globals.css).
 */
const toast = ToastPrimitive.createToastManager();

function ToastList() {
  const { toasts } = ToastPrimitive.useToastManager();
  return toasts.map((item) => (
    <ToastPrimitive.Root
      key={item.id}
      toast={item}
      data-testid="toast"
      className={cn(
        "absolute bottom-0 left-0 z-[calc(1000-var(--toast-index))] w-full rounded-xl border border-border bg-surface text-small text-text shadow-float outline-none select-none",
        "[transform:translateY(calc(var(--toast-index)*-8px))_scale(calc(1-var(--toast-index)*0.04))] [transition:transform_200ms_var(--ease-enter),opacity_150ms_var(--ease-enter)]",
        "data-starting-style:[transform:translateY(8px)] data-starting-style:opacity-0 data-ending-style:opacity-0 data-limited:opacity-0",
        "focus-ring",
      )}
    >
      <ToastPrimitive.Content className="flex min-h-11 items-center gap-3 py-2 pr-2 pl-3.5">
        <div className="flex min-w-0 flex-1 flex-col">
          <ToastPrimitive.Title render={<p />} className="text-small font-medium text-text" />
          <ToastPrimitive.Description className="text-small text-text-2" />
        </div>
        {item.actionProps ? (
          <ToastPrimitive.Action className="h-7 shrink-0 rounded-md px-2 text-small font-medium text-text underline decoration-border-strong underline-offset-4 hover:decoration-text focus-ring" />
        ) : null}
        <ToastPrimitive.Close
          aria-label="Dismiss"
          className="grid size-7 shrink-0 place-items-center rounded-md text-text-3 hover:bg-well hover:text-text focus-ring"
        >
          <XIcon className="size-3.5" aria-hidden="true" />
        </ToastPrimitive.Close>
      </ToastPrimitive.Content>
    </ToastPrimitive.Root>
  ));
}

/**
 * Base UI hides an urgent toast from assistive technology until the toast region has focus, and announces its title and
 * description instead. This description adds the key that reaches the region (F6) to that announcement without showing it.
 */
function toastKeyboardHint(action: string): React.ReactNode {
  return <span className="sr-only">Press F6 to reach {action}.</span>;
}

function Toaster({ children }: { children?: React.ReactNode }) {
  return (
    <ToastPrimitive.Provider toastManager={toast} limit={1} timeout={2000}>
      {children}
      <ToastPrimitive.Portal>
        <ToastPrimitive.Viewport data-toast-viewport className="fixed bottom-[calc(16px+env(safe-area-inset-bottom,0px))] left-4 z-[60] w-[min(360px,calc(100vw-32px))] outline-none">
          <ToastList />
        </ToastPrimitive.Viewport>
      </ToastPrimitive.Portal>
    </ToastPrimitive.Provider>
  );
}

export { Toaster, toast, toastKeyboardHint };
