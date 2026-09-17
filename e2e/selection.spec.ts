import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import type { ScanEvent } from "../src/lib/contract";
import { formatBytes } from "../src/lib/format";
import { findAsset, fontsOf, loadFixture } from "./support/fixtures";
import { mockAssetRoutes, mockScan, type AssetRouteOptions } from "./support/routes";
import { readZip } from "./support/zip";

const linear = loadFixture("linear");
const siteLogo = findAsset(linear, (a) => a.role === "site-logo" && a.width === 88);
const photo = findAsset(linear, (a) => a.kind === "image" && a.role === "image" && a.visible && (a.renderedWidth ?? 0) > 100);
const berkeley = fontsOf(linear)[1];

async function openResults(page: Page, options: AssetRouteOptions = {}, events: ScanEvent[] = linear) {
  // Chrome has the File System Access API: without this, Download ZIP would open a native save dialog.
  await page.addInitScript(() => Object.defineProperty(window, "showSaveFilePicker", { value: undefined, configurable: true }));
  await mockAssetRoutes(page, events, options);
  await mockScan(page, events);
  await page.goto(`/?url=${encodeURIComponent("https://linear.app/")}`);
  await expect(page.getByTestId("results")).toBeVisible();
}

const cardOf = (page: Page, id: string) => page.locator(`[data-asset-id="${id}"]`);
const selectionBar = (page: Page) => page.getByRole("region", { name: "Selection" });

async function zipEntries(page: Page, click: () => Promise<void>) {
  const download = page.waitForEvent("download");
  await click();
  const file = await download;
  return { name: file.suggestedFilename(), entries: readZip(readFileSync((await file.path())!)).map((entry) => entry.name) };
}

