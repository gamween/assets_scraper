import { expect, test, type Page } from "@playwright/test";
import { loadFixture } from "./support/fixtures";
import { mockAssetRoutes, mockScan } from "./support/routes";

const linear = loadFixture("linear");

async function openResults(page: Page) {
  await mockAssetRoutes(page, linear);
  await mockScan(page, linear);
  await page.goto(`/?url=${encodeURIComponent("https://linear.app/")}`);
  await expect(page.getByTestId("results")).toBeVisible();
}

test.describe("phone toolbar", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("the filter placeholder is not squeezed by the Select button", async ({ page }) => {
    await openResults(page);
    // Touch emulation is what brings the `Select` button on screen, and what used to squeeze the input.
    await expect(page.getByRole("button", { name: "Select" })).toBeVisible();

    const room = await page.getByLabel("Filter by name or URL").evaluate((element: HTMLInputElement) => {
      const style = getComputedStyle(element);
      const context = document.createElement("canvas").getContext("2d")!;
      context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      return {
        placeholder: Math.ceil(context.measureText(element.placeholder).width),
        available: Math.floor(element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)),
      };
    });
    expect(room.placeholder, "the whole placeholder must fit the input").toBeLessThanOrEqual(room.available);

    // The `/` chip is a keyboard hint: a touch device has no keyboard to press it with.
    await expect(page.getByText("/", { exact: true })).toBeHidden();
  });

  test("Select still turns the checkboxes on", async ({ page }) => {
    await openResults(page);
    await page.getByRole("button", { name: "Select" }).click();
    await expect(page.getByRole("button", { name: "Done" })).toBeVisible();
    await expect(page.getByTestId("asset-card").first().getByRole("checkbox")).toBeVisible();
  });
});
