import { NotImplementedError } from "@/server/errors";
import type { SafeFetch } from "@/server/scan/types";

export type SafeFetchErrorCode = "invalid-url" | "blocked-address" | "own-host" | "unsupported-port" | "dns" | "connect" | "timeout" | "too-large" | "too-many-redirects" | "aborted";

export class SafeFetchError extends Error {
  constructor(readonly code: SafeFetchErrorCode, message: string) {
    super(message);
    this.name = "SafeFetchError";
  }
}

export const safeFetch: SafeFetch = async () => {
  throw new NotImplementedError("A: safeFetch");
};