test.describe("selection and ZIP", () => {
  test("checkbox, Cmd+click, Shift+click, Cmd+A and Esc", async ({ page }) => {
    await openResults(page);
    const cards = page.getByTestId("asset-card");
    const selected = page.locator("[data-testid=asset-card][data-selected]");

    await cards.nth(0).hover();
    await cards.nth(0).getByRole("checkbox").click();
    await expect(selected).toHaveCount(1);
    await expect(selectionBar(page)).toBeVisible();

    await cards.nth(2).locator("[data-card-main]").click({ modifiers: ["ControlOrMeta"] });
    await expect(selected).toHaveCount(2);
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await cards.nth(5).locator("[data-card-main]").click({ modifiers: ["Shift"] });
    await expect(selected).toHaveCount(5);

    // Once something is selected, a plain click toggles instead of opening the detail view.
    await cards.nth(5).locator("[data-card-main]").click();
    await expect(selected).toHaveCount(4);
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await page.keyboard.press("Escape");
    await expect(selected).toHaveCount(0);
    await expect(selectionBar(page)).toHaveCount(0);

    await page.keyboard.press("ControlOrMeta+a");
    const visible = await cards.count();
    await expect(selected).toHaveCount(visible);
    await expect(selectionBar(page).getByTestId("selection-count")).toContainText(`${visible + fontsOf(linear).length} selected`);
  });

  test("on a focused card Space toggles selection and Enter opens the detail view", async ({ page }) => {
    await openResults(page);
    const main = cardOf(page, photo.id).locator("[data-card-main]");
    await main.focus();
    await page.keyboard.press("Space");
    await expect(cardOf(page, photo.id)).toHaveAttribute("data-selected", "true");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog").getByRole("heading", { level: 2 })).toHaveText(photo.name);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(cardOf(page, photo.id)).toHaveAttribute("data-selected", "true");
  });

  test("the bar shows the count and size, and the ZIP holds exactly the selection", async ({ page }) => {
    await openResults(page);
    await cardOf(page, siteLogo.id).hover();
    await cardOf(page, siteLogo.id).getByRole("checkbox").click();
    await cardOf(page, photo.id).locator("[data-card-main]").click();
    await page.getByRole("tab", { name: /^Fonts/ }).click();
    await page.getByRole("checkbox", { name: `Select ${berkeley.name}` }).click();

    const bytes = (siteLogo.bytes ?? 0) + (photo.original?.bytes ?? 0) + berkeley.faces[0].files[0].bytes!;
    await expect(selectionBar(page).getByTestId("selection-count")).toHaveText(`3 selected · ${formatBytes(bytes)}`);

    const zip = await zipEntries(page, () => selectionBar(page).getByRole("button", { name: "Download ZIP" }).click());
    expect(zip.name).toBe("linear.app-assets.zip");
    expect(zip.entries.sort()).toEqual(
      [`linear.app-assets/svg/${siteLogo.filename}`, `linear.app-assets/images/${photo.filename}`, "linear.app-assets/fonts/Berkeley Mono/berkeley-mono-100-900.woff2"].sort(),
    );

    await selectionBar(page).getByRole("button", { name: "Clear" }).click();
    await expect(selectionBar(page)).toHaveCount(0);
  });

  test("a file that fails ends in a toast with Show", async ({ page }) => {
    const path = new URL(photo.original!.url).pathname;
    await openResults(page, { failDirect: [path], failProxy: [path] });
    await cardOf(page, siteLogo.id).hover();
    await cardOf(page, siteLogo.id).getByRole("checkbox").click();
    await cardOf(page, photo.id).locator("[data-card-main]").click();

    // Started from the keyboard: focus stays on the button while it zips.
    const downloadZip = selectionBar(page).getByRole("button", { name: "Download ZIP" });
    await downloadZip.focus();
    const zip = await zipEntries(page, () => page.keyboard.press("Enter"));
    expect(zip.entries).toEqual([`linear.app-assets/svg/${siteLogo.filename}`]);
    const toast = page.getByTestId("toast");
    await expect(toast).toContainText("1 file couldn't be downloaded");
    await expect(downloadZip).toBeFocused();
    // Base UI keeps urgent toasts aria-hidden until the toast region has focus and announces them in its own alert,
    // which carries the hint. The toast stays until dismissed, and F6 then Tab reaches Show.
    await expect(page.getByRole("alert").filter({ hasText: "1 file couldn't be downloaded" })).toContainText("Press F6 to reach Show.");
    await page.waitForTimeout(2500);
    await expect(toast).toBeVisible();
    await page.keyboard.press("F6");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await expect(toast.getByRole("button", { name: "Show" })).toBeFocused();
    await page.keyboard.press("Enter");
    const failures = page.getByRole("dialog", { name: "Files that couldn't be downloaded" });
    await expect(failures.getByRole("listitem")).toHaveText([photo.name]);
  });

  test("zipping shows progress in the button and Cancel stops it", async ({ page }) => {
    await openResults(page);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    // Hold the photo so the ZIP stays in progress; routes added later take precedence.
    await page.route(photo.original!.url, async (route) => {
      await held;
      await route.fulfill({ status: 404, body: "" }).catch(() => {});
    });
    await cardOf(page, siteLogo.id).hover();
    await cardOf(page, siteLogo.id).getByRole("checkbox").click();
    await cardOf(page, photo.id).locator("[data-card-main]").click();

    let downloaded = false;
    page.on("download", () => {
      downloaded = true;
    });
    await selectionBar(page).getByRole("button", { name: "Download ZIP" }).click();
    await expect(selectionBar(page).getByRole("button", { name: /^Zipping \d of 2$/ })).toBeVisible();
    await selectionBar(page).getByRole("button", { name: "Cancel" }).click();
    await expect(selectionBar(page).getByRole("button", { name: "Download ZIP" })).toBeEnabled();
    release();
    await page.waitForTimeout(300);
    expect(downloaded).toBe(false);
  });

  test("Download all zips the current tab whatever the search, without collapsed small icons", async ({ page }) => {
    await openResults(page);
    await page.getByRole("tab", { name: /^SVG/ }).click();
    const filenames = await page.getByTestId("asset-card").evaluateAll((cards) => cards.map((card) => card.getAttribute("data-filename")!));
    expect(filenames.length).toBeGreaterThan(1);
    // Spec 12.4: the search narrows the grid and select-all, not Download all.
    await page.getByRole("searchbox", { name: "Filter by name or URL" }).fill(siteLogo.filename);
    await expect(page.getByTestId("asset-card")).not.toHaveCount(filenames.length);
    const zip = await zipEntries(page, () => page.getByRole("button", { name: "Download all" }).click());
    expect(zip.name).toBe("linear.app-assets.zip");
    expect(zip.entries.sort()).toEqual(filenames.map((name) => `linear.app-assets/svg/${name}`).sort());
    const smallIcon = findAsset(linear, (a) => a.kind === "svg" && a.role === "icon");
    expect(zip.entries).not.toContain(`linear.app-assets/svg/${smallIcon.filename}`);
  });
});
