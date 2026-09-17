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
});
