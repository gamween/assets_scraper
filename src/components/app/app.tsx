"use client";

import { useEffect } from "react";
import { Landing } from "@/components/landing/landing";
import { Toaster } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import { bootstrap, syncFromLocation } from "@/lib/client/scan-session";
import { useApp } from "@/lib/client/store";
import { normalizeInputUrl } from "@/lib/url";
import { useDocumentTitle, useGlobalShortcuts } from "./shortcuts";
import { Workspace } from "./workspace";

export function App({ initialUrl }: { initialUrl: string | null }) {
  const phase = useApp((s) => s.phase);
  const booted = useApp((s) => s.booted);

  useEffect(() => {
    bootstrap();
    const onPopState = () => syncFromLocation();
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useGlobalShortcuts();
  useDocumentTitle();

  // Before the client reads the address bar, a valid `?url=` already renders the scanning layout.
  const pending = !booted && initialUrl ? normalizeInputUrl(initialUrl) : null;
  const pendingHost = pending?.ok ? pending.host : null;

  return (
    <TooltipProvider>
      <Toaster>{phase === "idle" && !pendingHost ? <Landing /> : <Workspace pendingHost={pendingHost} />}</Toaster>
    </TooltipProvider>
  );
}
