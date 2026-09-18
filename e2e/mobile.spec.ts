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

  test("the detail arrows do not share a band with the asset", async ({ page }) => {
    await openResults(page);
    await page.locator("[data-card-main]").first().click();
    const detail = page.getByRole("dialog");
    await expect(detail).toBeVisible();
    const image = (await page.getByTestId("detail-well").locator("img").boundingBox())!;
    for (const name of ["Previous", "Next"]) {
      const arrow = (await detail.getByRole("button", { name }).boundingBox())!;
      const overlaps = arrow.x < image.x + image.width && image.x < arrow.x + arrow.width && arrow.y < image.y + image.height && image.y < arrow.y + arrow.height;
      expect(overlaps, `${name} must not sit over the preview`).toBe(false);
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
    // The neutrals name themselves when the inline divider is hidden and they wrap onto their own row.
    await expect(page.getByRole("region", { name: "Palette" })).toContainText("Neutrals");
  });
});
