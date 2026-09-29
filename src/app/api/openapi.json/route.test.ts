import { describe, expect, it } from "vitest";
import { summarize } from "@/agent/summary";
import { testAsset, testScan } from "@/agent/testing";
import { ErrorCode } from "@/lib/contract";
import { GET } from "./route";

const ORIGIN = "https://assets.example.com";

/** `Response.json()` is untyped, which is what lets the test read the document by path. */
const document = async () => (await GET(new Request(`${ORIGIN}/api/openapi.json`))).json();

type Schema = { $ref?: string; type?: string | string[]; enum?: unknown[]; required?: string[]; properties?: Record<string, Schema>; items?: Schema };

const typeOf = (value: unknown): string =>
  value === null ? "null" : Array.isArray(value) ? "array" : Number.isInteger(value) ? "integer" : typeof value;

/**
 * What in `value` the schema does not describe, for the part of JSON Schema this document uses. Stricter than the
 * document itself on one point: a field the schema does not list counts, since a generated client would drop it.
 */
function schemaErrors(value: unknown, schema: Schema, schemas: Record<string, Schema>, at = "$"): string[] {
  if (schema.$ref) return schemaErrors(value, schemas[schema.$ref.split("/").pop()!], schemas, at);
  const types = schema.type === undefined ? [] : [schema.type].flat();
  const actual = typeOf(value);
  if (types.length > 0 && !types.includes(actual) && !(actual === "integer" && types.includes("number"))) return [`${at} is ${actual}, not ${types.join(" or ")}`];
  if (schema.enum && !schema.enum.includes(value)) return [`${at} is ${String(value)}, not one of the enum`];
  const errors: string[] = [];
  if (actual === "object" && schema.properties) {
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in record)) errors.push(`${at}.${key} is missing`);
    for (const [key, field] of Object.entries(record)) {
      const property = schema.properties[key];
      errors.push(...(property ? schemaErrors(field, property, schemas, `${at}.${key}`) : [`${at}.${key} is not in the schema`]));
    }
  }
  if (actual === "array" && schema.items) (value as unknown[]).forEach((item, index) => errors.push(...schemaErrors(item, schema.items!, schemas, `${at}[${index}]`)));
  return errors;
}

