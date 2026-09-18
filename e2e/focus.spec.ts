import { expect, test, type Locator, type Page } from "@playwright/test";
import type { ScanEvent } from "../src/lib/contract";
import { loadFixture } from "./support/fixtures";
import { mockAssetRoutes, mockScan } from "./support/routes";

/** `--accent` (spec 12.6), the only color the focus ring is allowed to use. */
const ACCENT = "rgb(43, 80, 232)";

const linear = loadFixture("linear");

async function openResults(page: Page, events: ScanEvent[] = linear) {
  await mockAssetRoutes(page, events);
  await mockScan(page, events);
  await page.goto(`/?url=${encodeURIComponent("https://linear.app/")}`);
  await expect(page.getByTestId("results")).toBeVisible();
}

/** `transition-colors` animates `outline-color` too, so a ring read right after focus is still the old color. */
const settle = (locator: Locator) => locator.evaluate((element) => Promise.all(element.getAnimations().map((a) => a.finished.catch(() => {}))).then(() => {}));

/**
 * Focuses a control the way a keyboard user reaches it and reads back the ring it paints. A modifier keydown puts
 * Chrome in keyboard modality, so the programmatic focus that follows matches `:focus-visible`.
 */
async function ring(page: Page, locator: Locator) {
  await page.keyboard.press("Shift");
  await locator.focus();
  await settle(locator);
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      focusVisible: element.matches(":focus-visible"),
      style: style.outlineStyle,
      width: style.outlineWidth,
      color: style.outlineColor,
      offset: style.outlineOffset,
    };
  });
}

function expectRing(actual: Awaited<ReturnType<typeof ring>>, name: string) {
  expect(actual, `${name} should match :focus-visible`).toMatchObject({ focusVisible: true });
  expect({ name, ...actual }).toMatchObject({ name, style: "solid", width: "2px", color: ACCENT });
}

test.describe("keyboard focus ring", () => {
  test("every kind of control paints a 2 px accent ring on keyboard focus", async ({ page }) => {
    await openResults(page);

    const controls: [string, Locator][] = [
      ["header button", page.getByRole("button", { name: "Rescan" })],
      ["primary button", page.getByRole("button", { name: /^Download all \d+$/ })],
      ["palette swatch", page.getByRole("region", { name: "Palette" }).getByRole("button", { name: /^Copy #/ }).first()],
      ["palette copy all", page.getByRole("region", { name: "Palette" }).getByRole("button", { name: "Copy all" })],
      ["tone control", page.getByRole("radio", { name: "Dark" })],
    ];

    for (const [name, locator] of controls) expectRing(await ring(page, locator), name);

    // The card is one tab stop: the ring goes around the whole tile, not around the button that covers it.
    const cardButton = page.locator("[data-card-main]").first();
    await page.keyboard.press("Shift");
    await cardButton.focus();
    const tile = page.getByTestId("asset-card").first();
    await settle(tile);
    expect(await tile.evaluate((element) => { const s = getComputedStyle(element); return { style: s.outlineStyle, width: s.outlineWidth, color: s.outlineColor }; })).toEqual({
      style: "solid",
      width: "2px",
      color: ACCENT,
    });

    // The tabs draw their ring on a pseudo element around the label, not around the 52 px tall hit area.
    const tab = page.getByRole("tab", { name: /^SVG/ });
    await page.keyboard.press("Shift");
    await tab.focus();
    await settle(tab);
    expect(
      await tab.evaluate((element) => {
        const after = getComputedStyle(element, "::after");
        return { content: after.content, style: after.outlineStyle, width: after.outlineWidth, color: after.outlineColor, own: getComputedStyle(element).outlineStyle };
      }),
    ).toEqual({ content: '""', style: "solid", width: "2px", color: ACCENT, own: "none" });

    // Fields take the other accent indicator of spec 12.6: an accent border with an accent-soft halo, not a ring.
    for (const field of [page.getByLabel("Sort"), page.getByLabel("Filter by name or URL")]) {
      await page.keyboard.press("Shift");
      await field.focus();
      await settle(field);
      expect(await field.evaluate((element) => getComputedStyle(element).borderColor)).toBe(ACCENT);
      expect(await field.evaluate((element) => getComputedStyle(element).boxShadow)).toContain("rgb(232, 237, 255)");
    }
  });

  test("the Show link of a collapsed section and the detail dialog actions paint the ring", async ({ page }) => {
    await openResults(page);
    expectRing(await ring(page, page.getByRole("button", { name: "Show" }).first()), "Show link");

    await page.locator("[data-card-main]").first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    for (const name of ["Close", "Next", /^Download /] as const) {
      expectRing(await ring(page, dialog.getByRole("button", { name })), `dialog ${String(name)}`);
    }
  });

  test("the landing host chips light up around the chip, which clips its own outline", async ({ page }) => {
    await page.goto("/");
    const chip = page.getByRole("group", { name: "Try" }).getByRole("button", { name: "stripe.com" });
    await page.keyboard.press("Shift");
    await chip.focus();
    await settle(chip.locator("xpath=.."));
    const wrapper = await chip.evaluate((element) => {
      const style = getComputedStyle(element.parentElement!);
      return { style: style.outlineStyle, width: style.outlineWidth, color: style.outlineColor };
    });
    expect(wrapper).toEqual({ style: "solid", width: "2px", color: ACCENT });
  });
});
