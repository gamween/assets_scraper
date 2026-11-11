import { expect, test, type Page } from "@playwright/test";

const SECTIONS = ["What your agent gets", "MCP server", "Tools", "CLI", "HTTP API"];

const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

test.describe("agents page", () => {
  test("the landing links to it, and it renders its sections", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "For AI agents" }).click();
    await expect(page).toHaveURL(/\/agents$/);
    await expect(page).toHaveTitle("AI agents · Assets Scraper");
    await expect(page.getByRole("heading", { level: 1, name: "Use Assets Scraper from your AI agent" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2 })).toHaveText(SECTIONS.map((name) => new RegExp(`^${name}`)));
    await expect(page.getByRole("heading", { level: 3 })).toHaveText(["Claude Code", "Any other MCP client"]);
    // The root layout keeps the page out of search results.
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex, nofollow");

    // The wordmark goes back to the scanner.
    await page.getByRole("link", { name: "Assets Scraper" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Every SVG, image and font on a page." })).toBeVisible();
  });

  test("keeps the copy rules: no em dash, no en dash, no exclamation mark", async ({ page }) => {
    await page.goto("/agents");
    const text = await page.locator("body").innerText();
    expect(text).not.toMatch(/[–—]/);
    expect(text).not.toContain("!");
  });

  test("a copy button copies its block as written, with the app toast", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/agents");
    const button = page.getByRole("button", { name: "Copy the MCP config" });
    const shown = await button.locator("xpath=..").locator("pre").innerText();
    await button.click();
    await expect(page.getByTestId("toast")).toContainText("Config copied");
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toBe(shown);
    expect(JSON.parse(copied)).toEqual({
      mcpServers: { "assets-scraper": { command: "node", args: ["/absolute/path/to/assets_scraper/scripts/mcp-launcher.mjs"] } },
    });
  });
});

test.describe("agents page on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("never scrolls the page sideways: a long line scrolls inside its block", async ({ page }) => {
    await page.goto("/agents");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    const curl = page.getByRole("button", { name: "Copy the scan request" }).locator("xpath=..").locator("pre");
    expect(await curl.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  });

  test("the landing header keeps the wordmark and the link apart", async ({ page }) => {
    await page.goto("/");
    const link = page.getByRole("link", { name: "For AI agents" });
    await expect(link).toBeVisible();
    const wordmark = (await page.getByRole("banner").getByText("Assets Scraper").boundingBox())!;
    const box = (await link.boundingBox())!;
    expect(box.x - (wordmark.x + wordmark.width)).toBeGreaterThanOrEqual(24);
    expect(box.x + box.width).toBeLessThanOrEqual(390 - 16 + 6);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });
});
