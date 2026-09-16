"use client";

import { useApp } from "@/lib/client/store";

/** Early site header while scanning: the page title arrives with the first `page` event, before any asset. */
export function SiteHeader({ host }: { host: string }) {
  const title = useApp((s) => s.page?.title);
  return (
    <div className="flex min-h-[52px] items-center gap-3 pt-8">
      <span aria-hidden="true" className="size-7 shrink-0 rounded-md border border-border bg-well" />
      <div className="min-w-0">
        {title ? (
          <h1 className="truncate text-title font-semibold text-text fade-in">{title}</h1>
        ) : (
          <div className="flex h-6 items-center">
            <span className="h-3 w-56 rounded-sm bg-well" />
          </div>
        )}
        <p className="font-mono text-mono text-text-3">{host}</p>
      </div>
    </div>
  );
}
