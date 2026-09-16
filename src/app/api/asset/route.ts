import { handleAssetRequest } from "@/server/security/asset-proxy";

export const runtime = "nodejs";

export const GET = (request: Request) => handleAssetRequest(request);
