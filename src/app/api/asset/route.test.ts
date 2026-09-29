import { describe, expect, it } from "vitest";
import { DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT } from "./route";

const CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; sandbox";

describe("/api/asset", () => {
  it("refuses HEAD with 405 before checking anything else", async () => {
    // an unsigned URL and no Sec-Fetch-Site: a GET would get 403, so the 405 shows the method is checked first
    const response = await HEAD(new Request("https://app.local/api/asset?u=x", { method: "HEAD" }));
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await GET(new Request("https://app.local/api/asset?u=x"))).status).toBe(403);
  });

  it("binds every other method to the handler's JSON refusal, so Next does not answer a bare 405 first", async () => {
    for (const [method, handler] of Object.entries({ POST, PUT, PATCH, DELETE, OPTIONS })) {
      const response = await handler(new Request("https://app.local/api/asset?u=x", { method }));
      expect(response.status, method).toBe(405);
      expect(response.headers.get("allow"), method).toBe("GET");
      expect(response.headers.get("cache-control"), method).toBe("no-store");
      expect(response.headers.get("content-security-policy"), method).toBe(CSP);
      expect(await response.json(), method).toEqual({ error: { code: "method", message: "Use GET." } });
    }
  });
});
