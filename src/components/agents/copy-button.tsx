"use client";

import { Copy } from "lucide-react";
import { copyWithToast } from "@/components/results/asset-actions";

/** The one piece of client code on the `/agents` page: copies a code block as written and confirms with the app toast. */
export function CopyButton({ text, label, message }: { text: string; label: string; message: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={() => copyWithToast(text, message)}
      className="focus-ring-tight grid size-7 shrink-0 place-items-center rounded-md text-text-3 transition-colors duration-100 hover:bg-surface hover:text-text"
    >
      <Copy className="size-3.5" aria-hidden="true" />
    </button>
  );
}
