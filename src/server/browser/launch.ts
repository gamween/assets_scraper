import type { Browser, BrowserContext, Page } from "playwright-core";
import { NotImplementedError } from "@/server/errors";

export class BusyError extends Error {}

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  cold: boolean;
  queueMs: number;
  launchMs: number;
  health: { tmpFreeMb?: number; memAvailableMb?: number };
}

export function withBrowser<T>(options: { egressPort: number; signal: AbortSignal; onQueued?: () => void }, fn: (session: BrowserSession) => Promise<T>): Promise<T>;
export async function withBrowser<T>(): Promise<T> {
  throw new NotImplementedError("B: withBrowser");
}
