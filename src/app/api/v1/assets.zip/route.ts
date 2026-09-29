import type { AgentScan } from "@/agent/types";
import { apiError } from "@/server/security/gate";
import { scanFailureResponse } from "../errors";
import { authorizeAgent, gateAgentTarget, parseSelectionParams } from "../gate";
import { zipDeadlineMs } from "../limits";
import { agentScanSource } from "../source";
import { buildAssetsZip } from "../zip";

/**
 * `GET /api/v1/assets.zip` (spec section 8): scan a page and stream back the selected files as one archive, for an
 * agent that cannot run the scanner itself. The selection rules are the ones the CLI writes into `scrap/`, and the
 * archive carries the same `manifest.json`, so unzipping it into a project gives what a local download would.
 */

export async function GET(request: Request): Promise<Response> {
  const started = Date.now();
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
    return scanFailureResponse(error, target.client);
  }

  // Counted from the request's arrival, whatever the scan took, so the archive always goes out before the platform's
  // limit: what is not fetched and compared by then is left out, and the manifest says so.
  const deadline = AbortSignal.any([request.signal, AbortSignal.timeout(Math.max(0, started + zipDeadlineMs() - Date.now()))]);
  let built: Awaited<ReturnType<typeof buildAssetsZip>>;
  try {
    built = await buildAssetsZip(scan, source, selection.options, { signal: deadline, client: target.client });
  } catch (error) {
    return scanFailureResponse(error, target.client);
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
