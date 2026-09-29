import { expect, test, type Page } from "@playwright/test";
import { loadFixture } from "./support/fixtures";
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

  test("tells a screen reader where the scan is, when it ends, and what is selected", async ({ page }) => {
    // One status region for the life of the page: the step list only restyled rows that were already there, and the
    // selection count arrived with its bar, so a screen reader heard neither.
    const scan = await installControlledScan(page);
    await startScan(page, "linear.app");
    const status = page.getByRole("status").and(page.getByTestId("announcer"));
    await expect(status).toHaveText("Opening linear.app");
    await expect(page.getByTestId("scan-status").getByRole("list")).not.toHaveAttribute("aria-live");

    await scan.push({ type: "step", step: "open", state: "done" }, { type: "step", step: "load", state: "start" });
    await expect(status).toHaveText("Waiting for the page to load");

    const linear = loadFixture("linear").filter((event) => event.type !== "accepted" && event.type !== "step");
    const assets = linear.flatMap((event) => (event.type === "assets" ? event.items : [])).length;
    const fonts = linear.flatMap((event) => (event.type === "fonts" ? event.families : [])).length;
    await scan.push(...linear);
    await expect(page.getByTestId("results")).toBeVisible();
    await expect(status).toHaveText(`Scan finished, ${assets} assets and ${fonts} fonts`);

    const card = page.getByTestId("asset-card").first();
    await card.locator("[data-card-main]").focus();
    await page.keyboard.press("Space");
    await expect(status).toHaveText("1 selected");
    // The card itself says it is selected, in the description of its button.
    await expect(card.locator("[data-card-main]")).toHaveAccessibleDescription(/, selected$/);
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
