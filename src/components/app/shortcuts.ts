"use client";

import { useEffect } from "react";
import { formatCount } from "@/lib/format";
import { submitUrl } from "@/lib/client/scan-session";
import { appStore, useApp, type AppState } from "@/lib/client/store";
import { displayHost, normalizeInputUrl } from "@/lib/url";

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * The URL a paste should scan, or null when the text is not one URL-like token. Shared with the landing field, which
 * is autofocused and so never reaches the document listener below.
 */
export function pastedScanUrl(text: string | undefined): string | null {
  const trimmed = text?.trim() ?? "";
  if (!trimmed || trimmed.length > 2048 || /\s/.test(trimmed) || !normalizeInputUrl(trimmed).ok) return null;
  return trimmed;
}

/** Spec 12.5: Cmd/Ctrl+V anywhere (no field focused) with something URL-like starts a scan. */
export function useGlobalShortcuts() {
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      if (isEditableTarget(document.activeElement) || appStore.getState().detailId) return;
      const url = pastedScanUrl(event.clipboardData?.getData("text/plain"));
      if (!url) return;
      event.preventDefault();
      submitUrl(url);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, []);
}

/**
 * Tab title follows the scan: `Scanning linear.app`, `48 assets · linear.app`, `Scan failed · linear.app`. The count is
 * SVGs and images only, like `stats.assets`.
 */
export function useDocumentTitle() {
  const title = useApp((s) => {
    const host = displayHost(s.page?.host ?? s.host ?? "");
    if (s.phase === "scanning") return `Scanning ${host}`;
    if (s.phase === "results") return `${formatCount(s.assets.length, "asset")} · ${host}`;
    if (s.phase === "error") return `Scan failed · ${host}`;
    return "Assets Scraper";
  });
  useEffect(() => {
    document.title = title;
  }, [title]);
}

const TAB_KEYS = { "1": "all", "2": "svg", "3": "images", "4": "fonts" } as const;

/**
 * Which results keys apply: the full set wherever the results grid shows (a finished scan, or a failed one that still
 * delivered assets, like a timeout), and everything but the tabs over the fallback assets of a blocked site.
 */
export function shortcutScope(state: Pick<AppState, "phase" | "assets" | "fonts" | "error">): "results" | "fallback" | null {
  if (state.phase === "results") return "results";
  if (state.phase !== "error") return null;
  if (state.assets.length + state.fonts.length > 0) return "results";
  return state.error?.fallback?.length ? "fallback" : null;
}

/**
 * Spec 12.5 results keys: `/` search, `1` to `4` tabs, Cmd/Ctrl+A select all visible, Esc clears the selection, then
 * the search. The detail view handles its own keys while it is open.
 */
export function useResultsShortcuts() {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const state = appStore.getState();
      if (state.detailId || event.defaultPrevented || event.isComposing) return;
      const scope = shortcutScope(state);
      if (!scope) return;
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
      if (event.key in TAB_KEYS && scope === "results") {
        event.preventDefault();
        state.setTab(TAB_KEYS[event.key as keyof typeof TAB_KEYS]);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
}
