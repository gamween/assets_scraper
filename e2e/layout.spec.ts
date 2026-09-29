import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { diagnostics, findAsset, loadFixture } from "./support/fixtures";
import { installControlledScan, mockScan, openResults } from "./support/routes";

/**
 * The layout rules of spec 12.6 at the three reference viewports (spec 15), on every screen: columns per breakpoint, a
 * sticky top bar, a selection bar inside the viewport, and nothing that scrolls sideways. The rules are what gates a
 * change; the screenshots of the spec 15 visual review are only taken on a local run (see `checkScreen`).
 */
const VIEWPORTS = [
  { name: "desktop", width: 1470, height: 956, columns: 6 },
  { name: "laptop", width: 1024, height: 768, columns: 5 },
  { name: "phone", width: 390, height: 844, columns: 2 },
] as const;

const linear = loadFixture("linear");
const siteLogo = findAsset(linear, (a) => a.role === "site-logo" && a.width === 88);

/**
 * Nothing on the screen scrolls sideways, once the web fonts that set every line's width have loaded. Run locally, the
 * screen is also saved to the report for the visual review before a release (spec 15). Nothing compares the pictures,
 * and a green CI run keeps no report, so CI does not take them.
 */
async function checkScreen(page: Page, testInfo: TestInfo, name: string) {
  await page.evaluate(() => document.fonts.ready.then(() => {}));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, `${name} scrolls horizontally`).toBeLessThanOrEqual(0);
  if (process.env.CI) return;
  // Lets the lazy previews and the fades settle, for the picture only: no assertion waits on it.
  await page.waitForTimeout(400);
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

for (const viewport of VIEWPORTS) {
  test.describe(`${viewport.name} ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("landing", async ({ page }, testInfo) => {
      await page.addInitScript(() => localStorage.setItem("assets-scraper:recent", JSON.stringify(["vercel.com", "ripple.com"])));
      await page.goto("/");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await checkScreen(page, testInfo, `landing-${viewport.width}`);
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
      await checkScreen(page, testInfo, `scanning-${viewport.width}`);
    });

    test("results", async ({ page }, testInfo) => {
      await openResults(page);
      const columns = await page.locator(".asset-grid").first().evaluate((grid) => getComputedStyle(grid).gridTemplateColumns.split(" ").length);
      expect(columns).toBe(viewport.columns);
      await checkScreen(page, testInfo, `results-${viewport.width}`);

      // The top bar and the filter row stay in place while the grid scrolls.
      await page.mouse.wheel(0, 1200);
      await expect.poll(() => page.locator("header").first().boundingBox().then((box) => box?.y)).toBe(0);
      await checkScreen(page, testInfo, `results-scrolled-${viewport.width}`);
    });

    test("detail", async ({ page }, testInfo) => {
      await openResults(page, { query: `&asset=${siteLogo.id}` });
      await expect(page.getByRole("dialog")).toBeVisible();
      await checkScreen(page, testInfo, `detail-${viewport.width}`);
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
      await checkScreen(page, testInfo, `selection-${viewport.width}`);
    });

    test("error", async ({ page }, testInfo) => {
      await mockScan(page, [
        { type: "accepted", scanId: diagnostics.scanId, url: "https://linear.app/" },
        { type: "error", code: "internal", message: "internal", diagnostics },
      ]);
      await page.goto(`/?url=${encodeURIComponent("https://linear.app/")}`);
      await expect(page.getByTestId("error-panel")).toBeVisible();
      await checkScreen(page, testInfo, `error-${viewport.width}`);
    });
  });
}

/**
 * Spec 12.6 "Flat surfaces": the float shadow only on the selection bar, dialog and toasts, and no other shadow
 * anywhere (focus rings aside, and nothing shows one here). Tailwind pads `box-shadow` with transparent layers, which
 * are left out before comparing.
 */
async function strayShadows(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const layers = (value: string) =>
      value === "none" ? [] : value.split(/,(?![^(]*\))/).map((layer) => layer.trim()).filter((layer) => !layer.startsWith("rgba(0, 0, 0, 0)"));
    const probe = document.createElement("div");
    probe.style.boxShadow = "var(--shadow-float)";
    document.body.append(probe);
    const float = layers(getComputedStyle(probe).boxShadow).join(", ");
    probe.remove();
    return [...document.querySelectorAll("body *")].flatMap((element) => {
      const shadow = layers(getComputedStyle(element).boxShadow).join(", ");
      if (!shadow) return [];
      if (shadow === float && element.closest('[role="dialog"], [aria-label="Selection"], [data-testid="toast"]')) return [];
      return [`${element.tagName.toLowerCase()} ${String(element.getAttribute("class")).slice(0, 100)}: ${shadow}`];
    });
  });
}

test("surfaces stay flat outside the selection bar, dialog and toasts", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openResults(page);
  const card = page.getByTestId("asset-card").first();
  await card.hover();
  expect(await strayShadows(page)).toEqual([]);

  await card.locator("[data-card-main]").click({ modifiers: ["ControlOrMeta"] });
  await expect(page.getByRole("region", { name: "Selection" })).toBeVisible();
  await page.getByRole("tab", { name: /^Fonts/ }).click();
  const fontRow = page.getByTestId("font-row").first();
  await fontRow.getByRole("checkbox").click();
  await expect(fontRow).toHaveAttribute("data-selected", "true");
  await page.getByRole("button", { name: "Copy link" }).click();
  await expect(page.getByTestId("toast")).toBeVisible();
  expect(await strayShadows(page)).toEqual([]);

  await page.keyboard.press("Escape");
  await page.getByRole("tab", { name: /^All/ }).click();
  await page.getByTestId("asset-card").nth(1).locator("[data-card-main]").click();
  await expect(page.getByTestId("detail-well")).toBeVisible();
  await page.getByRole("button", { name: "Next", exact: true }).hover();
  expect(await strayShadows(page)).toEqual([]);
});

test("results never scroll sideways between the reference widths", async ({ page }) => {
  await openResults(page);
  for (const width of [360, 480, 640, 768, 900, 1024, 1280, 1680]) {
    await page.setViewportSize({ width, height: 900 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `${width} px scrolls horizontally`).toBeLessThanOrEqual(0);
    // Spec 12.6 page gutter: 32, or 16 on phones.
    const gutter = await page.locator("[data-testid=results] .page-x").first().evaluate((el) => getComputedStyle(el).paddingLeft);
    expect(gutter).toBe(width < 640 ? "16px" : "32px");
  }
});
