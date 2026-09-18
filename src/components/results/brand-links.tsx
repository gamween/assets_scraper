"use client";

import { ArrowRight, ChevronDown } from "lucide-react";
import { useState } from "react";
import { cn } from "@/components/common/cn";
import { Button } from "@/components/ui/button";
import { submitUrl } from "@/lib/client/scan-session";
import { useApp } from "@/lib/client/store";

/**
 * What a chip says. The link text when it has one, otherwise the last path segment in sentence case: the whole
 * pathname (`/fr/newsroom/news/stripe-openai-instant-checkout`) is not a label, and printing it for some chips while
 * others used their link text put two label styles in the same row.
 */
function linkLabel(link: { href: string; text: string }): string {
  const text = link.text.trim().replace(/\s+/g, " ");
  if (text) return text.length > 32 ? `${text.slice(0, 31)}…` : text;
  try {
    const url = new URL(link.href);
    const segment = url.pathname.replace(/\/+$/, "").split("/").pop() ?? "";
    const words = segment.replace(/\.\w+$/, "").replace(/[-_]+/g, " ").trim();
    if (!words) return url.host;
    return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
  } catch {
    return link.href;
  }
}

/** Chips that fit beside the palette on one line. The rest wait behind a `+N`. */
const INLINE_CHIPS = 3;

/**
 * Spec 12.2: `Brand resources on this site` chips, each one scans that page. Always from the last `page` event.
 *
 * The row is capped so the block always sits beside the palette, right aligned, whatever the chip count: six
 * stripe.com chips took two rows at 1470 and six full-width rows at 390, about 220 px that pushed the first tile to
 * y=780 on an 844 px screen, and whether the block landed beside the palette or under it changed from site to site.
 * On a phone the whole block is one closed disclosure.
 */
export function BrandLinks() {
  const links = useApp((s) => s.page?.brandLinks ?? []);
  const [expanded, setExpanded] = useState(false);
  if (!links.length) return null;
  const overflow = Math.max(0, links.length - INLINE_CHIPS);
  const visible = expanded ? links : links.slice(0, INLINE_CHIPS);

  return (
    <div role="group" aria-label="Brand resources on this site" className="flex min-w-0 flex-col gap-2">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        className="focus-ring flex h-6 items-center gap-1.5 self-start rounded-sm text-small font-medium text-text-2 md:hidden"
      >
        Brand resources
        <span className="font-mono text-mono text-text-3 tabular-nums">{links.length}</span>
        <ChevronDown className={cn("size-3.5 text-text-3 transition-transform duration-150", expanded && "rotate-180")} aria-hidden="true" />
      </button>
      <span aria-hidden="true" className="hidden h-6 items-center text-small font-medium text-text-2 md:flex">
        Brand resources on this site
      </span>
      <div className={cn("flex-wrap gap-2 md:flex", expanded ? "flex" : "hidden")}>
        {visible.map((link) => (
          <Button key={link.href} variant="secondary" size="sm" title={`Scan ${link.href}`} onClick={() => submitUrl(link.href)}>
            {linkLabel(link)}
            <ArrowRight className="size-3.5 text-text-3" aria-hidden="true" />
          </Button>
        ))}
        {overflow && !expanded ? (
          <Button variant="secondary" size="sm" className="hidden md:inline-flex" aria-label={`Show ${overflow} more brand resources`} onClick={() => setExpanded(true)}>
            +{overflow}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
