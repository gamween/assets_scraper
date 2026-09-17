import { expect, test, type Page } from "@playwright/test";
import type { ScanEvent } from "../src/lib/contract";
import { formatBytes, formatDimensions } from "../src/lib/format";
import { assetsOf, findAsset, fontsOf, loadFixture, withDone } from "./support/fixtures";
import { mockAssetRoutes, mockScan, type AssetRouteOptions } from "./support/routes";

async function openResults(page: Page, events: ScanEvent[], options: AssetRouteOptions = {}, url = "https://linear.app/") {
  const assetLog = await mockAssetRoutes(page, events, options);
  const scan = await mockScan(page, events);
  await page.goto(`/?url=${encodeURIComponent(url)}`);
  await expect(page.getByTestId("results")).toBeVisible();
  return { assetLog, scan };
}

const linear = loadFixture("linear");
const linearAssets = assetsOf(linear);
const linearTotal = linearAssets.length + fontsOf(linear).length;
const section = (page: Page, name: string) => page.getByRole("region", { name, exact: true });

test.describe("results", () => {
  test("header shows the title, meta and actions", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openResults(page, linear);
    await expect(page.getByRole("heading", { level: 1, name: "Linear: The system for product development" })).toBeVisible();
    await expect(page.getByTestId("results-meta")).toHaveText(`linear.app · ${linearTotal} assets · 11s`);
    await expect(page).toHaveTitle(`${linearTotal} assets · linear.app`);
    await expect(page.getByRole("button", { name: "Rescan" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Download all" })).toBeVisible();

    await page.getByRole("button", { name: "Copy link" }).click();
    await expect(page.getByTestId("toast")).toContainText("Link copied");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${new URL(page.url()).origin}/?url=https%3A%2F%2Flinear.app%2F`);
  });

  test("palette swatches copy their hex", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openResults(page, linear);
    const palette = page.getByRole("region", { name: "Palette" });
    await expect(palette.getByRole("button", { name: /^Copy #/ })).toHaveCount(5);
    await palette.getByRole("button", { name: "Copy #5e6ad2" }).click();
    await expect(page.getByTestId("toast")).toHaveText(/Copied #5e6ad2/);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("#5e6ad2");

    await palette.getByRole("button", { name: "Copy all" }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      ["#5e6ad2 primary", "#101112 background", "#f7f8f8 text", "#8a8f98 neutral", "#e5e5e6 neutral"].join("\n"),
    );
  });

  test("brand links come from the last page event and scan their page", async ({ page }) => {
    // The client replaces page info with each page event: a later page without links clears them.
    const cleared = [...linear.slice(0, -1), { type: "page", page: { requestedUrl: "https://linear.app/", finalUrl: "https://linear.app/", host: "linear.app", title: "Linear", status: 200, brandLinks: [] } } as ScanEvent, linear.at(-1)!];
    await openResults(page, cleared);
    await expect(page.getByRole("group", { name: "Brand resources on this site" })).toHaveCount(0);

    await page.unrouteAll({ behavior: "ignoreErrors" });
    const { scan } = await openResults(page, linear);
    const brand = page.getByRole("group", { name: "Brand resources on this site" });
    await expect(brand.getByRole("button")).toHaveText(["Brand"]);
    await brand.getByRole("button", { name: "Brand" }).click();
    await expect(page).toHaveURL(/\?url=https%3A%2F%2Flinear\.app%2Fbrand$/);
    await expect.poll(() => scan.bodies.at(-1)).toEqual({ url: "https://linear.app/brand" });
  });

  test("tabs show counts and switch with 1 to 4", async ({ page }) => {
    await openResults(page, linear);
    const svg = linearAssets.filter((a) => a.kind === "svg").length;
    const tabs = page.getByRole("tab");
    await expect(tabs).toHaveText([`All ${linearTotal}`, `SVG ${svg}`, `Images ${linearAssets.length - svg}`, "Fonts 2"]);
    await expect(page.getByRole("tab", { name: /^All/ })).toHaveAttribute("aria-selected", "true");

    await page.keyboard.press("2");
    await expect(page.getByRole("tab", { name: /^SVG/ })).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("4");
    await expect(page.getByRole("tab", { name: /^Fonts/ })).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("3");
    await expect(page.getByRole("tab", { name: /^Images/ })).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("1");
    await expect(page.getByRole("tab", { name: /^All/ })).toHaveAttribute("aria-selected", "true");
  });

  test("Logos lead All, and the SVG tab has no Logos section", async ({ page }) => {
    await openResults(page, linear);
    const headings = page.getByTestId("results").getByRole("heading", { level: 2 });
    await expect(headings.first()).toHaveText("Logos");
    await expect(section(page, "Logos").getByTestId("asset-card").first()).toHaveAttribute("data-role", "site-logo");

    await page.getByRole("tab", { name: /^SVG/ }).click();
    await expect(section(page, "Logos")).toHaveCount(0);
    await expect(section(page, "SVG").getByText("Logo", { exact: true }).first()).toBeVisible();
  });

  test("Small icons start collapsed behind Show", async ({ page }) => {
    await openResults(page, linear);
    const small = section(page, "Small icons");
    await expect(small.getByTestId("asset-card")).toHaveCount(0);
    await small.getByRole("button", { name: "Show" }).click();
    await expect(small.getByTestId("asset-card").first()).toBeVisible();
    await expect(small.getByRole("button", { name: "Hide" })).toHaveAttribute("aria-expanded", "true");
  });

  test("search with / filters, and an empty match offers Clear search", async ({ page }) => {
    await openResults(page, linear);
    await page.keyboard.press("/");
    const search = page.getByRole("searchbox", { name: "Filter by name or URL" });
    await expect(search).toBeFocused();
    await search.fill("avatar of karri");
    // The match is a small icon: its section stays collapsed until Show, like without a search.
    const small = section(page, "Small icons");
    await expect(small.getByRole("heading", { level: 2 })).toHaveText("Small icons");
    await expect(page.getByTestId("asset-card")).toHaveCount(0);
    await small.getByRole("button", { name: "Show" }).click();
    await expect(page.getByTestId("asset-card")).toHaveCount(1);

    await search.fill("zzz");
    await expect(page.getByText('Nothing matches "zzz"')).toBeVisible();
    await page.getByRole("button", { name: "Clear search" }).click();
    await expect(search).toHaveValue("");
    await expect(page.getByTestId("asset-card").first()).toBeVisible();
  });

  test("sort changes the order", async ({ page }) => {
    await openResults(page, linear);
    await page.getByRole("tab", { name: /^Images/ }).click();
    const images = section(page, "Images").getByTestId("asset-card");
    const names = async () => images.evaluateAll((cards) => cards.map((card) => card.getAttribute("data-name") ?? ""));
    const relevance = await names();
    await page.getByRole("combobox", { name: "Sort" }).selectOption({ label: "Name" });
    await expect.poll(names).not.toEqual(relevance);
    const byName = await names();
    const socials = byName.filter((name) => name.endsWith("social image"));
    const rest = byName.slice(socials.length);
    expect(rest).toEqual([...rest].sort(new Intl.Collator("en", { sensitivity: "base", numeric: true }).compare));
  });

  test("the background control overrides tile backgrounds", async ({ page }) => {
    await openResults(page, linear);
    const siteLogo = section(page, "Logos").getByTestId("asset-card").first();
    const well = siteLogo.getByTestId("preview-well");
    // The Linear logo is light: Auto shows it on the dark preview color.
    await expect(well).toHaveAttribute("data-background", "dark");
    const control = page.getByRole("radiogroup", { name: "Preview background" });
    await control.getByRole("radio", { name: "Grid" }).click();
    await expect(well).toHaveAttribute("data-background", "grid");
    await control.getByRole("radio", { name: "Light" }).click();
    await expect(well).toHaveAttribute("data-background", "light");
    await expect(well).toHaveCSS("background-color", "rgb(255, 255, 255)");
  });

  test("a search keeps collapsed sections collapsed, and Cmd+A takes only what shows", async ({ page }) => {
    await openResults(page, linear);
    const icon = findAsset(linear, (a) => a.kind === "svg" && a.role === "icon");
    const search = page.getByRole("searchbox", { name: "Filter by name or URL" });
    await search.fill(icon.filename);
    const small = section(page, "Small icons");
    await expect(small.getByRole("button", { name: "Show" })).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator(`[data-asset-id="${icon.id}"]`)).toHaveCount(0);

    await search.blur();
    await page.keyboard.press("ControlOrMeta+a");
    const shown = await page.getByTestId("asset-card").count();
    await expect(page.locator("[data-testid=asset-card][data-selected]")).toHaveCount(shown);
    await page.keyboard.press("Escape");

    await small.getByRole("button", { name: "Show" }).click();
    await expect(page.locator(`[data-asset-id="${icon.id}"]`)).toBeVisible();
    await page.keyboard.press("ControlOrMeta+a");
    await expect(page.locator(`[data-asset-id="${icon.id}"]`)).toHaveAttribute("data-selected", "true");
  });

  test("tiles show the file name and a mono meta line", async ({ page }) => {
    await openResults(page, linear);
    const logo = findAsset(linear, (a) => a.role === "site-logo" && a.width === 88);
    const card = page.locator(`[data-asset-id="${logo.id}"]`);
    await expect(card.getByTestId("asset-filename")).toHaveText(logo.filename);
    await expect(card.getByTestId("asset-meta")).toHaveText(`SVG · ${formatDimensions(logo.width, logo.height)} · ${formatBytes(logo.bytes!)} · Inline`);
    await expect(card.getByText("Logo", { exact: true })).toBeVisible();

    const og = findAsset(linear, (a) => a.role === "social");
    const ogCard = page.locator(`[data-asset-id="${og.id}"]`);
    await expect(ogCard.getByTestId("asset-meta")).toHaveText(`${og.format.toUpperCase()} · ${formatDimensions(og.width, og.height)} · ${formatBytes(og.bytes!)}`);
    await expect(ogCard.getByText("OG image", { exact: true })).toBeVisible();
  });

  test("a remote image that fails loads through the proxy", async ({ page }) => {
    const hero = findAsset(linear, (a) => a.kind === "image" && a.role === "image" && a.visible && !!a.display && (a.renderedWidth ?? 0) > 100);
    const directPath = new URL(hero.display!.url).pathname;
    await openResults(page, linear, { failDirect: [directPath] });
    const img = page.locator(`[data-asset-id="${hero.id}"] img`);
    await img.scrollIntoViewIfNeeded();
    await expect.poll(() => img.getAttribute("src")).toBe(hero.display!.proxy);
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
  });

  test("scraped SVG markup never reaches the DOM", async ({ page }) => {
    await openResults(page, linear);
    await section(page, "Small icons").getByRole("button", { name: "Show" }).click();
    await expect(page.locator("main svg[data-scraped]")).toHaveCount(0);
    const logo = findAsset(linear, (a) => a.role === "site-logo" && a.width === 88);
    const pathData = /\sd="([^"]{24})/.exec((logo.inline as { text: string }).text)![1];
    expect(await page.content()).not.toContain(pathData);
    const src = await page.locator(`[data-asset-id="${logo.id}"] img`).getAttribute("src");
    expect(src).toMatch(/^blob:/);
  });

  test("the footer counts hidden noise", async ({ page }) => {
    await openResults(page, linear);
    await expect(page.getByText("9 hidden: tracking pixels and spacer images")).toBeVisible();
  });

  test("a partial scan shows the banner", async ({ page }) => {
    const partial = withDone(loadFixture("framer"), (done) => ({ ...done, partial: true }));
    await openResults(page, partial, {}, "https://framer.com/");
    await expect(page.getByText("Partial results. The page didn't finish loading.")).toBeVisible();
  });
});
