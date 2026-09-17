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

const TAB_KEYS = { "1": "all", "2": "svg", "3": "images", "4": "fonts" } as const;

/**
 * Spec 12.5 results keys: `/` search, `1` to `4` tabs, Cmd/Ctrl+A select all visible, Esc clears the selection, then
 * the search. The detail view handles its own keys while it is open.
 */
export function useResultsShortcuts() {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const state = appStore.getState();
      if (state.detailId || event.defaultPrevented || event.isComposing) return;
      if (state.phase !== "results" && !(state.phase === "error" && state.error?.fallback?.length)) return;
      const editable = isEditableTarget(event.target);
      const modifier = event.metaKey || event.ctrlKey;

      if (event.key === "Escape") {
        if (state.selection.size || state.selectionMode) state.clearSelection();
        else if (state.query && !editable) state.setQuery("");
        return;
      }
      if (editable || event.altKey) return;
      if (modifier && (event.key === "a" || event.key === "A")) {
        event.preventDefault();
        state.selectAllVisible();
        return;
      }
      if (modifier) return;
      if (event.key === "/") {
        const search = document.getElementById("results-search");
        if (search) {
          event.preventDefault();
          search.focus();
        }
        return;
      }
      if (event.key in TAB_KEYS && state.phase === "results") {
        event.preventDefault();
        state.setTab(TAB_KEYS[event.key as keyof typeof TAB_KEYS]);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
}
