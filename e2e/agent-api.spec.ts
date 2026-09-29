import { expect, test } from "@playwright/test";

/**
 * The agent API as it is served (plan Task G4.4). The test server runs without `AGENT_TOKENS`, so both endpoints refuse
 * every caller here: what this asserts is that they are wired, that they refuse rather than crash, and that the two
 * machine readable descriptions are reachable, `robots.txt` included, while it keeps crawlers out of everything else.
 */

test.describe("agent API", () => {
  test("llms.txt describes the endpoints in plain text", async ({ request }) => {
    const response = await request.get("/llms.txt");
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("text/plain; charset=utf-8");
    const text = await response.text();
    expect(text).toContain("POST /api/v1/scan");
    expect(text).toContain("GET /api/v1/assets.zip");
    expect(text).toContain("Authorization: Bearer");
    expect(text).toMatch(/curl/);
    expect(text).not.toMatch(/[\u2013\u2014]/);
  });

  test("openapi.json describes both endpoints", async ({ request }) => {
    const response = await request.get("/api/openapi.json");
    expect(response.status()).toBe(200);
    const doc = await response.json();
    expect(doc.openapi).toMatch(/^3\.1\./);
    expect(Object.keys(doc.paths).sort()).toEqual(["/api/v1/assets.zip", "/api/v1/scan"]);
    expect(doc.servers[0].url).toMatch(/^http:\/\/localhost:\d+$/);
  });

  test("robots.txt disallows everything but llms.txt and openapi.json", async ({ request }) => {
    const response = await request.get("/robots.txt");
    expect(response.status()).toBe(200);
    const lines = (await response.text()).split("\n").map((line) => line.trim());
    expect(lines).toContain("User-Agent: *");
    expect(lines).toContain("Allow: /llms.txt");
    expect(lines).toContain("Allow: /api/openapi.json");
    expect(lines).toContain("Disallow: /");
    expect(lines.filter((line) => line.startsWith("Allow:"))).toHaveLength(2);
  });

  test("both endpoints refuse a caller with no bearer token", async ({ request }) => {
    const scan = await request.post("/api/v1/scan", { data: { url: "linear.app" } });
    expect(scan.status()).toBe(401);
    expect(scan.headers()["www-authenticate"]).toBe("Bearer");
    expect(scan.headers()["cache-control"]).toBe("no-store");
    expect(await scan.json()).toEqual({ error: { code: "access-code", message: "This endpoint needs a bearer token." } });

    const zip = await request.get("/api/v1/assets.zip?url=linear.app");
    expect(zip.status()).toBe(401);
    expect((await zip.json()).error.code).toBe("access-code");
  });

  test("the wrong method is refused by the route, not by a bare router 405", async ({ request }) => {
    const scan = await request.get("/api/v1/scan");
    expect(scan.status()).toBe(405);
    expect(scan.headers()["allow"]).toBe("POST");
    expect(scan.headers()["cache-control"]).toBe("no-store");

    const zip = await request.post("/api/v1/assets.zip");
    expect(zip.status()).toBe(405);
    expect(zip.headers()["allow"]).toBe("GET");
  });
});
