import { expect, test, type Page } from "@playwright/test";
import type { Asset, ScanEvent } from "../src/lib/contract";
import { findAsset, loadFixture, mapAssets } from "./support/fixtures";
import { mockAssetRoutes, mockScan } from "./support/routes";

const linear = loadFixture("linear");

/** Resizes an asset and both of its sources, which is where `frameStyle` reads the dimensions from. */
function resize(asset: Asset, width: number, height: number): Asset {
  return {
    ...asset,
    width,
    height,
    display: asset.display ? { ...asset.display, width, height } : asset.display,
    original: asset.original ? { ...asset.original, width, height } : asset.original,
  };
}

/** A tall vector (the `min(76%, H*6px)` branch) and a tall raster (the `min(100% - 24px, H*2px)` branch). */
const tallVector = findAsset(linear, (asset) => asset.kind === "svg" && asset.visible);
const tallRaster = findAsset(linear, (asset) => asset.kind === "image" && asset.visible);
const events = mapAssets(linear, (asset) =>
  asset.id === tallVector.id ? resize(asset, 14, 44) : asset.id === tallRaster.id ? resize(asset, 616, 1050) : asset,
);

async function openResults(page: Page, scan: ScanEvent[] = events) {
  await mockAssetRoutes(page, scan);
  await mockScan(page, scan);
  await page.goto(`/?url=${encodeURIComponent("https://linear.app/")}`);
  await expect(page.getByTestId("results")).toBeVisible();
}

/** Tiles are `loading="lazy"`: a tile that never entered the viewport has no image to measure. */
async function paintEveryTile(page: Page) {
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y < height; y += 700) await page.evaluate((to) => window.scrollTo(0, to), y);
  await page.evaluate(() => window.scrollTo(0, 0));
  // Tiles settle at different times and a failed direct load retries through the proxy, so wait for the number of
  // painted tiles to stop moving rather than for every image to report itself complete.
  const count = () =>
    page.evaluate(() => [...document.querySelectorAll<HTMLImageElement>('[data-testid="preview-well"] img')].filter((img) => img.complete && img.naturalWidth > 0).length);
  for (let previous = -1, i = 0; i < 40; i += 1) {
    const loaded = await count();
    if (loaded > 0 && loaded === previous) return;
    previous = loaded;
    await page.waitForTimeout(250);
  }
}

async function overflowingTiles(page: Page) {
  return page.evaluate(() => {
    const out: { name: string; over: number }[] = [];
    let loaded = 0;
    for (const well of document.querySelectorAll('[data-testid="preview-well"]')) {
      const image = well.querySelector("img");
      if (!image?.complete || !image.naturalWidth) continue;
      loaded += 1;
      const outer = well.getBoundingClientRect();
      const inner = image.getBoundingClientRect();
      const over = Math.max(outer.top - inner.top, inner.bottom - outer.bottom, outer.left - inner.left, inner.right - outer.right);
      if (over > 0.5) out.push({ name: well.closest("[data-filename]")?.getAttribute("data-filename") ?? "?", over: Math.round(over) });
    }
    return { out, loaded };
  });
}

test.describe("preview sizing", () => {
  test("no tile preview is clipped by its well, on either branch of the sizing rule", async ({ page }) => {
    await openResults(page);
    await paintEveryTile(page);
    const { out, loaded } = await overflowingTiles(page);
    expect(loaded).toBeGreaterThan(20);
    expect(out).toEqual([]);
  });

  test("the detail preview fits inside the dialog", async ({ page }) => {
    await openResults(page);
    for (const asset of [tallVector, tallRaster]) {
      await page.locator(`[data-asset-id="${asset.id}"] [data-card-main]`).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      // The dialog opens with a scale transition: measured mid-flight it is 2 percent short of its own height.
      await dialog.evaluate((element) => Promise.all(element.getAnimations().map((a) => a.finished.catch(() => {}))).then(() => {}));
      const outer = (await dialog.boundingBox())!;
      const wellBox = (await page.getByTestId("detail-well").boundingBox())!;
      expect(wellBox.height, `${asset.filename}: the preview column must fit the dialog`).toBeLessThanOrEqual(outer.height + 0.5);
      const image = (await page.getByTestId("detail-well").locator("img").boundingBox())!;
      expect(image.y).toBeGreaterThanOrEqual(wellBox.y - 0.5);
      expect(image.y + image.height).toBeLessThanOrEqual(wellBox.y + wellBox.height + 0.5);
      expect(image.height).toBeGreaterThan(0);
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
    }
  });
});

test.describe("dialog height", () => {
  test("a small asset gets a small dialog and a big one still fills the screen", async ({ page }) => {
    const small = findAsset(linear, (asset) => asset.kind === "svg" && asset.role === "site-logo");
    const events = mapAssets(linear, (asset) => (asset.id === small.id ? resize(asset, 60, 25) : asset.id === tallRaster.id ? resize(asset, 2000, 2000) : asset));
    await openResults(page, events);

    const heightOf = async (id: string) => {
      await page.locator(`[data-asset-id="${id}"] [data-card-main]`).click();
      const popup = page.getByTestId("detail-popup");
      await expect(popup).toBeVisible();
      await popup.evaluate((element) => Promise.all(element.getAnimations().map((a) => a.finished.catch(() => {}))).then(() => {}));
      const box = (await popup.boundingBox())!;
      await page.keyboard.press("Escape");
      await expect(popup).toBeHidden();
      return box.height;
    };

    const tiny = await heightOf(small.id);
    const large = await heightOf(tallRaster.id);
    // A 60x25 logo used to open the same 860 px dialog as a 2000x2000 photograph.
    expect(tiny).toBeLessThan(large);
    expect(tiny).toBeLessThanOrEqual(560);
    expect(tiny).toBeGreaterThanOrEqual(440);
    expect(large).toBeGreaterThan(800);
  });
});
