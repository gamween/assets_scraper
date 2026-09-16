import { NotImplementedError } from "@/server/errors";
import type { Signer } from "@/server/scan/types";

export class SignLimitError extends Error {}

export function createSigner(options?: { secret?: string; now?: number; max?: number }): Signer;
export function createSigner(): Signer {
  throw new NotImplementedError("A: createSigner");
}

export function verifyAssetParams(params: URLSearchParams, now?: number, secret?: string): { url: string; dl?: string; fmt?: "ttf" };
export function verifyAssetParams(): { url: string; dl?: string; fmt?: "ttf" } {
  throw new NotImplementedError("A: verifyAssetParams");
}
