import { agentLimits } from "@/agent/limits";
import { AssetFormat, AssetKind, AssetRole, ErrorCode, FontLicense } from "@/lib/contract";

/**
 * `GET /api/openapi.json` (spec section 8): the same two endpoints `llms.txt` describes in prose, as OpenAPI 3.1, for
 * a client that generates its calls. The shapes stay loose on purpose: `assets` and `fonts` are the v1 contract, whose
 * one source of truth is `src/lib/contract.ts`, and duplicating it here would be a second one.
 */

const error = (description: string) => ({
  description,
  content: { "application/json": { schema: { $ref: "#/components/schemas/ApiError" } } },
});

/**
 * Every failure both endpoints share, as the v1 codes map onto HTTP (see `src/app/api/v1/errors.ts`), plus what the edge
 * answers before the API runs: Vercel's own mitigation can challenge any path with an HTML page, and the rate limit
 * refuses with a body of its own. Neither is an `ApiError`, and `x-vercel-mitigated` tells them from the API's answers.
 */
const errorResponses = () => ({
  "400": error("invalid-url: the request or the URL could not be read."),
  "401": error("access-code: the bearer token is missing or unknown, or the deployment's access code was not sent in x-access-code."),
  "403": {
    description:
      "Refused at the edge before the API ran: Vercel's own protection can answer any path with an HTML challenge and " +
      "x-vercel-mitigated: challenge. It is not an ApiError. Wait, then try again.",
    headers: { "x-vercel-mitigated": { description: "challenge", schema: { type: "string" } } },
    content: { "text/html": { schema: { type: "string" } } },
  },
  "422": error("blocked-address, unsupported-port, own-host or not-html: the URL cannot be scanned."),
  "429": {
    ...error(
      "budget: the daily scan limit is spent. The edge rate limit (20 requests per 10 minutes per address) answers 429 " +
        "too, before the API runs, with x-vercel-mitigated: deny and a body that is not an ApiError.",
    ),
    headers: { "x-vercel-mitigated": { description: "deny, when the edge rate limit refused the request", schema: { type: "string" } } },
  },
  "500": error("internal: something went wrong on our side."),
  "502": error("dns, connect, http or blocked: the page could not be read."),
  "503": error("busy or disabled: no browser was free, or scanning is paused."),
  "504": error("timeout: the scan did not finish in time."),
});

/** Required only by a deployment the owner put behind `ACCESS_CODE`, which asks a token holder for it too. */
const accessCodeHeader = {
  name: "x-access-code",
  in: "header",
  required: false,
  description: "The deployment's access code, when it has one. A bearer token does not replace it.",
  schema: { type: "string" },
};

const filter = (name: string, description: string, schema: Record<string, unknown>) => ({
  name,
  in: "query",
  required: false,
  description,
  schema,
});

