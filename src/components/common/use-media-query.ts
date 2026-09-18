"use client";

import { useSyncExternalStore } from "react";

/**
 * Matches a media query in the client. The server renders the `false` branch and the client corrects it after
 * hydration, so it is only for text a layout cannot express, never for showing or hiding a whole control.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}
