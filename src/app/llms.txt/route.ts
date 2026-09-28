import { agentLimits } from "@/agent/limits";
import { zipMaxBytes } from "@/app/api/v1/zip";
import { limits } from "@/server/config/limits";

/**
 * `GET /llms.txt` (spec section 8): what the agent API is, in the plainest text possible, for a model that was handed
 * this URL. `robots.txt` still disallows everything: this page is for agents that are told about it, not for crawlers.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const seconds = (ms: number): string => `${Math.round(ms / 1000)} s`;
const mb = (bytes: number): string => `${Math.round(bytes / (1024 * 1024))} MB`;

export function llmsText(origin: string): string {
  return `# Assets Scraper

Assets Scraper opens a web page in a real browser and reports every SVG, image and font it actually uses, plus the
brand palette. Two endpoints are meant for agents, and both answer one JSON document or one archive, never a stream.

## Authentication

Every request carries a bearer token:

    Authorization: Bearer <token>

Tokens are configured on the server in AGENT_TOKENS, one per client, comma separated. Ask the owner of this
deployment for one. A missing or unknown token is answered with 401 and {"error":{"code":"access-code", ...}}.
A token replaces the bot check that keeps the browser endpoint private, and nothing else: the rate limit, the daily
scan budget, the private address guards and every cap below still apply.

## POST /api/v1/scan

    ${origin}/api/v1/scan

Body: {"url": "stripe.com", "view": "summary"}

  url   the page to scan. A bare host is fine. Only http and https, only ports 80 and 443.
  view  "summary" (default) or "full".

"summary" answers { view, scanId, summary }. The summary is written to stay under 4 KB whatever the page holds: the
page title and host, counts per kind, the palette hexes, one row per font family with its licence and whether it can
be installed, and the logos with their dimensions. Read it first, then ask for what you need.

"full" answers { view, scanId, summary, scan } where scan adds every asset and every font family, in the shapes of
src/lib/contract.ts: assets carry id, kind, role, name, filename, format, dimensions, bytes and their source URLs.
Ask for it from a program that writes the answer to a file, not to read into a context: a page with a few hundred
assets answers hundreds of kilobytes, and the archive below is the way to get the files themselves.

## GET /api/v1/assets.zip

    ${origin}/api/v1/assets.zip

Query: url, profile, kinds, roles, max, maxBytes, maxFileBytes, minLongSide, nameContains

  profile        "deck" (default) keeps what is usable and drops icons, sprites, thumbnails and duplicates.
                 "all" keeps everything the explicit filters allow.
  kinds          comma separated: svg, image
  roles          comma separated: site-logo, logo, favicon, social, icon, illustration, image, sprite-symbol
  max            files to keep, at most ${agentLimits.maxFiles} files
  maxBytes       bytes to keep in total, best scoring files first, default ${mb(agentLimits.maxTotalBytes)} and at most
                 ${mb(zipMaxBytes())}, which is what 0 asks for. Files that do not fit are counted under over-budget
  maxFileBytes   bytes one file may take under the deck profile, default ${mb(agentLimits.maxFileBytes)}, 0 lifts it
  minLongSide    a raster under this many pixels on its longest side is dropped, default ${agentLimits.minLongSide} px.
                 A site logo, a logo and a favicon are never dropped for size, and SVG has no size gate.
  nameContains   keeps the files whose name contains this text

The archive holds svg/, images/ and a manifest.json listing, per file, its path inside the archive, source URL,
dimensions, bytes, role and why it was kept, plus every drop counted by reason. It is the same document the
assets-scraper command writes, so unzipping the archive into scrap/<host>/ gives what a local download would.
The response headers x-assets-count, x-assets-bytes and x-assets-truncated say what came back without unzipping.

## Limits

  ${limits.scansPerDay} scans a day for this deployment, ${limits.scansPerIpPerDay} a day per client address
  ${seconds(limits.scanDeadlineMs)} for one scan, then it answers with what it has
  ${agentLimits.maxFiles} files and ${mb(zipMaxBytes())} for one archive, out of ${mb(limits.proxyBytesPerDay)} of asset bytes a day
  ${limits.maxAssets} assets in one scan

Errors use the codes of the v1 contract with the matching HTTP status: 400 invalid-url, 401 access-code,
422 blocked-address, unsupported-port, own-host or not-html, 429 budget, 502 dns, connect, http or blocked,
503 busy or disabled, 504 timeout, 500 internal. The body is always {"error":{"code","message"}}.

## Examples

Read what a page holds:

    curl -s -X POST ${origin}/api/v1/scan -H "Authorization: Bearer $ASSETS_SCRAPER_TOKEN" -H "content-type: application/json" -d '{"url":"stripe.com"}'

Take the logos and the large images into ./scrap/stripe.com:

    curl -s -L -o assets.zip "${origin}/api/v1/assets.zip?url=stripe.com&profile=deck&max=20" -H "Authorization: Bearer $ASSETS_SCRAPER_TOKEN" && mkdir -p scrap/stripe.com && unzip -o assets.zip -d scrap/stripe.com

## Machine readable

${origin}/api/openapi.json is the OpenAPI 3.1 document for both endpoints.

Fonts are reported here, with their licence, but installing them is the job of the local tools (the assets-scraper
command and its MCP server), which convert and install into the user's font directory.
`;
}

export function GET(request: Request): Response {
  return new Response(llmsText(new URL(request.url).origin), {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" },
  });
}
