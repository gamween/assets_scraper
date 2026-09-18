"use client";

import { useId } from "react";
import { cn } from "@/components/common/cn";
import type { Section } from "@/lib/client/filters";
import { useApp } from "@/lib/client/store";
import { formatCount } from "@/lib/format";
import { AssetCard } from "./asset-card";
import { FontRow } from "./font-row";

function SectionBlock({ section, tight = false }: { section: Section; tight?: boolean }) {
  const id = useId();
  const expanded = useApp((s) => s.expanded.includes(section.id));
  const toggleSection = useApp((s) => s.toggleSection);
  // Spec 12.4: a collapsed section stays collapsed during a search too, so what shows is what select-all takes.
  const collapsed = section.collapsible && !expanded;

  return (
    // A collapsed section is one line of text, so it drops the 12 px under its header, and a run of them (framer.com
    // ends on three) closes up to 16 px between headers instead of spending 200 px of page on three links and air.
    <section aria-labelledby={`${id}-title`} className={cn(collapsed ? (tight ? "pt-4" : "pt-8") : "section-auto pt-8")}>
      <div className={cn("flex h-6 items-center gap-2", !collapsed && "mb-3")}>
        <h2 id={`${id}-title`} className="text-body font-medium text-text">
          {section.title}
        </h2>
        <span className="font-mono text-mono text-text-3 tabular-nums">{formatCount(section.items.length)}</span>
        {section.collapsible ? (
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={`${id}-body`}
            onClick={() => toggleSection(section.id)}
            className="ml-1 rounded-sm text-small text-text-2 underline decoration-border-strong underline-offset-4 hover:text-text hover:decoration-text focus-ring"
          >
            {expanded ? "Hide" : "Show"}
          </button>
        ) : null}
      </div>
      {collapsed ? null : section.kind === "assets" ? (
        <div id={`${id}-body`} className="asset-grid">
          {section.items.map((asset) => (
            <AssetCard key={asset.id} asset={asset} section={section.id} />
          ))}
        </div>
      ) : (
        <div id={`${id}-body`} className="flex flex-col gap-3">
          {section.items.map((font) => (
            <FontRow key={font.id} font={font} />
          ))}
        </div>
      )}
    </section>
  );
}

export function Sections({ sections }: { sections: Section[] }) {
  const expanded = useApp((s) => s.expanded);
  const collapsed = (section: Section | undefined) => !!section?.collapsible && !expanded.includes(section.id);
  return (
    <>
      {sections.map((section, index) => (
        <SectionBlock key={section.id} section={section} tight={collapsed(section) && collapsed(sections[index - 1])} />
      ))}
    </>
  );
}
