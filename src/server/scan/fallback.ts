import type { Asset } from "@/lib/contract";
import { NotImplementedError } from "@/server/errors";
import type { PageHead } from "./preflight";
import type { SafeFetch, Signer } from "./types";

export function buildFallback(input: { host: string; pageUrl: string; head: PageHead | null; fetch: SafeFetch; signer: Signer; signal: AbortSignal }): Promise<Asset[]>;
export async function buildFallback(): Promise<Asset[]> {
  throw new NotImplementedError("B: buildFallback");
}
