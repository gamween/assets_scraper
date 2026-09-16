"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};
const isApple = () => /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);

/** `⌘` on Apple platforms, `Ctrl` elsewhere. The server renders `⌘` and the client corrects it after hydration. */
export function usePlatformModifier(): string {
  return useSyncExternalStore(subscribe, () => (isApple() ? "⌘" : "Ctrl"), () => "⌘");
}
