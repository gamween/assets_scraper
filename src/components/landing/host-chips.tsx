"use client";

import { XIcon } from "lucide-react";
import { forgetRecent, submitUrl } from "@/lib/client/scan-session";

/** A labeled row of host chips; each chip scans its host. Recent chips can be removed. */
export function HostChips({ label, hosts, removable = false }: { label: string; hosts: string[]; removable?: boolean }) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-1.5">
      <span aria-hidden="true" className="w-14 shrink-0 text-small text-text-3">
        {label}
      </span>
      {hosts.map((host) => (
        <span key={host} className="group/chip inline-flex h-7 items-stretch overflow-hidden rounded-md border border-border bg-surface transition-colors duration-100 hover:border-border-strong">
          <button
            type="button"
            onClick={() => submitUrl(host)}
            className="px-2.5 font-mono text-mono text-text-2 outline-none hover:text-text focus-visible:bg-well focus-visible:text-text"
          >
            {host}
          </button>
          {removable ? (
            <button
              type="button"
              aria-label={`Remove ${host}`}
              onClick={() => forgetRecent(host)}
              className="grid w-6 place-items-center border-l border-border text-text-3 outline-none hover:bg-well hover:text-text focus-visible:bg-well focus-visible:text-text"
            >
              <XIcon className="size-3" aria-hidden="true" />
            </button>
          ) : null}
        </span>
      ))}
    </div>
  );
}
