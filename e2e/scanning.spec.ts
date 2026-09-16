import { expect, test, type Page } from "@playwright/test";
import { installControlledScan } from "./support/routes";

async function startScan(page: Page, host: string) {
  await page.goto("/");
  await page.getByRole("textbox", { name: "Page URL" }).fill(host);
  await page.keyboard.press("Enter");
}

const STEPS = ["Opening stripe.com", "Waiting for the page to load", "Scrolling to load lazy images", "Collecting SVGs, images and fonts", "Finding originals"];

test.describe("scanning", () => {
  test("lists the steps in order with a spinner on the current one", async ({ page }) => {
    const scan = await installControlledScan(page);
    await startScan(page, "stripe.com");
    await expect(page).toHaveTitle("Scanning stripe.com");

    const status = page.getByTestId("scan-status");
    const steps = status.getByRole("listitem");
    await expect(steps).toHaveText(STEPS);
    await expect(page.getByTestId("skeleton-tile")).toHaveCount(12);
    // The URL moves into the top bar.
    await expect(page.getByTestId("top-bar-url")).toHaveValue("https://stripe.com/");

    await scan.push({ type: "accepted", scanId: "s1", url: "https://stripe.com/" }, { type: "step", step: "open", state: "start" });
    await expect(steps.nth(0)).toHaveAttribute("data-state", "active");
    await expect(steps.nth(1)).toHaveAttribute("data-state", "pending");
    await expect(status.getByTestId("step-spinner")).toHaveCount(1);
    await expect(steps.nth(0).getByTestId("step-spinner")).toHaveCount(1);

    await scan.push({ type: "step", step: "open", state: "done" }, { type: "step", step: "load", state: "start" });
    await expect(steps.nth(0)).toHaveAttribute("data-state", "done");
    await expect(steps.nth(1)).toHaveAttribute("data-state", "active");
    await expect(steps.nth(1).getByTestId("step-spinner")).toHaveCount(1);
    await expect(status.getByTestId("step-spinner")).toHaveCount(1);

    await scan.push({ type: "step", step: "scroll", state: "start" }, { type: "step", step: "collect", state: "start" });
    await expect(steps.nth(3)).toHaveAttribute("data-state", "active");
    await expect(steps.nth(2)).toHaveAttribute("data-state", "done");

    await expect(page.getByTestId("scan-elapsed")).toHaveText(/^\d+s$/);
  });

  test("shows the queue step only after a queue event", async ({ page }) => {
    const scan = await installControlledScan(page);
    await startScan(page, "stripe.com");
    const status = page.getByTestId("scan-status");
    await scan.push({ type: "step", step: "open", state: "start" });
    await expect(status.getByRole("listitem").nth(0)).toHaveAttribute("data-state", "active");
    await expect(status.getByText("Waiting for a free browser")).toHaveCount(0);

    await scan.push({ type: "step", step: "queue", state: "start" });
    await expect(status.getByRole("listitem")).toHaveText([STEPS[0], "Waiting for a free browser", ...STEPS.slice(1)]);
    await expect(status.getByRole("listitem").nth(1)).toHaveAttribute("data-state", "active");
  });

  test("Cancel returns to the landing with the URL kept", async ({ page }) => {
    const scan = await installControlledScan(page);
    await startScan(page, "stripe.com");
    await scan.push({ type: "step", step: "open", state: "start" });
    await page.getByRole("button", { name: "Cancel" }).click();

    await expect(page.getByRole("heading", { level: 1, name: "Every SVG, image and font on a page." })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Page URL" })).toHaveValue("https://stripe.com/");
    await expect(page).toHaveURL(/\/$/);
    await expect(page).toHaveTitle("Assets Scraper");
    await expect.poll(() => scan.stats()).toMatchObject({ requests: 1, aborted: 1 });
  });

  test("shows the long scan line after 20 seconds", async ({ page }) => {
    await page.clock.install();
    const scan = await installControlledScan(page);
    await startScan(page, "stripe.com");
    await scan.push({ type: "step", step: "open", state: "start" });
    const line = page.getByText("Large pages can take up to a minute.");
    await page.clock.fastForward(12_000);
    await expect(page.getByTestId("scan-elapsed")).toHaveText("12s");
    await expect(line).toHaveCount(0);
    await page.clock.fastForward(9_000);
    await expect(line).toBeVisible();
    await expect(page.getByTestId("scan-elapsed")).toHaveText("21s");
  });
});
