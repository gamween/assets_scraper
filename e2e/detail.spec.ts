import { expect, test, type Page } from "@playwright/test";
import type { ScanEvent } from "../src/lib/contract";
import { diagnostics, findAsset, loadFixture, mapAssets } from "./support/fixtures";
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
  test("the Source row shows the whole URL and copies it in one click", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openResults(page);
    await card(page, photo.id).click();
    const detail = dialog(page);
    await expect(detail).toBeVisible();
    const source = (photo.original ?? photo.display)!.url;
    const link = detail.getByTestId("detail-meta").getByRole("link");
    // The URL is not shortened: what is on screen is the address itself, and the title carries all of it.
    await expect(link).toHaveText(source);
    await expect(link).toHaveAttribute("title", source);
    await expect(link).toHaveAttribute("href", source);

    await detail.getByRole("button", { name: "Copy source URL" }).click();
    await expect(page.getByTestId("toast")).toContainText("Source URL copied");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(source);
  });

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
    await expect(detail.getByTestId("detail-badge")).toHaveText("Site logo");
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

  test("preview images never take the pointer, so their blob: URL can't be opened in a tab", async ({ page }) => {
    await openResults(page);
    // The element under the center of an image: what a context menu, a long press or a drag would act on.
    const hitAtCenter = (image: ReturnType<Page["locator"]>) =>
      image.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return hit ? (hit.getAttribute("data-testid") ?? (hit.hasAttribute("data-card-main") ? "card-main" : hit.tagName.toLowerCase())) : null;
      });

    const tileImage = page.locator(`[data-asset-id="${siteLogo.id}"] img`);
    await expect(tileImage).toHaveAttribute("src", /^blob:/);
    expect(await hitAtCenter(tileImage)).toBe("card-main");

    await card(page, siteLogo.id).click();
    const detailImage = dialog(page).getByTestId("detail-well").locator("img");
    await expect(detailImage).toHaveAttribute("src", /^blob:/);
    await expect(detailImage).toHaveCSS("opacity", "1");
    expect(await hitAtCenter(detailImage)).toBe("detail-preview-shield");
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
    // Every role has a badge in the detail view, plain images included.
    await expect(dialog(page).getByTestId("detail-badge")).toHaveText("Image");
    await page.getByRole("button", { name: "Close" }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(page).toHaveURL(/\?url=https%3A%2F%2Flinear\.app%2F$/);

    await card(page, siteLogo.id).click();
    await expect(page).toHaveURL(new RegExp(`&asset=${siteLogo.id}$`));
  });

  test("&asset= opens the detail when a timed-out scan still delivered assets", async ({ page }) => {
    const timedOut: ScanEvent[] = [...linear.filter((event) => event.type !== "done"), { type: "error", code: "timeout", message: "stream timeout", diagnostics }];
    await mockAssetRoutes(page, timedOut);
    await mockScan(page, timedOut);
    await page.goto(`/?url=${encodeURIComponent("https://linear.app/")}&asset=${photo.id}`);
    await expect(dialog(page).getByRole("heading", { level: 2 })).toHaveText(photo.name);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("error-panel")).toBeVisible();
    await expect(page).toHaveURL(/\?url=https%3A%2F%2Flinear\.app%2F$/);
  });

  test("&asset= opens a public-source asset of a blocked scan", async ({ page }) => {
    const fallback = { ...siteLogo, id: "fallback-logo", foundIn: ["public-source" as const] };
    const blocked: ScanEvent[] = [
      { type: "accepted", scanId: diagnostics.scanId, url: "https://linear.app/" },
      { type: "error", code: "blocked", message: "stream blocked", fallback: [fallback], diagnostics },
    ];
    await mockAssetRoutes(page, blocked);
    await mockScan(page, blocked);
    await page.goto(`/?url=${encodeURIComponent("https://linear.app/")}&asset=${fallback.id}`);
    await expect(dialog(page).getByRole("heading", { level: 2 })).toHaveText(fallback.name);
  });

  test("&asset= dies with a scan that failed: a later scan does not open it", async ({ page }) => {
    const failed: ScanEvent[] = [
      { type: "accepted", scanId: diagnostics.scanId, url: "https://linear.app/" },
      { type: "error", code: "connect", message: "stream connect", diagnostics },
    ];
    await mockAssetRoutes(page, linear);
    await mockScan(page, failed, linear);
    await page.goto(`/?url=${encodeURIComponent("https://linear.app/")}&asset=${photo.id}`);
    await expect(page.getByTestId("error-panel")).toBeVisible();
    await expect(page).toHaveURL(/\?url=https%3A%2F%2Flinear\.app%2F$/);
    await page.getByTestId("error-panel").getByRole("button", { name: "Try again" }).click();
    await expect(page.getByTestId("results")).toBeVisible();
    await expect(page.getByTestId("asset-card").first()).toBeVisible();
    await page.waitForTimeout(300);
    await expect(dialog(page)).toHaveCount(0);
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
