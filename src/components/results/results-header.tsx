"use client";

import { Download, Globe, Link2, LoaderCircle, RotateCw } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { formatCount, formatDuration } from "@/lib/format";
import { previewSrc } from "@/lib/client/asset-bytes";
import { rescan, shareablePath } from "@/lib/client/scan-session";
import { useApp } from "@/lib/client/store";
import { copyWithToast } from "./asset-actions";
import { downloadAll } from "@/components/selection/zip-actions";

function SiteFavicon() {
  const favicon = useApp((s) => s.page?.favicon);
  const [useProxy, setUseProxy] = useState(false);
  const [failed, setFailed] = useState(false);
  const src = favicon ? (useProxy ? favicon.proxy : previewSrc(favicon)) : null;
  return (
    <span className="grid size-8 shrink-0 place-items-center overflow-hidden rounded-md border border-border bg-surface">
      {src && !failed ? (
        <img
          key={src}
          src={src}
          alt=""
          referrerPolicy="no-referrer"
          className="size-5 object-contain"
          onError={() => (useProxy || !favicon?.proxy ? setFailed(true) : setUseProxy(true))}
        />
      ) : (
        <Globe className="size-4 text-text-3" aria-hidden="true" />
      )}
    </span>
  );
}

/** Spec 12.2 results header: favicon, page title, mono meta, `Copy link`, `Rescan`, `Download all`. */
export function ResultsHeader({ actions = true }: { actions?: boolean }) {
  const title = useApp((s) => s.page?.title || s.page?.host || s.host || "");
  const host = useApp((s) => s.page?.host ?? s.host ?? "");
  const url = useApp((s) => s.url);
  const count = useApp((s) => s.assets.length + s.fonts.length);
  const duration = useApp((s) => s.done?.stats.durationMs);
  const zip = useApp((s) => s.zip);
  const zippingAll = zip?.source === "all";

  return (
    <header className="flex flex-wrap items-center justify-between gap-x-8 gap-y-4 pt-7">
      <div className="flex min-w-0 items-center gap-3">
        <SiteFavicon />
        <div className="min-w-0">
          <h1 className="truncate text-title font-semibold text-text">{title}</h1>
          <p data-testid="results-meta" className="truncate font-mono text-mono text-text-3 tabular-nums">
            {[host, formatCount(count, "asset"), duration !== undefined ? formatDuration(duration) : null].filter(Boolean).join(" · ")}
          </p>
        </div>
      </div>
      {actions ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            onClick={() => {
              if (url) copyWithToast(`${window.location.origin}${shareablePath(url)}`, "Link copied");
            }}
          >
            <Link2 aria-hidden="true" />
            Copy link
          </Button>
          <Button variant="secondary" onClick={rescan}>
            <RotateCw aria-hidden="true" />
            Rescan
          </Button>
          <Button variant="primary" onClick={downloadAll} disabled={count === 0 || (zip !== null && !zippingAll)} aria-live="polite">
            {zippingAll ? <LoaderCircle className="spinner" aria-hidden="true" /> : <Download aria-hidden="true" />}
            <span className="tabular-nums">{zippingAll ? `Zipping ${zip.done} of ${zip.total}` : "Download all"}</span>
          </Button>
        </div>
      ) : null}
    </header>
  );
}
