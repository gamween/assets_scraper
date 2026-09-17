import { scanEngine } from "@/server/scan/engine";
import { eventsToResponse } from "@/server/scan/stream";
import { gateScanRequest, type GateResult } from "@/server/security/gate";

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
