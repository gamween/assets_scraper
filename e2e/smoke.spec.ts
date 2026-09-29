import { expect, test } from "@playwright/test";

test("home responds", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
});

test("the tab icon is the app icon, not a scaffold favicon", async ({ page, request }) => {
  await page.goto("/");
  const icons = page.locator('link[rel="icon"]');
  await expect(icons).toHaveCount(1);
  await expect(icons).toHaveAttribute("href", /^\/icon\.svg/);
  expect((await request.get("/icon.svg")).status()).toBe(200);
  expect((await request.get("/favicon.ico")).status()).toBe(404);

  // Add to Home Screen used a screenshot of the page: the mark, full bleed, since iOS rounds the corners itself.
  const touch = page.locator('link[rel="apple-touch-icon"]');
  await expect(touch).toHaveAttribute("sizes", "180x180");
  const response = await request.get((await touch.getAttribute("href"))!);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toBe("image/png");
});

test("an unknown address gets the app's own 404, light and titled after the error", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  const response = await page.goto("/no-such-page");
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Page not found");
  // Next's default page had two titles, the app's first, and turned black in dark mode although the app is light only.
  await expect(page).toHaveTitle("Page not found");
  expect(await page.locator("title").count()).toBe(1);
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgb(250, 250, 250)");
  await page.getByRole("link", { name: "Scan a page" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Every SVG, image and font on a page." })).toBeVisible();
});
