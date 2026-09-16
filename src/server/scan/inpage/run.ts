import type { Page } from "playwright-core";
import { NotImplementedError } from "@/server/errors";

export function runInPage<T>(page: Page, source: string, expression: string, options: { timeoutMs: number }): Promise<{ value: T; world: "isolated" | "main" }>;
export async function runInPage<T>(): Promise<{ value: T; world: "isolated" | "main" }> {
  throw new NotImplementedError("B: runInPage");
}
