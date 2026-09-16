import type { Page } from "playwright-core";
import { NotImplementedError } from "@/server/errors";

export interface NavigationResult {
  status: number;
  finalUrl: string;
  title: string;
  headers: Record<string, string>;
  elementCount: number;
  htmlSample: string;
}

export function openPage(page: Page, url: string, options: { signal: AbortSignal }): Promise<NavigationResult>;
export async function openPage(): Promise<NavigationResult> {
  throw new NotImplementedError("B: openPage");
}

export function loadAndScroll(page: Page, options: { signal: AbortSignal; onStep: (step: "load" | "scroll", state: "start" | "done") => void }): Promise<void>;
export async function loadAndScroll(): Promise<void> {
  throw new NotImplementedError("B: loadAndScroll");
}

export function prepareForCollection(page: Page): Promise<void>;
export async function prepareForCollection(): Promise<void> {
  throw new NotImplementedError("B: prepareForCollection");
}
