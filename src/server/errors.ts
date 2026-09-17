import type { Asset, ErrorCode } from "@/lib/contract";

export class ScanFailure extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly options: { httpStatus?: number; fallback?: Asset[] } = {},
  ) {
    super(message);
    this.name = "ScanFailure";
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message = code,
  ) {
    super(message);
    this.name = "HttpError";
  }
}
