"use client";

import { AssetCard } from "@/components/results/asset-card";
import { PartialBanner, ResultsView } from "@/components/results/results-view";
import { Sections } from "@/components/results/sections";
import { getSections, useApp } from "@/lib/client/store";
import { ErrorPanel } from "./error-panel";
import { SiteHeader } from "./site-header";

/**
 * A failed scan: the error panel replaces the status block. Assets that arrived before the failure stay visible under a
 * partial banner; blocked sites show the fallback assets from public sources, and `not-html` shows the file itself.
 */
export function ErrorView() {
  const error = useApp((s) => s.error);
  const host = useApp((s) => s.host ?? "");
  const hasResults = useApp((s) => s.assets.length + s.fonts.length > 0);
  const sections = useApp(getSections);
  if (!error) return null;

  if (hasResults) {
    return (
      <>
        <div className="page-x">
          <ErrorPanel error={error} />
          <PartialBanner />
        </div>
        <ResultsView />
      </>
    );
  }

  const fallback = error.fallback ?? [];
  return (
    <div className="page-x">
      <SiteHeader host={host} loading={false} />
      <ErrorPanel error={error} />
      {error.code === "not-html" && fallback.length ? (
        <div className="mt-8 asset-grid">
          {fallback.map((asset) => (
            <AssetCard key={asset.id} asset={asset} />
          ))}
        </div>
      ) : fallback.length ? (
        <Sections sections={sections} />
      ) : null}
    </div>
  );
}
