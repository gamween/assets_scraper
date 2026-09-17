import { describe, expect, it } from "vitest";
import { GET, HEAD } from "./route";

describe("/api/asset", () => {
  it("refuses HEAD with 405 before checking anything else", async () => {
    // an unsigned URL and no Sec-Fetch-Site: a GET would get 403, so the 405 shows the method is checked first
    const response = await HEAD(new Request("https://app.local/api/asset?u=x", { method: "HEAD" }));
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await GET(new Request("https://app.local/api/asset?u=x"))).status).toBe(403);
  });
});
