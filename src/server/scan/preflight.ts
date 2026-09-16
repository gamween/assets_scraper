import { NotImplementedError } from "@/server/errors";
import type { SafeFetch } from "./types";

export interface PageHead {
  title?: string;
  siteName?: string;
  icons: { href: string; rel: string; sizes?: string; type?: string }[];
  ogImages: string[];
  jsonLdLogos: string[];
  manifestUrl?: string;
}

export interface PreflightResult {
  finalUrl: string;
  status: number;
  contentType: string;
  headers: Record<string, string>;
  head: PageHead | null;
}

export function parseHead(html: string, baseUrl: string): PageHead;
export function parseHead(): PageHead {
  throw new NotImplementedError("B: parseHead");
}

export function preflight(url: string, options: { fetch: SafeFetch; signal: AbortSignal }): Promise<PreflightResult>;
export async function preflight(): Promise<PreflightResult> {
  throw new NotImplementedError("B: preflight");
}
