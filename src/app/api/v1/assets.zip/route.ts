import type { AgentScan } from "@/agent/types";
import { apiError } from "@/server/security/gate";
import { scanFailureResponse } from "../errors";
import { authorizeAgent, gateAgentTarget, parseSelectionParams } from "../gate";
import { agentScanSource } from "../source";
import { buildAssetsZip } from "../zip";

/**
 * `GET /api/v1/assets.zip` (spec section 8): scan a page and stream back the selected files as one archive, for an
 * agent that cannot run the scanner itself. The selection rules are the ones the CLI writes into `scrap/`, and the
 * archive carries the same `manifest.json`, so unzipping it into a project gives what a local download would.
 */

export const runtime = "nodejs";
export const maxDuration = 120;
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const authorized = authorizeAgent(request);
  if (!authorized.ok) return authorized.response;

  const params = new URL(request.url).searchParams;
  const selection = parseSelectionParams(params);
  if (!selection.ok) return apiError(400, "invalid-url", selection.message);

  const target = await gateAgentTarget(params.get("url"), request);
  if (!target.ok) return target.response;

  const source = agentScanSource();
  let scan: AgentScan;
  try {
    scan = await source.scan(target.url, { signal: request.signal });
  } catch (error) {
    return scanFailureResponse(error);
  }

  let built: Awaited<ReturnType<typeof buildAssetsZip>>;
  try {
    built = await buildAssetsZip(scan, source, selection.options, { signal: request.signal });
  } catch (error) {
    return scanFailureResponse(error);
  }

  return new Response(built.stream, {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${built.filename}"`,
      "cache-control": "no-store",
      // Read them to decide whether to ask again with other filters, without unzipping first.
      "x-assets-count": String(built.manifest.files.length),
      "x-assets-bytes": String(built.manifest.totalBytes),
      "x-assets-truncated": String(built.manifest.truncated),
      "x-scan-id": built.manifest.scanId,
    },
  });
}

/** Without these, Next answers a method the file has no export for with a bare, cacheable 405 and no `allow`. */
const refuse = (): Response => apiError(405, "invalid-url", "Use GET with a url parameter.", { allow: "GET" });

export const HEAD = refuse;
export const POST = refuse;
export const PUT = refuse;
export const PATCH = refuse;
export const DELETE = refuse;
export const OPTIONS = refuse;
