"use client";

import { useEffect } from "react";
import { formatCount } from "@/lib/format";
import { submitUrl } from "@/lib/client/scan-session";
import { appStore, useApp } from "@/lib/client/store";
import { normalizeInputUrl } from "@/lib/url";

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/** Spec 12.5: Cmd/Ctrl+V anywhere (no field focused) with something URL-like starts a scan. */
export function useGlobalShortcuts() {
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      if (isEditableTarget(document.activeElement) || appStore.getState().detailId) return;
      const text = event.clipboardData?.getData("text/plain")?.trim() ?? "";
      if (!text || text.length > 2048 || /\s/.test(text) || !normalizeInputUrl(text).ok) return;
      event.preventDefault();
      submitUrl(text);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, []);
}

/** Tab title follows the scan: `Scanning linear.app`, `48 assets · linear.app`, `Scan failed · linear.app`. */
export function useDocumentTitle() {
  const title = useApp((s) => {
    const host = s.host ?? "";
    if (s.phase === "scanning") return `Scanning ${host}`;
    if (s.phase === "results") return `${formatCount(s.assets.length + s.fonts.length, "asset")} · ${host}`;
    if (s.phase === "error") return `Scan failed · ${host}`;
    return "Assets Scraper";
  });
  useEffect(() => {
    document.title = title;
  }, [title]);
}
