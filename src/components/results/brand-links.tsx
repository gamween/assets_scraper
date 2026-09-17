"use client";

import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { submitUrl } from "@/lib/client/scan-session";
import { useApp } from "@/lib/client/store";

function linkLabel(link: { href: string; text: string }): string {
  const text = link.text.trim();
  if (text) return text.length > 40 ? `${text.slice(0, 39)}…` : text;
  try {
    return new URL(link.href).pathname.replace(/\/$/, "") || link.href;
  } catch {
    return link.href;
  }
}

/** Spec 12.2: `Brand resources on this site` chips, each one scans that page. Always from the last `page` event. */
export function BrandLinks() {
  const links = useApp((s) => s.page?.brandLinks ?? []);
  if (!links.length) return null;
  return (
    <div role="group" aria-label="Brand resources on this site" className="flex min-w-0 flex-col gap-2">
      <span aria-hidden="true" className="flex h-6 items-center text-small font-medium text-text-2">
        Brand resources on this site
      </span>
      <div className="flex flex-wrap gap-2">
        {links.map((link) => (
          <Button key={link.href} variant="secondary" size="sm" title={`Scan ${link.href}`} onClick={() => submitUrl(link.href)}>
            {linkLabel(link)}
            <ArrowRight className="size-3.5 text-text-3" aria-hidden="true" />
          </Button>
        ))}
      </div>
    </div>
  );
}