export function openApiDocument(origin: string): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "Assets Scraper agent API",
      version: "1.0.0",
      description:
        "Scan a web page in a real browser and get every SVG, image and font it uses, plus the brand palette. " +
        `See ${origin}/llms.txt for the prose version.`,
      license: { name: "Proprietary", identifier: "LicenseRef-Proprietary" },
    },
    servers: [{ url: origin }],
    security: [{ bearerAuth: [] }],
    paths: {
      "/api/v1/scan": {
        post: {
          operationId: "scanPage",
          summary: "Scan a page and return one JSON document.",
          security: [{ bearerAuth: [] }],
          parameters: [accessCodeHeader],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["url"],
                  properties: {
                    url: { type: "string", maxLength: 2048, description: "The page to scan. A bare host is fine." },
                    view: {
                      type: "string",
                      enum: ["summary", "full"],
                      default: "summary",
                      description: "summary stays under 4 KB; full adds every asset and font family.",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "The scan.",
              content: { "application/json": { schema: { $ref: "#/components/schemas/ScanResponse" } } },
            },
            ...errorResponses(),
          },
        },
      },
      "/api/v1/assets.zip": {
        get: {
          operationId: "downloadAssets",
          summary: "Scan a page and stream the selected files as a ZIP.",
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: "url", in: "query", required: true, description: "The page to scan.", schema: { type: "string", maxLength: 2048 } },
            filter("profile", "deck keeps what is usable; all keeps everything the filters allow.", { type: "string", enum: ["deck", "all"], default: "deck" }),
            filter("kinds", "Comma separated kinds to keep.", { type: "string", examples: [AssetKind.options.join(",")] }),
            filter("roles", "Comma separated roles to keep.", { type: "string", examples: [AssetRole.options.join(",")] }),
            filter("max", `Files to keep, held to ${agentLimits.maxFiles}.`, { type: "integer", minimum: 1, default: agentLimits.maxFiles }),
            filter(
              "minLongSide",
              `Rasters under this many pixels on their longest side are dropped: ${agentLimits.minLongSide} under the deck profile ` +
                "when not given, no gate under all unless given. Site logos, logos, favicons and icons asked for are never dropped for size, and SVG has no size gate.",
              { type: "integer", minimum: 1 },
            ),
            filter("maxBytes", `Bytes to keep in total, best scoring files first, held to what one request serves. 0 means that ceiling.`, {
              type: "integer",
              minimum: 0,
              default: agentLimits.maxTotalBytes,
            }),
            filter(
              "maxFileBytes",
              `Bytes one file may take: ${agentLimits.maxFileBytes} under the deck profile when not given, no ceiling under all ` +
                "unless given. 0 lifts it.",
              { type: "integer", minimum: 0 },
            ),
            filter("nameContains", "Keeps the files whose name contains this text.", { type: "string" }),
            filter("includeIcons", "Keeps the icons the deck profile drops, raster icons under minLongSide included. Naming the icon role does the same.", {
              type: "boolean",
              default: false,
            }),
            accessCodeHeader,
          ],
          responses: {
            "200": {
              description: "A ZIP holding svg/, images/ and manifest.json.",
              headers: {
                "x-assets-count": { description: "Files in the archive.", schema: { type: "integer" } },
                "x-assets-bytes": { description: "Bytes of those files.", schema: { type: "integer" } },
                "x-assets-truncated": { description: "true when a limit ended the archive early.", schema: { type: "boolean" } },
                "x-scan-id": { description: "The scan the archive came from.", schema: { type: "string" } },
              },
              content: { "application/zip": { schema: { type: "string", format: "binary" } } },
            },
            ...errorResponses(),
          },
        },
      },
    },
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
      schemas: {
        ApiError: {
          type: "object",
          required: ["error"],
          properties: {
            error: {
              type: "object",
              required: ["code", "message"],
              properties: { code: { type: "string", enum: ErrorCode.options }, message: { type: "string" } },
            },
          },
        },
        ScanSummary: {
          type: "object",
          description: "Under 4 KB whatever the page holds: lists are capped and every string is cut.",
          required: ["scanId", "page", "counts", "palette", "fonts", "logos", "otherAssets", "warnings", "durationMs"],
          properties: {
            scanId: { type: "string" },
            page: {
              type: "object",
              required: ["url", "finalUrl", "host", "title"],
              properties: {
                url: { type: "string" },
                finalUrl: { type: "string" },
                host: { type: "string" },
                title: { type: "string" },
                siteName: { type: "string" },
              },
            },
            counts: {
              type: "object",
              required: ["assets", "svg", "images", "fonts", "hidden"],
              properties: {
                assets: { type: "integer" },
                svg: { type: "integer" },
                images: { type: "integer" },
                fonts: { type: "integer" },
                hidden: { type: "integer" },
              },
            },
            palette: {
              type: "array",
              items: { type: "object", required: ["hex"], properties: { hex: { type: "string" }, role: { type: "string" } } },
            },
            fonts: {
              type: "array",
              items: {
                type: "object",
                required: ["family", "license", "usedOnPage", "installable"],
                properties: {
                  family: { type: "string" },
                  license: { type: "string", enum: FontLicense.shape.kind.options },
                  usedOnPage: { type: "boolean" },
                  installable: { type: "boolean" },
                },
              },
            },
            logos: {
              type: "array",
              description: "format and bytes tell a wordmark from a large photograph the scan also called a logo.",
              items: {
                type: "object",
                required: ["id", "name", "kind", "format"],
                properties: {
                  id: { type: "string" },
                  name: { type: "string" },
                  kind: { type: "string", enum: AssetKind.options },
                  format: { type: "string", enum: AssetFormat.options },
                  // An SVG's size is whatever its width, height or viewBox say, fractions included.
                  width: { type: "number" },
                  height: { type: "number" },
                  bytes: { type: "integer", description: "When the scan measured it." },
                },
              },
            },
            otherAssets: { type: "integer" },
            warnings: { type: "array", items: { type: "string" } },
            durationMs: { type: "integer" },
          },
        },
        ScanResponse: {
          type: "object",
          required: ["view", "scanId", "summary"],
          properties: {
            view: { type: "string", enum: ["summary", "full"] },
            scanId: { type: "string" },
            summary: { $ref: "#/components/schemas/ScanSummary" },
            scan: {
              type: "object",
              description: "Only in the full view. Assets and font families are the v1 contract shapes of src/lib/contract.ts.",
              required: ["scannedAt", "page", "assets", "fonts", "palette", "stats", "warnings"],
              properties: {
                scannedAt: { type: "string", format: "date-time" },
                page: { type: "object" },
                assets: { type: "array", items: { type: "object" } },
                fonts: { type: "array", items: { type: "object" } },
                palette: { type: ["object", "null"] },
                stats: { type: "object" },
                warnings: { type: "array", items: { type: "string" } },
                diagnostics: { type: "object" },
              },
            },
          },
        },
      },
    },
  };
}

export function GET(request: Request): Response {
  return Response.json(openApiDocument(new URL(request.url).origin), { headers: { "cache-control": "public, max-age=3600" } });
}
