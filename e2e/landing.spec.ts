import { expect, test } from "@playwright/test";
import { loadFixture } from "./support/fixtures";
import { mockAssetRoutes, mockScan } from "./support/routes";

test.describe("landing", () => {
  test("shows the title, subline, focused input, Scan button and Try chips", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle("Assets Scraper");
    await expect(page.getByRole("heading", { level: 1, name: "Every SVG, image and font on a page." })).toBeVisible();
    await expect(page.getByText("Paste a URL. Download one file, a selection or everything.")).toBeVisible();

    const input = page.getByRole("textbox", { name: "Page URL" });
    await expect(input).toBeFocused();
    await expect(input).toHaveAttribute("placeholder", "linear.app");
    await expect(input).not.toHaveAttribute("type", "url");
    await expect(page.getByRole("button", { name: "Scan", exact: true })).toBeVisible();

    await expect(page.getByRole("group", { name: "Try" }).getByRole("button")).toHaveText(["stripe.com", "linear.app", "framer.com"]);
    await expect(page.getByRole("group", { name: "Recent" })).toHaveCount(0);
    await expect(page.getByText("Scans aren't saved. Assets belong to their owners.")).toBeVisible();
  });

  test("submitting a host starts a scan and puts it in the address", async ({ page }) => {
    const events = loadFixture("stripe");
    await mockAssetRoutes(page, events);
    const scan = await mockScan(page, events);
    await page.goto("/");
    await page.getByRole("textbox", { name: "Page URL" }).fill("stripe.com");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/\?url=https%3A%2F%2Fstripe\.com%2F$/);
    await expect.poll(() => scan.bodies).toEqual([{ url: "https://stripe.com/" }]);
  });

  test("an invalid address shows the inline error and keeps focus", async ({ page }) => {
    const scan = await mockScan(page, []);
    await page.goto("/");
    const input = page.getByRole("textbox", { name: "Page URL" });
    await input.fill("not a url");
    await page.getByRole("button", { name: "Scan", exact: true }).click();
    await expect(page.getByText("Enter a web address, like linear.app")).toBeVisible();
    await expect(input).toBeFocused();
    await expect(input).toHaveAttribute("aria-invalid", "true");
    await expect(page).toHaveURL(/\/$/);
    expect(scan.bodies).toEqual([]);
    await input.fill("linear");
    await expect(page.getByText("Enter a web address, like linear.app")).toHaveCount(0);
  });

  test("pasting a URL with no field focused starts a scan", async ({ page }) => {
    const events = loadFixture("linear");
    await mockAssetRoutes(page, events);
    await mockScan(page, events);
    await page.goto("/");
    await page.getByRole("textbox", { name: "Page URL" }).blur();
    await page.evaluate(() => {
      const data = new DataTransfer();
      data.setData("text/plain", "  linear.app ");
      document.body.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await expect(page).toHaveURL(/\/\?url=https%3A%2F%2Flinear\.app%2F$/);
  });

  test("pasting text that is not a URL does nothing", async ({ page }) => {
    const scan = await mockScan(page, []);
    await page.goto("/");
    await page.getByRole("textbox", { name: "Page URL" }).blur();
    await page.evaluate(() => {
      const data = new DataTransfer();
      data.setData("text/plain", "hello there, general");
      document.body.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    expect(scan.bodies).toEqual([]);
  });

  test("a Try chip scans, then Recent chips appear and survive a reload", async ({ page }) => {
    const events = loadFixture("linear");
    await mockAssetRoutes(page, events);
    await mockScan(page, events);
    await page.goto("/");
    await page.getByRole("group", { name: "Try" }).getByRole("button", { name: "linear.app" }).click();
    await expect(page).toHaveTitle(/^\d+ assets · linear\.app$/);

    await page.getByRole("link", { name: "Assets Scraper" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Every SVG, image and font on a page." })).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
    const recent = page.getByRole("group", { name: "Recent" });
    await expect(recent.getByRole("button", { name: "linear.app", exact: true })).toBeVisible();

    await page.reload();
    await expect(recent.getByRole("button", { name: "linear.app", exact: true })).toBeVisible();
    await recent.getByRole("button", { name: "Remove linear.app" }).click();
    await expect(recent).toHaveCount(0);
  });

  test("the address bar URL scans on load", async ({ page }) => {
    const events = loadFixture("linear");
    await mockAssetRoutes(page, events);
    const scan = await mockScan(page, events);
    await page.goto("/?url=https%3A%2F%2Flinear.app%2F");
    await expect(page).toHaveTitle(/^\d+ assets · linear\.app$/);
    expect(scan.bodies).toEqual([{ url: "https://linear.app/" }]);
    await page.goBack().catch(() => {});
  });
});
