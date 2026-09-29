import type { ErrorCode } from "@/lib/contract";
import { ScanFailure } from "@/server/errors";
import { refundScanBudget } from "@/server/security/budget";
import { apiError } from "@/server/security/gate";

/**
 * One JSON document per answer (spec section 8): the agent API never streams, so a failure the UI reads as an `error`
 * event becomes an HTTP status here. The codes are the v1 ones, so a client that already knows `src/lib/contract.ts`
 * needs nothing new.
 */
const STATUS: Record<ErrorCode, number> = {
  // Refused before the scan (v1 spec 7.1).
  "invalid-url": 400,
  "access-code": 401,
  bot: 403,
  "blocked-address": 422,
  "unsupported-port": 422,
  "own-host": 422,
  "rate-limited": 429,
  budget: 429,
  disabled: 503,
  // Raised by the pipeline. Anything that went wrong reaching the page is a bad gateway: the status of the page itself
  // travels in the message, since answering 404 for a page that 404s would read as the endpoint not existing.
  busy: 503,
  dns: 502,
  connect: 502,
  http: 502,
  blocked: 502,
  "not-html": 422,
  timeout: 504,
  internal: 500,
};

const statusForCode = (code: ErrorCode): number => STATUS[code] ?? 500;

/**
 * The response for a failed scan. A `ScanFailure` carries a v1 code and a message written for a person; anything else
 * is an internal error whose message never reaches the client, and is logged without the URL that caused it.
 *
 * `client` is the caller the gate took a unit of budget from. A `busy` failure is the one case where the unit buys
 * nothing: the queue timed out or the health gate refused the launch, and no page was ever opened, so it is handed
 * back exactly as `/api/scan` hands it back for the browser (v1 spec 7.1 step 7).
 */
export async function scanFailureResponse(error: unknown, client: string | null = null): Promise<Response> {
  if (error instanceof ScanFailure) {
    if (error.code === "busy") await refundScanBudget(client);
    return apiError(statusForCode(error.code), error.code, error.message);
  }
  console.error(`agent API scan failed: ${error instanceof Error ? error.name : typeof error}`);
  return apiError(500, "internal", "Something went wrong on our side");
}

/** A JSON document the agent API answers with. Never cached: a scan is a fresh read of a page every time. */
export const agentJson = (body: unknown, status = 200): Response =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });
