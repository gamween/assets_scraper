import { agentLimits } from "@/agent/limits";
import { AssetFormat, AssetKind, AssetRole, ErrorCode } from "@/lib/contract";

/**
 * `GET /api/openapi.json` (spec section 8): the same two endpoints `llms.txt` describes in prose, as OpenAPI 3.1, for
 * a client that generates its calls. The shapes stay loose on purpose: `assets` and `fonts` are the v1 contract, whose
 * one source of truth is `src/lib/contract.ts`, and duplicating it here would be a second one.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const error = (description: string) => ({
  description,
  content: { "application/json": { schema: { $ref: "#/components/schemas/ApiError" } } },
});

/** Every failure both endpoints share, as the v1 codes map onto HTTP (see `src/app/api/v1/errors.ts`). */
const errorResponses = () => ({
  "400": error("invalid-url: the request or the URL could not be read."),
  "401": error("access-code: the bearer token is missing or unknown, or the deployment's access code was not sent in x-access-code."),
  "422": error("blocked-address, unsupported-port, own-host or not-html: the URL cannot be scanned."),
  "429": error("budget: the daily scan limit is spent."),
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
              `Rasters under this many pixels on their longest side are dropped, ${agentLimits.minLongSide} by default under the deck profile and ` +
                "none under all unless given. Site logos, logos, favicons and icons asked for are never dropped for size, and SVG has no size gate.",
              { type: "integer", minimum: 1 },
            ),
            filter("maxBytes", `Bytes to keep in total, best scoring files first, held to what one request serves. 0 means that ceiling.`, {
              type: "integer",
              minimum: 0,
              default: agentLimits.maxTotalBytes,
            }),
            filter("maxFileBytes", "Bytes one file may take under the deck profile. 0 lifts the ceiling.", {
              type: "integer",
              minimum: 0,
              default: agentLimits.maxFileBytes,
            }),
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
                  license: { type: "string", enum: ["open", "commercial", "unknown"] },
                  usedOnPage: { type: "boolean" },
                  installable: { type: "boolean" },
                },
              },
            },
            logos: {
              type: "array",
              items: {
                type: "object",
                description: "The format and the size tell a wordmark from a photograph the scan also called a logo.",
                required: ["id", "name", "kind", "format"],
                properties: {
                  id: { type: "string" },
                  name: { type: "string" },
                  kind: { type: "string", enum: AssetKind.options },
                  format: { type: "string", enum: AssetFormat.options },
                  width: { type: "integer" },
                  height: { type: "integer" },
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
