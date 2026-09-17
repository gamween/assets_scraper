import { expect, test, type Page, type TestInfo } from "@playwright/test";
import type { ScanEvent } from "../src/lib/contract";
import { diagnostics, findAsset, loadFixture } from "./support/fixtures";
import { installControlledScan, mockAssetRoutes, mockScan } from "./support/routes";

/**
 * Responsive screenshots (spec 15 visual QA). Not pixel-compared: they are attached to the report for review. Each
 * screen also checks the layout rules of spec 12.6 that a screenshot review would catch.
 */
const VIEWPORTS = [
  { name: "desktop", width: 1470, height: 956, columns: 6 },
  { name: "laptop", width: 1024, height: 768, columns: 5 },
  { name: "phone", width: 390, height: 844, columns: 2 },
] as const;

const linear = loadFixture("linear");
const siteLogo = findAsset(linear, (a) => a.role === "site-logo" && a.width === 88);

async function capture(page: Page, testInfo: TestInfo, name: string) {
  // Let lazy previews and fades settle.
  await page.waitForTimeout(400);
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await testInfo.attach(name, { path, contentType: "image/png" });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, `${name} scrolls horizontally`).toBeLessThanOrEqual(0);
}

async function openResults(page: Page, events: ScanEvent[] = linear, query = "") {
  await mockAssetRoutes(page, events);
  await mockScan(page, events);
  await page.goto(`/?url=${encodeURIComponent("https://linear.app/")}${query}`);
  await expect(page.getByTestId("results")).toBeVisible();
}

for (const viewport of VIEWPORTS) {
  test.describe(`${viewport.name} ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("landing", async ({ page }, testInfo) => {
      await page.addInitScript(() => localStorage.setItem("assets-scraper:recent", JSON.stringify(["vercel.com", "ripple.com"])));
      await page.goto("/");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await capture(page, testInfo, `landing-${viewport.width}`);
    });

    test("scanning", async ({ page }, testInfo) => {
      const scan = await installControlledScan(page);
      await page.goto("/");
      await page.getByRole("textbox", { name: "Page URL" }).fill("linear.app");
      await page.keyboard.press("Enter");
      await scan.push(
        { type: "accepted", scanId: diagnostics.scanId, url: "https://linear.app/" },
        { type: "step", step: "open", state: "start" },
        { type: "step", step: "load", state: "start" },
        linear.find((event) => event.type === "page")!,
      );
      await expect(page.getByTestId("scan-status")).toBeVisible();
      await capture(page, testInfo, `scanning-${viewport.width}`);
    });

    test("results", async ({ page }, testInfo) => {
      await openResults(page);
      const columns = await page.locator(".asset-grid").first().evaluate((grid) => getComputedStyle(grid).gridTemplateColumns.split(" ").length);
      expect(columns).toBe(viewport.columns);
      await capture(page, testInfo, `results-${viewport.width}`);

      // The top bar and the filter row stay in place while the grid scrolls.
      await page.mouse.wheel(0, 1200);
      await expect.poll(() => page.locator("header").first().boundingBox().then((box) => box?.y)).toBe(0);
      await capture(page, testInfo, `results-scrolled-${viewport.width}`);
    });

    test("detail", async ({ page }, testInfo) => {
      await openResults(page, linear, `&asset=${siteLogo.id}`);
      await expect(page.getByRole("dialog")).toBeVisible();
      await capture(page, testInfo, `detail-${viewport.width}`);
    });

    test("selection bar", async ({ page }, testInfo) => {
      await openResults(page);
      const cards = page.getByTestId("asset-card");
      for (const index of [0, 1, 3]) await cards.nth(index).locator("[data-card-main]").click({ modifiers: ["ControlOrMeta"] });
      const bar = page.getByRole("region", { name: "Selection" });
      await expect(bar).toBeVisible();
      // 12 px above the bottom edge once its slide-in has finished, and inside the viewport.
      await expect.poll(async () => Math.round(viewport.height - (await bar.boundingBox())!.y - (await bar.boundingBox())!.height)).toBe(12);
      const box = (await bar.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
      await capture(page, testInfo, `selection-${viewport.width}`);
    });

    test("error", async ({ page }, testInfo) => {
      await mockScan(page, [
        { type: "accepted", scanId: diagnostics.scanId, url: "https://linear.app/" },
        { type: "error", code: "internal", message: "internal", diagnostics },
      ]);
      await page.goto(`/?url=${encodeURIComponent("https://linear.app/")}`);
      await expect(page.getByTestId("error-panel")).toBeVisible();
      await capture(page, testInfo, `error-${viewport.width}`);
    });
  });
}
