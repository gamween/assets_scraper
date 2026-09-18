import { expect, test } from "@playwright/test";

test.describe("response headers", () => {
  test("pages get the app CSP and low-profile headers", async ({ request }) => {
    const headers = (await request.get("/")).headers();
    expect(headers["content-security-policy"]).toContain("script-src 'self' 'unsafe-inline'");
    expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(headers["content-security-policy"]).not.toContain("unsafe-eval");
    expect(headers["x-robots-tag"]).toBe("noindex, nofollow");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["x-powered-by"]).toBeUndefined();
  });

  test("no CSP violation fires on a page load", async ({ page }) => {
    await page.addInitScript(() => {
      const seen: string[] = [];
      (window as unknown as { __csp: string[] }).__csp = seen;
      document.addEventListener("securitypolicyviolation", (event) => seen.push(`${event.violatedDirective} ${event.blockedURI}`));
    });
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([]);
  });

  test("the asset proxy is left to set its own CSP", async ({ request }) => {
    // Next drops a route handler header that next.config already set, so the app CSP must not reach
    // /api/asset or it would replace the proxy's sandbox CSP (spec 11.2).
    for (const path of ["/api/asset", "/api/asset?u=x"]) {
      const headers = (await request.get(path)).headers();
      expect(headers["content-security-policy"] ?? "").not.toContain("script-src");
      expect(headers["x-robots-tag"]).toBe("noindex, nofollow");
    }
  });
});
