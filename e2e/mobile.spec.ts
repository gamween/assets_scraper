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

/** The 360 px toast and the bottom centre bar share the bottom edge on a narrow window, and the toast wins on z-index. */
async function expectToastClearOfTheBar(page: Page) {
  await openResults(page);
  const select = page.getByRole("button", { name: "Select" });
  if (await select.isVisible()) await select.click();
  const card = page.getByTestId("asset-card").first();
  await card.locator("[data-card-main]").hover();
  await card.getByRole("checkbox").click();
  const bar = page.getByRole("region", { name: "Selection" });
  await expect(bar).toBeVisible();
  // Any toast will do.
  await page.getByRole("region", { name: "Palette" }).getByRole("button", { name: /^Copy #/ }).first().click();
  const toast = page.getByTestId("toast");
  await expect(toast).toBeVisible();
  const box = (await toast.boundingBox())!;
  const over = (await bar.boundingBox())!;
  const overlaps = box.x < over.x + over.width && over.x < box.x + box.width && box.y < over.y + over.height && over.y < box.y + box.height;
  expect(overlaps, "the toast must not cover the selection bar").toBe(false);
  await expect(bar.getByRole("button", { name: "Download ZIP" })).toBeVisible();
}

test.describe("phone toolbar", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("the filter placeholder is not squeezed by the Select button", async ({ page }) => {
    await openResults(page);
    // Touch emulation is what brings the `Select` button on screen, and what used to squeeze the input.
    await expect(page.getByRole("button", { name: "Select" })).toBeVisible();
    // Every tab still reads without scrolling the strip sideways.
    const tabs = page.getByRole("tablist");
    expect(await tabs.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);

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

  test("the home link keeps its name when its label is hidden", async ({ page }) => {
    await openResults(page);
    await expect(page.getByRole("link", { name: "Assets Scraper" })).toBeVisible();
  });

  test("Done leaves selection mode and keeps the selection", async ({ page }) => {
    await openResults(page);
    await page.getByRole("button", { name: "Select" }).click();
    for (const index of [0, 1, 2]) await page.getByTestId("asset-card").nth(index).getByRole("checkbox").click();
    const bar = page.getByRole("region", { name: "Selection" });
    await expect(bar.getByTestId("selection-count")).toContainText("3 selected");
    // Done says the picking is over, not that the picks are thrown away: Clear is the explicit discard.
    await page.getByRole("button", { name: "Done" }).click();
    await expect(bar.getByTestId("selection-count")).toContainText("3 selected");
    await expect(bar.getByRole("button", { name: "Download ZIP" })).toBeVisible();
  });

  test("a toast never covers the selection bar", ({ page }) => expectToastClearOfTheBar(page));

  test("the detail arrows do not share a band with the asset", async ({ page }) => {
    await openResults(page);
    await page.locator("[data-card-main]").first().click();
    const detail = page.getByRole("dialog");
    await expect(detail).toBeVisible();
    // The shield spans exactly the box the artwork may fill, so an arrow inside it is an arrow an asset can touch.
    const box = (await detail.getByTestId("detail-preview-shield").boundingBox())!;
    for (const name of ["Previous", "Next"]) {
      const arrow = (await detail.getByRole("button", { name }).boundingBox())!;
      const overlaps = arrow.x < box.x + box.width && box.x < arrow.x + arrow.width && arrow.y < box.y + box.height && box.y < arrow.y + arrow.height;
      expect(overlaps, `${name} must not share the band the asset fills`).toBe(false);
    }
    await detail.getByRole("button", { name: "Next" }).click();
    await expect(detail.getByTestId("detail-counter")).toHaveText(/^2 of /);
  });

  test("the font specimen and the palette stay readable", async ({ page }) => {
    await openResults(page);
    await page.getByRole("tab", { name: /^Fonts/ }).click();
    // The alphabet line exists to show the glyph set: truncating it ate the numerals.
    const alphabet = page.getByTestId("font-row").first().getByTestId("font-alphabet");
    expect(await alphabet.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await expect(alphabet).toContainText("0123456789");

    await page.getByRole("tab", { name: /^All/ }).click();
    // The brand and neutral groups stay separated by a rule the phone shows too, and it stays inline: a full-width
    // rule would wrap the neutrals onto a row of their own even when both groups fit on one.
    const divider = page.getByTestId("palette-divider");
    await expect(divider).toBeVisible();
    const rule = (await divider.boundingBox())!;
    expect(rule.width).toBeLessThanOrEqual(2);
    expect(rule.height).toBeGreaterThan(8);
    const first = (await page.getByTestId("swatch-chip").first().boundingBox())!;
    expect(rule.y).toBeLessThan(first.y + first.height);
    expect(first.y).toBeLessThan(rule.y + rule.height);
  });
});

test.describe("tablet width", () => {
  test.use({ viewport: { width: 768, height: 1024 } });

  test("a toast never covers the selection bar", ({ page }) => expectToastClearOfTheBar(page));
});
