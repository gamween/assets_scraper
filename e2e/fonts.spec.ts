import { expect, test, type Page } from "@playwright/test";
import type { FontFamily, ScanEvent } from "../src/lib/contract";
import { fontsOf, loadFixture, withFonts } from "./support/fixtures";
import { mockAssetRoutes, mockScan, type AssetRouteOptions } from "./support/routes";

const linear = loadFixture("linear");
const [inter, berkeley] = fontsOf(linear);

async function openFonts(page: Page, events: ScanEvent[], options: AssetRouteOptions = {}) {
  await mockAssetRoutes(page, events, options);
  await mockScan(page, events);
  await page.goto(`/?url=${encodeURIComponent("https://linear.app/")}`);
  await expect(page.getByTestId("results")).toBeVisible();
  await page.getByRole("tab", { name: /^Fonts/ }).click();
}

const row = (page: Page, name: string) => page.getByTestId("font-row").filter({ has: page.getByRole("heading", { level: 3, name, exact: true }) });

test.describe("font rows", () => {
  test("the specimen renders in the scraped font", async ({ page }) => {
    await openFonts(page, linear);
    const specimen = row(page, "Inter Variable").getByTestId("font-specimen");
    await expect(specimen).toHaveText("Linear: The system for product development");
    await expect(specimen).toHaveAttribute("data-state", "ready");
    const alias = await specimen.getAttribute("data-font-alias");
    expect(alias).toBeTruthy();
    expect(await specimen.evaluate((el) => getComputedStyle(el).fontFamily)).toContain(alias!);
    expect(await page.evaluate((name) => document.fonts.check(`32px "${name}"`) && [...document.fonts].some((face) => face.family.replace(/"/g, "") === name && face.status === "loaded"), alias!)).toBe(true);
    await expect(row(page, "Inter Variable").getByText("ABCDEFGHIJKLM abcdefghijklm 0123456789")).toBeVisible();
  });

  test("summarizes weights, formats, source and licence", async ({ page }) => {
    const framer = loadFixture("framer");
    await mockAssetRoutes(page, framer);
    await mockScan(page, framer);
    await page.goto(`/?url=${encodeURIComponent("https://framer.com/")}`);
    await page.getByRole("tab", { name: /^Fonts/ }).click();
    await expect(row(page, "Inter").getByTestId("font-weights")).toHaveText("Regular 400, Medium 500, SemiBold 600, Bold 700");
    await expect(row(page, "Inter").getByTestId("font-meta")).toHaveText("WOFF2 · 4 files · 189 KB");
    await expect(row(page, "Inter").getByText("Open licence")).toBeVisible();
    await expect(row(page, "Input Mono").getByText("Licence unknown")).toBeVisible();
    await expect(row(page, "JetBrains Mono").getByRole("link", { name: "Google Fonts" })).toHaveAttribute("href", "https://fonts.google.com/specimen/JetBrains+Mono");

    await page.unrouteAll({ behavior: "ignoreErrors" });
    await openFonts(page, linear);
    await expect(row(page, "Inter Variable").getByTestId("font-weights")).toHaveText("Variable 100 to 900, italic");
  });

  test("Download saves the file, and Download TTF only shows for convertible families", async ({ page }) => {
    await openFonts(page, linear);
    const mono = row(page, "Berkeley Mono");
    await expect(mono.getByRole("button", { name: "Download TTF" })).toHaveCount(0);
    const download = page.waitForEvent("download");
    await mono.getByRole("button", { name: "Download", exact: true }).click();
    expect((await download).suggestedFilename()).toBe("berkeley-mono-100-900.woff2");

    const interRow = row(page, "Inter Variable");
    await expect(interRow.getByRole("button", { name: "Download TTF" })).toBeVisible();
    const zip = page.waitForEvent("download");
    await interRow.getByRole("button", { name: "Download", exact: true }).click();
    expect((await zip).suggestedFilename()).toBe("inter-variable.zip");

    const ttf = page.waitForEvent("download");
    await interRow.getByRole("button", { name: "Download TTF" }).click();
    expect((await ttf).suggestedFilename()).toBe("inter-variable-ttf.zip");
  });

  test("Copy name copies the family name", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openFonts(page, linear);
    await row(page, "Berkeley Mono").getByRole("button", { name: "Copy name" }).click();
    await expect(page.getByTestId("toast")).toContainText("Font name copied");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("Berkeley Mono");
  });

  test("an Adobe Fonts family links to Adobe Fonts and offers no download", async ({ page }) => {
    const adobe: FontFamily = { ...berkeley, id: "adobe-proxima", name: "Proxima Nova", cssFamilies: ["proxima-nova"], source: "adobe-fonts", sourceHost: "use.typekit.net", downloadable: false, convertible: false };
    await openFonts(page, withFonts(linear, [inter, adobe]));
    const adobeRow = row(page, "Proxima Nova");
    await expect(adobeRow.getByRole("link", { name: "Adobe Fonts" })).toHaveAttribute("href", /^https:\/\/fonts\.adobe\.com\//);
    await expect(adobeRow.getByRole("button", { name: /^Download/ })).toHaveCount(0);
  });

  test("a font that cannot load shows Preview unavailable", async ({ page }) => {
    const path = new URL(berkeley.faces[0].files[0].url).pathname;
    await openFonts(page, linear, { failDirect: [path], failProxy: [path] });
    const mono = row(page, "Berkeley Mono");
    await expect(mono.getByText("Preview unavailable")).toBeVisible();
    await expect(mono.getByTestId("font-specimen")).toHaveAttribute("data-state", "failed");
  });
});
