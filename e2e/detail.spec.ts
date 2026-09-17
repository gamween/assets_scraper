import { expect, test, type Page } from "@playwright/test";
import type { ScanEvent } from "../src/lib/contract";
import { findAsset, loadFixture, mapAssets } from "./support/fixtures";
import { mockAssetRoutes, mockScan } from "./support/routes";

const linear = loadFixture("linear");
const siteLogo = findAsset(linear, (a) => a.role === "site-logo" && a.width === 88);
const photo = findAsset(linear, (a) => a.kind === "image" && a.role === "image" && a.visible && (a.renderedWidth ?? 0) > 100);

async function openResults(page: Page, events: ScanEvent[] = linear, query = "") {
  await mockAssetRoutes(page, events);
  await mockScan(page, events);
  await page.goto(`/?url=${encodeURIComponent("https://linear.app/")}${query}`);
  await expect(page.getByTestId("results")).toBeVisible();
}

const card = (page: Page, id: string) => page.locator(`[data-asset-id="${id}"] [data-card-main]`);
const dialog = (page: Page) => page.getByRole("dialog");

test.describe("detail view", () => {
  test("opens with name, badge, metadata and counter, and arrows move within the tab", async ({ page }) => {
    await openResults(page);
    const cards = page.getByTestId("asset-card");
    const total = await cards.count();
    const secondName = await cards.nth(1).getAttribute("data-name");
    const lastName = await cards.nth(total - 1).getAttribute("data-name");

    await card(page, siteLogo.id).click();
    const detail = dialog(page);
    await expect(detail).toBeVisible();
    await expect(detail.getByRole("heading", { name: siteLogo.name })).toBeVisible();
    await expect(detail.getByTestId("detail-badge")).toHaveText("Logo");
    await expect(detail.getByTestId("detail-counter")).toHaveText(`1 of ${total}`);
    const meta = detail.getByTestId("detail-meta");
    await expect(meta.locator("dt")).toHaveText(["Format", "Dimensions", "File size", "Found in", "Used", "Source"]);
    await expect(meta.locator("dd").nth(4)).toHaveText(siteLogo.usedCount === 1 ? "Once" : `${siteLogo.usedCount} times`);
    await expect(meta).toContainText("SVG");
    await expect(meta).toContainText("88×22");
    await expect(meta).toContainText("Inline <svg>");

    await page.keyboard.press("ArrowRight");
    await expect(detail.getByTestId("detail-counter")).toHaveText(`2 of ${total}`);
    await expect(detail.getByRole("heading", { level: 2 })).toHaveText(secondName!);
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await expect(detail.getByTestId("detail-counter")).toHaveText(`${total} of ${total}`);
    await expect(detail.getByRole("heading", { level: 2 })).toHaveText(lastName!);
    await detail.getByRole("button", { name: "Next" }).click();
    await expect(detail.getByTestId("detail-counter")).toHaveText(`1 of ${total}`);
  });

  test("counts within the current search", async ({ page }) => {
    await openResults(page);
    await page.getByRole("searchbox", { name: "Filter by name or URL" }).fill("linear-logo");
    const count = await page.getByTestId("asset-card").count();
    expect(count).toBeGreaterThan(1);
    await page.getByTestId("asset-card").first().locator("[data-card-main]").click();
    await expect(dialog(page).getByTestId("detail-counter")).toHaveText(`1 of ${count}`);
  });

  test("Esc closes and focus returns to the card", async ({ page }) => {
    await openResults(page);
    await card(page, siteLogo.id).click();
    await expect(dialog(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
    await expect(card(page, siteLogo.id)).toBeFocused();
  });

  test("D downloads and C copies SVG markup", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openResults(page);
    await card(page, siteLogo.id).click();
    await expect(dialog(page)).toBeVisible();

    const download = page.waitForEvent("download");
    await page.keyboard.press("d");
    expect((await download).suggestedFilename()).toBe(siteLogo.filename);

    await page.keyboard.press("c");
    await expect(page.getByTestId("toast")).toContainText("SVG code copied");
    const text = await page.evaluate(() => navigator.clipboard.readText());
    expect(text.startsWith("<svg")).toBe(true);
  });

  test("O opens remote sources in a new page and does nothing for inline SVGs", async ({ page, context }) => {
    await context.route("https://e2e.test/**", (route) => route.fulfill({ status: 200, contentType: "text/plain", body: "source" }));
    await openResults(page);
    await card(page, siteLogo.id).click();
    await expect(dialog(page).getByRole("button", { name: /Open source/ })).toHaveCount(0);
    let opened = false;
    context.on("page", () => {
      opened = true;
    });
    await page.keyboard.press("o");
    await page.waitForTimeout(400);
    expect(opened).toBe(false);
    await page.keyboard.press("Escape");

    await card(page, photo.id).click();
    const popup = context.waitForEvent("page");
    await page.keyboard.press("o");
    const source = await popup;
    await source.waitForLoadState();
    expect(source.url()).toBe(photo.original!.url);
  });

  test("&asset= opens the detail after results load and closing removes it", async ({ page }) => {
    await openResults(page, linear, `&asset=${photo.id}`);
    await expect(dialog(page).getByRole("heading", { level: 2 })).toHaveText(photo.name);
    await page.getByRole("button", { name: "Close" }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(page).toHaveURL(/\?url=https%3A%2F%2Flinear\.app%2F$/);

    await card(page, siteLogo.id).click();
    await expect(page).toHaveURL(new RegExp(`&asset=${siteLogo.id}$`));
  });

  test("&asset= for a small icon walks its collapsed section without expanding it for good", async ({ page }) => {
    const icon = findAsset(linear, (a) => a.kind === "svg" && a.role === "icon");
    await openResults(page, linear, `&asset=${icon.id}`);
    await expect(dialog(page).getByRole("heading", { level: 2 })).toHaveText(icon.name);
    await expect(dialog(page).getByTestId("detail-counter")).toHaveText(/^\d+ of \d+$/);
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
    const small = page.getByRole("region", { name: "Small icons", exact: true });
    await expect(small.getByRole("button", { name: "Show" })).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator(`[data-asset-id="${icon.id}"]`)).toHaveCount(0);
  });

  test("Download as displayed appears only when the framing changed", async ({ page }) => {
    const other = findAsset(linear, (a) => a.kind === "image" && a.role === "image" && a.id !== photo.id && !!a.original);
    const events = mapAssets(linear, (asset) => (asset.id === photo.id ? { ...asset, aspectChanged: true } : asset));
    await openResults(page, events);
    await card(page, photo.id).click();
    const displayed = dialog(page).getByRole("button", { name: "Download as displayed" });
    await expect(displayed).toBeVisible();
    await expect(dialog(page).getByRole("button", { name: `Download ${photo.format.toUpperCase()}` })).toBeVisible();
    await page.keyboard.press("Escape");

    await page.getByRole("searchbox", { name: "Filter by name or URL" }).fill(other.filename);
    await card(page, other.id).click();
    await expect(dialog(page).getByRole("heading", { level: 2 })).toHaveText(other.name);
    await expect(dialog(page).getByRole("button", { name: "Download as displayed" })).toHaveCount(0);
  });

  test("the Code block shows markup as text", async ({ page }) => {
    await openResults(page);
    await card(page, siteLogo.id).click();
    const code = dialog(page).getByTestId("detail-code");
    await expect(code).toHaveCount(0);
    await dialog(page).getByRole("button", { name: "Code", exact: true }).click();
    await expect(code).toBeVisible();
    await expect(code).toContainText("<svg");
    expect(await code.locator("svg, path").count()).toBe(0);
    expect(await code.evaluate((el) => el.textContent?.startsWith("<svg"))).toBe(true);
  });

  test("is a full-screen sheet on phones", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openResults(page);
    await card(page, siteLogo.id).click();
    await expect(dialog(page)).toBeVisible();
    await expect.poll(() => dialog(page).boundingBox()).toEqual({ x: 0, y: 0, width: 390, height: 844 });
  });
});
