import { handleAssetRequest } from "@/server/security/asset-proxy";

export const runtime = "nodejs";

export const GET = (request: Request) => handleAssetRequest(request);

/** Next would run GET for a HEAD without this export; either way the handler refuses a HEAD before any upstream fetch. */
export const HEAD = GET;
