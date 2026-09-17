"use client";

import { Globe } from "lucide-react";
import { useApp } from "@/lib/client/store";

/** Early site header while scanning: the page title arrives with the first `page` event, before any asset. */
export function SiteHeader({ host, loading = true }: { host: string; loading?: boolean }) {
  const title = useApp((s) => s.page?.title) || (loading ? null : host);
  return (
    <div className="flex min-h-[52px] items-center gap-3 pt-8">
      <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-md border border-border bg-well">
        {loading ? null : <Globe className="size-4 text-text-3" />}
      </span>
      <div className="min-w-0">
        {title ? (
          <h1 className="truncate text-title font-semibold text-text fade-in">{title}</h1>
        ) : (
          <div className="flex h-6 items-center">
            <span className="h-3 w-56 rounded-sm bg-well" />
          </div>
        )}
        {title !== host ? <p className="font-mono text-mono text-text-3">{host}</p> : null}
      </div>
    </div>
  );
}
