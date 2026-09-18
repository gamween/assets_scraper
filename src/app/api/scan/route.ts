import { scanEngine } from "@/server/scan/engine";
import { eventsToResponse } from "@/server/scan/stream";
import { gateScanRequest, refuseScanMethod, type GateResult } from "@/server/security/gate";

export const runtime = "nodejs";
export const maxDuration = 120;
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  let gate: GateResult;
  try {
    gate = await gateScanRequest(request);
  } catch {
    return Response.json({ error: { code: "internal", message: "Something went wrong on our side" } }, { status: 500, headers: { "cache-control": "no-store" } });
  }
  if (!gate.ok) return gate.response;
  return eventsToResponse(scanEngine.scan({ url: gate.url }, { signal: request.signal }), request.signal);
}

/**
 * Every other method answers with the gate's own refusal, so the 405 carries `allow: POST` and `cache-control:
 * no-store` (spec 7.1 step 1). Without these exports the Next router answers first with a bare, cacheable 405 and the
 * gate's method branch is dead code in production.
 */
export const GET = refuseScanMethod;
export const HEAD = refuseScanMethod;
export const PUT = refuseScanMethod;
export const PATCH = refuseScanMethod;
export const DELETE = refuseScanMethod;
export const OPTIONS = refuseScanMethod;