describe("GET /api/openapi.json", () => {
  it("is a JSON document an agent may cache", async () => {
    const response = await GET(new Request(`${ORIGIN}/api/openapi.json`));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^application\/json/);
    expect(response.headers.get("cache-control")).toMatch(/max-age/);
  });

  it("parses as OpenAPI 3.1, served from the host that answered", async () => {
    const doc = await document();
    expect(doc.openapi).toMatch(/^3\.1\./);
    expect(doc.info.title).toBe("Assets Scraper agent API");
    expect(doc.info.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(doc.servers).toEqual([{ url: ORIGIN }]);
  });

  it("describes the scan endpoint", async () => {
    const operation = (await document()).paths["/api/v1/scan"].post;
    expect(operation.security).toEqual([{ bearerAuth: [] }]);
    const body = operation.requestBody.content["application/json"].schema;
    expect(body.required).toEqual(["url"]);
    expect(body.properties.view.enum).toEqual(["summary", "full"]);
    expect(body.properties.view.default).toBe("summary");
    expect(Object.keys(operation.responses)).toContain("200");
    expect(operation.responses["200"].content["application/json"].schema.$ref).toBe("#/components/schemas/ScanResponse");
  });

  it("describes the ZIP endpoint with its filters", async () => {
    const operation = (await document()).paths["/api/v1/assets.zip"].get;
    const names = operation.parameters.filter((parameter: { in: string }) => parameter.in === "query").map((parameter: { name: string }) => parameter.name);
    expect(names).toEqual(["url", "profile", "kinds", "roles", "max", "minLongSide", "maxBytes", "maxFileBytes", "nameContains", "includeIcons"]);
    expect(operation.parameters[0].required).toBe(true);
    expect(operation.parameters[1].schema.enum).toEqual(["deck", "all"]);
    expect(operation.responses["200"].content["application/zip"].schema.format).toBe("binary");
  });

  it("names the access code header a deployment behind one asks for, next to the token", async () => {
    const doc = await document();
    for (const operation of [doc.paths["/api/v1/scan"].post, doc.paths["/api/v1/assets.zip"].get]) {
      const header = operation.parameters.find((parameter: { name: string }) => parameter.name === "x-access-code");
      expect(header).toMatchObject({ in: "header", required: false });
    }
    expect(doc.paths["/api/v1/scan"].post.responses["401"].description).toContain("x-access-code");
  });

  /** Regression: summarize() always sends a logo's format, and its bytes when measured, which the schema left out. */
  it("describes the logo rows the summary actually sends", async () => {
    const logos = (await document()).components.schemas.ScanSummary.properties.logos.items;
    expect(logos.required).toEqual(["id", "name", "kind", "format"]);
    expect(Object.keys(logos.properties)).toEqual(expect.arrayContaining(["format", "bytes", "width", "height"]));
  });

  it("documents the bearer scheme and every error code with its status", async () => {
    const doc = await document();
    expect(doc.components.securitySchemes.bearerAuth).toEqual({ type: "http", scheme: "bearer" });
    expect(doc.components.schemas.ApiError.properties.error.properties.code.enum).toEqual(ErrorCode.options);
    for (const status of ["400", "401", "422", "429", "500", "502", "503", "504"]) {
      for (const operation of [doc.paths["/api/v1/scan"].post, doc.paths["/api/v1/assets.zip"].get]) {
        expect(operation.responses[status].content["application/json"].schema.$ref).toBe("#/components/schemas/ApiError");
      }
    }
  });

  it("documents what the edge answers before the API runs", async () => {
    const doc = await document();
    for (const operation of [doc.paths["/api/v1/scan"].post, doc.paths["/api/v1/assets.zip"].get]) {
      // Vercel's own protection can challenge any path with an HTML page, which a client must not parse as an ApiError.
      expect(Object.keys(operation.responses["403"].content)).toEqual(["text/html"]);
      expect(operation.responses["403"].headers["x-vercel-mitigated"]).toBeDefined();
      expect(operation.responses["429"].headers["x-vercel-mitigated"]).toBeDefined();
      expect(operation.responses["429"].description).toMatch(/20 requests per 10 minutes/);
    }
  });

  /**
   * A client generated from this document drops what the schema does not list and rejects what it types wrongly. The
   * summary grew `format` and `bytes` on its logo rows without the schema, which also typed an SVG's fractional width as
   * an integer: this validates a real summary, so the next field added to `summarize` fails here first.
   */
  it("describes every field a summary carries, with its type", async () => {
    const doc = await document();
    const wordmark = testAsset({ id: "wordmark", kind: "svg", format: "svg", role: "site-logo", width: 79.5, height: 24.25, bytes: 1_234, score: 100 });
    const scan = testScan();
    const summary = summarize({ ...scan, assets: [wordmark, ...scan.assets], warnings: ["The page stopped the scan early"] });
    expect(summary.logos[0]).toMatchObject({ id: "wordmark", format: "svg", width: 79.5, bytes: 1_234 });
    expect(summary.fonts.length).toBeGreaterThan(0);
    expect(schemaErrors({ view: "summary", scanId: summary.scanId, summary }, { $ref: "#/components/schemas/ScanResponse" }, doc.components.schemas)).toEqual([]);
  });

  it("keeps the copy rules: no em dash, no en dash, no emoji", async () => {
    const text = await (await GET(new Request(`${ORIGIN}/api/openapi.json`))).text();
    expect(text).not.toMatch(/[\u2013\u2014]/);
    expect(text).not.toMatch(/[\u{1f300}-\u{1faff}\u{2600}-\u{27bf}]/u);
  });
});
