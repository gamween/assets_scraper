/** Spec 12.2: a static skeleton grid of 12 tiles, no shimmer, so nothing jumps when results arrive. */
export function SkeletonGrid({ tiles = 12 }: { tiles?: number }) {
  return (
    <div aria-hidden="true" className="mt-8">
      <div className="mb-3 flex h-6 items-center gap-2">
        <span className="h-3 w-14 rounded-sm bg-well" />
        <span className="h-3 w-6 rounded-sm bg-well" />
      </div>
      <div className="asset-grid">
        {Array.from({ length: tiles }, (_, index) => (
          <div key={index} data-testid="skeleton-tile" className="overflow-hidden rounded-lg border border-border bg-surface">
            <div className="aspect-[4/3] bg-well" />
            <div className="flex flex-col gap-2 border-t border-border px-3 py-3">
              <span className="h-2.5 w-3/5 rounded-sm bg-well" />
              <span className="h-2.5 w-2/5 rounded-sm bg-well" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
