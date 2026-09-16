import type { Page } from "playwright-core";
import type { Palette } from "@/lib/contract";
import { NotImplementedError } from "@/server/errors";
import type { SafeFetch } from "../types";

export function extractPalette(page: Page, options: { fetch: SafeFetch; signal: AbortSignal; timeBudgetMs: number }): Promise<Palette | null>;
export async function extractPalette(): Promise<Palette | null> {
  throw new NotImplementedError("E: extractPalette");
}
