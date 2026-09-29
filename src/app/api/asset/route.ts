import { handleAssetRequest } from "@/server/security/asset-proxy";

export const GET = (request: Request) => handleAssetRequest(request);

/**
 * Every other method gets the handler's own refusal: a JSON 405 with `allow: GET`, never cached, under the sandbox
 * headers, before any upstream fetch (a HEAD would fetch the upstream for headers alone). Without these exports the Next
 * router answers first, with a bare, cacheable 405 and no `allow`, and runs GET for a HEAD.
 */
export const HEAD = GET;
export const POST = GET;
export const PUT = GET;
export const PATCH = GET;
export const DELETE = GET;
export const OPTIONS = GET;
