import * as z from "zod";
import { summarize } from "@/agent/summary";
import type { AgentScan } from "@/agent/types";
import { ScanRequest } from "@/lib/contract";
import { apiError } from "@/server/security/gate";
import { agentJson, scanFailureResponse } from "../errors";
import { authorizeAgent, gateAgentTarget, readAgentJson } from "../gate";
import { agentScanSource } from "../source";

/**
 * `POST /api/v1/scan` (spec section 8): one scan, one JSON document, for an agent holding a bearer token. The UI reads
 * `/api/scan` as an NDJSON stream of events; an agent wants the result, so this endpoint waits for the scan and answers
 * the summary it can read without spending its context, or the whole thing on request.
 */

export const runtime = "nodejs";
export const maxDuration = 120;
export const dynamic = "force-dynamic";

const AgentScanRequest = ScanRequest.extend({ view: z.enum(["summary", "full"]).default("summary") });

/** The `full` view is everything the agent core's `AgentScan` holds, minus where the scan ran, which the client knows. */
const fullScan = (scan: AgentScan) => ({
  scannedAt: scan.scannedAt,
  page: scan.page,
  assets: scan.assets,
  fonts: scan.fonts,
  palette: scan.palette,
  stats: scan.stats,
  warnings: scan.warnings,
  ...(scan.diagnostics === undefined ? {} : { diagnostics: scan.diagnostics }),
});

export async function POST(request: Request): Promise<Response> {
  const authorized = authorizeAgent(request);
  if (!authorized.ok) return authorized.response;

  const parsed = AgentScanRequest.safeParse(await readAgentJson(request));
  if (!parsed.success) return apiError(400, "invalid-url", 'Send {"url": "stripe.com", "view": "summary" | "full"} as JSON.');

  const target = await gateAgentTarget(parsed.data.url, request);
  if (!target.ok) return target.response;

  let scan: AgentScan;
  try {
    scan = await agentScanSource().scan(target.url, { signal: request.signal });
  } catch (error) {
    return scanFailureResponse(error);
  }

  const summary = summarize(scan);
  return agentJson(
    parsed.data.view === "full"
      ? { view: "full", scanId: scan.scanId, summary, scan: fullScan(scan) }
      : { view: "summary", scanId: scan.scanId, summary },
  );
}

/**
 * Next answers a method the file has no export for with a bare, cacheable 405 and no `allow`, so every other method is
 * bound to the same refusal `/api/scan` gives.
 */
const refuse = (): Response => apiError(405, "invalid-url", "Use POST with a JSON body.", { allow: "POST" });

export const GET = refuse;
export const HEAD = refuse;
export const PUT = refuse;
export const PATCH = refuse;
export const DELETE = refuse;
export const OPTIONS = refuse;
