"use client";

import { ArrowRight, ChevronDown, Download } from "lucide-react";
import { useState } from "react";
import { cn } from "@/components/common/cn";
import { Button } from "@/components/ui/button";
import { buttonVariants } from "@/components/ui/button-variants";
import type { BrandFile } from "@/lib/contract";
import { submitUrl } from "@/lib/client/scan-session";
import { formatBytes } from "@/lib/format";
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

/** A file chip's label: its name, cut like a link's. The type and the size follow it in mono. */
const fileLabel = (file: BrandFile): string => (file.name.length > 32 ? `${file.name.slice(0, 31)}…` : file.name);

/** `ZIP · 29.7 MB`, or the type alone when the host did not say how large the file is. */
const fileMeta = (file: BrandFile): string => [file.type.toUpperCase(), file.bytes === undefined ? "" : formatBytes(file.bytes)].filter(Boolean).join(" · ");

/** Chips that fit beside the palette on one line. The rest wait behind a `+N`. */
const INLINE_CHIPS = 3;

/**
 * Spec 12.2: `Brand resources on this site` chips. A brand link scans that page; a brand file (an archive of logos, the
 * guidelines PDF) opens its URL, which downloads it, since the scan never holds its bytes. Always from the last `page`
 * event, links first.
 *
 * The row is capped so the block always sits beside the palette, right aligned, whatever the chip count: six
 * stripe.com chips took two rows at 1470 and six full-width rows at 390, about 220 px that pushed the first tile to
 * y=780 on an 844 px screen, and whether the block landed beside the palette or under it changed from site to site.
 * On a phone the whole block is one closed disclosure.
 */
export function BrandLinks() {
  const links = useApp((s) => s.page?.brandLinks ?? []);
  const files = useApp((s) => s.page?.brandFiles ?? []);
  const [expanded, setExpanded] = useState(false);
  const count = links.length + files.length;
  if (!count) return null;
  const overflow = Math.max(0, count - INLINE_CHIPS);
  const visibleLinks = expanded ? links : links.slice(0, INLINE_CHIPS);
  const visibleFiles = expanded ? files : files.slice(0, Math.max(0, INLINE_CHIPS - links.length));

  return (
    <div role="group" aria-label="Brand resources on this site" className="flex min-w-0 flex-col gap-2">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        className="focus-ring flex h-6 items-center gap-1.5 self-start rounded-sm text-small font-medium text-text-2 md:hidden"
      >
        Brand resources
        <span className="font-mono text-mono text-text-3 tabular-nums">{count}</span>
        <ChevronDown className={cn("size-3.5 text-text-3 transition-transform duration-150", expanded && "rotate-180")} aria-hidden="true" />
      </button>
      <span aria-hidden="true" className="hidden h-6 items-center text-small font-medium text-text-2 md:flex">
        Brand resources on this site
      </span>
      <div className={cn("flex-wrap gap-2 md:flex", expanded ? "flex" : "hidden")}>
        {visibleLinks.map((link) => (
          <Button key={link.href} variant="secondary" size="sm" title={`Scan ${link.href}`} onClick={() => submitUrl(link.href)}>
            {linkLabel(link)}
            <ArrowRight className="size-3.5 text-text-3" aria-hidden="true" />
          </Button>
        ))}
        {visibleFiles.map((file) => (
          <a
            key={file.id}
            href={file.url}
            target="_blank"
            rel="noopener noreferrer"
            title={`Download ${file.url}`}
            className={cn(buttonVariants({ variant: "secondary", size: "sm" }))}
          >
            {fileLabel(file)}
            <span className="font-mono text-mono text-text-3 tabular-nums">{fileMeta(file)}</span>
            <Download className="size-3.5 text-text-3" aria-hidden="true" />
          </a>
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
