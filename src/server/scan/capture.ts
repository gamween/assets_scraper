import type { Page } from "playwright-core";
import { NotImplementedError } from "@/server/errors";
import type { CapturedNetwork } from "./types";

export interface CaptureHandle {
  settle(timeoutMs: number): Promise<CapturedNetwork>;
}

export function startCapture(page: Page, options: { signal: AbortSignal }): CaptureHandle;
export function startCapture(): CaptureHandle {
  throw new NotImplementedError("B: startCapture");
}
