import { expect, test, type Page } from "@playwright/test";
import type { Asset, ErrorCode, ScanEvent } from "../src/lib/contract";
import { diagnostics, loadFixture } from "./support/fixtures";
import { mockAssetRoutes, mockScan, type ScanResponse } from "./support/routes";

const panel = (page: Page) => page.getByTestId("error-panel");

async function scan(page: Page, ...responses: ScanResponse[]) {
  const record = await mockScan(page, ...responses);
  await page.goto(`/?url=${encodeURIComponent("https://linear.app/")}`);
  return record;
}

const gate = (status: number, code: ErrorCode) => ({ status, json: { error: { code, message: `gate ${code}` } } });
const stream = (code: ErrorCode, extra: Partial<Extract<ScanEvent, { type: "error" }>> = {}): ScanEvent[] => [
  { type: "accepted", scanId: diagnostics.scanId, url: "https://linear.app/" },
  { type: "step", step: "open", state: "start" },
  { type: "error", code, message: `stream ${code}`, diagnostics, ...extra },
];

async function expectPanel(page: Page, title: string, line: string | null, actions: string[]) {
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).getByRole("heading", { level: 2 })).toHaveText(title);
  if (line) await expect(panel(page).getByTestId("error-line")).toHaveText(line);
  else await expect(panel(page).getByTestId("error-line")).toHaveCount(0);
  await expect(panel(page).getByRole("button")).toHaveText(actions);
  await expect(page).toHaveTitle("Scan failed · linear.app");
}

const CANT_SCAN = "This address can't be scanned";
const CHECK = "Check the address and try again.";

const rows: { name: string; response: ScanResponse; title: string; line: string | null; actions: string[] }[] = [
  { name: "blocked-address", response: gate(422, "blocked-address"), title: CANT_SCAN, line: "Local and private network addresses are blocked.", actions: ["Try another URL"] },
  { name: "unsupported-port", response: gate(422, "unsupported-port"), title: CANT_SCAN, line: "Only ports 80 and 443 are supported.", actions: ["Try another URL"] },
  { name: "own-host", response: gate(422, "own-host"), title: CANT_SCAN, line: "Assets Scraper can't scan itself.", actions: ["Try another URL"] },
  { name: "rate-limited", response: gate(429, "rate-limited"), title: "Too many scans", line: "Wait a few minutes and try again.", actions: ["Try again"] },
  { name: "budget", response: gate(429, "budget"), title: "Daily scan limit reached", line: "Try again tomorrow.", actions: [] },
  { name: "disabled", response: gate(503, "disabled"), title: "Scanning is paused", line: "Try again later.", actions: [] },
  { name: "bot", response: gate(403, "bot"), title: "The scan request was blocked", line: "Reload the page and try again.", actions: ["Reload"] },
  { name: "dns", response: stream("dns"), title: "Couldn't find linear.app", line: CHECK, actions: ["Try again"] },
  { name: "connect", response: stream("connect"), title: "Couldn't reach linear.app", line: CHECK, actions: ["Try again"] },
  { name: "http", response: stream("http", { httpStatus: 404 }), title: "linear.app returned 404", line: "The page may have moved.", actions: ["Try again"] },
  { name: "timeout", response: stream("timeout"), title: "The page took too long to load", line: null, actions: ["Rescan"] },
  { name: "internal (stream)", response: stream("internal"), title: "Something went wrong on our side", line: null, actions: ["Try again", "Copy debug info"] },
  { name: "internal (gate 500)", response: gate(500, "internal"), title: "Something went wrong on our side", line: null, actions: ["Try again", "Copy debug info"] },
];

test.describe("error states", () => {
  for (const row of rows) {
    test(`${row.name} shows its title, line and actions`, async ({ page }) => {
      await scan(page, row.response);
      await expectPanel(page, row.title, row.line, row.actions);
    });
  }

  test("busy shows its panel after one automatic retry", async ({ page }) => {
    const record = await scan(page, stream("busy"));
    await expectPanel(page, "All browsers are busy", "Try again in a moment.", ["Try again"]);
    expect(record.bodies).toHaveLength(2);
  });

  test("Try again scans the same URL again, and Try another URL focuses the address", async ({ page }) => {
    const record = await scan(page, stream("connect"), loadFixture("linear"));
    await mockAssetRoutes(page, loadFixture("linear"));
    await panel(page).getByRole("button", { name: "Try again" }).click();
    await expect(page.getByTestId("results")).toBeVisible();
    expect(record.bodies).toEqual([{ url: "https://linear.app/" }, { url: "https://linear.app/" }]);

    await page.unrouteAll({ behavior: "ignoreErrors" });
    await scan(page, gate(422, "blocked-address"));
    await panel(page).getByRole("button", { name: "Try another URL" }).click();
    await expect(page.getByTestId("top-bar-url")).toBeFocused();
  });

  test("invalid-url from the gate returns to the inline error", async ({ page }) => {
    await scan(page, gate(400, "invalid-url"));
    await expect(page.getByText("Enter a web address, like linear.app")).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Page URL" })).toHaveValue("https://linear.app/");
  });

  test("an invalid address in the top bar keeps the results and the address bar", async ({ page }) => {
    const linear = loadFixture("linear");
    await mockAssetRoutes(page, linear);
    const record = await scan(page, linear);
    await expect(page.getByTestId("results")).toBeVisible();
    const field = page.getByTestId("top-bar-url");
    await field.fill("not a url");
    await field.press("Enter");
    const message = page.getByRole("alert").filter({ hasText: "Enter a web address, like linear.app" });
    await expect(message).toBeVisible();
    await expect(field).toBeFocused();
    await expect(field).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByTestId("results")).toBeVisible();
    await expect(page).toHaveURL(/\/\?url=https%3A%2F%2Flinear\.app%2F$/);
    await expect(page).toHaveTitle(/ · linear\.app$/);
    expect(record.bodies).toHaveLength(1);

    // Esc puts the current address back and clears the message.
    await field.press("Escape");
    await expect(field).toHaveValue("https://linear.app/");
    await expect(message).toHaveCount(0);
    await expect(page.getByTestId("results")).toBeVisible();
  });

  test("a timeout that still delivered assets keeps the results keys", async ({ page }) => {
    const linear = loadFixture("linear");
    const timedOut: ScanEvent[] = [
      ...linear.filter((event) => event.type !== "done"),
      { type: "error", code: "timeout", message: "stream timeout", diagnostics },
    ];
    await mockAssetRoutes(page, timedOut);
    await scan(page, timedOut);
    await expectPanel(page, "The page took too long to load", null, ["Rescan"]);
    await expect(page.getByText("Partial results. The page didn't finish loading.")).toBeVisible();

    await page.keyboard.press("2");
    await expect(page.getByRole("tab", { name: /^SVG/ })).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("/");
    const search = page.getByRole("searchbox", { name: "Filter by name or URL" });
    await expect(search).toBeFocused();
    await search.blur();
    await page.keyboard.press("ControlOrMeta+a");
    await expect(page.getByRole("region", { name: "Selection" }).getByTestId("selection-count")).toContainText(
      `${await page.getByTestId("asset-card").count()} selected`,
    );
    await page.keyboard.press("Escape");
    await expect(page.getByRole("region", { name: "Selection" })).toHaveCount(0);
  });

  test("access-code asks for the code, retries with the header and stores it", async ({ page }) => {
    const linear = loadFixture("linear");
    await mockAssetRoutes(page, linear);
    const record = await scan(page, gate(401, "access-code"), linear);
    await expect(panel(page).getByRole("heading", { level: 2 })).toHaveText("Enter the access code");
    const field = panel(page).getByRole("textbox", { name: "Access code" });
    await expect(field).toBeFocused();
    await field.fill("open-sesame");
    await panel(page).getByRole("button", { name: "Continue" }).click();
    await expect(page.getByTestId("results")).toBeVisible();
    expect(record.headers[1]["x-access-code"]).toBe("open-sesame");
    expect(await page.evaluate(() => localStorage.getItem("assets-scraper:access-code"))).toBe("open-sesame");
  });

  test("blocked shows its message and the assets from public sources", async ({ page }) => {
    const favicon: Asset = {
      id: "fallback-favicon",
      kind: "image",
      role: "favicon",
      name: "linear.app favicon",
      filename: "linear-favicon.png",
      format: "png",
      foundIn: ["public-source"],
      visible: false,
      declaredOnly: false,
      order: 0,
      score: 300,
      usedCount: 1,
      width: 256,
      height: 256,
      tone: "mixed",
      display: { url: "https://e2e.test/e2e-assets/fallback/linear-favicon.png", proxy: "/api/asset?u=aHR0cHM6Ly9lMmUudGVzdC9lMmUtYXNzZXRzL2ZhbGxiYWNrL2xpbmVhci1mYXZpY29uLnBuZw&e=1&s=s", format: "png" },
      original: { url: "https://e2e.test/e2e-assets/fallback/linear-favicon.png", proxy: "/api/asset?u=aHR0cHM6Ly9lMmUudGVzdC9lMmUtYXNzZXRzL2ZhbGxiYWNrL2xpbmVhci1mYXZpY29uLnBuZw&e=1&s=s", format: "png" },
    };
    const logo: Asset = { ...favicon, id: "fallback-logo", kind: "svg", role: "logo", name: "Linear logo", filename: "linear-logo.svg", format: "svg", tone: "dark", display: null, original: null, inline: { mime: "image/svg+xml", text: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>' } };
    const events = stream("blocked", { fallback: [logo, favicon] });
    await mockAssetRoutes(page, events);
    await scan(page, events);
    await expectPanel(page, "linear.app blocked the scan", "The site uses bot protection. Try another page on the site, or try again later.", ["Try again"]);
    const section = page.getByRole("region", { name: "From public sources" });
    await expect(section.getByTestId("asset-card")).toHaveCount(2);
    await section.getByTestId("asset-card").first().locator("[data-card-main]").click();
    await expect(page.getByRole("dialog").getByRole("heading", { level: 2 })).toHaveText("Linear logo");
  });

  test("not-html offers the file itself", async ({ page }) => {
    const file: Asset = {
      id: "the-file",
      kind: "image",
      role: "image",
      name: "brand.png",
      filename: "linear-brand.png",
      format: "png",
      foundIn: ["public-source"],
      visible: false,
      declaredOnly: false,
      order: 0,
      score: 100,
      usedCount: 1,
      width: 800,
      height: 600,
      tone: "opaque",
      display: null,
      original: { url: "https://e2e.test/e2e-assets/file/brand.png", proxy: "/api/asset?u=aHR0cHM6Ly9lMmUudGVzdC9lMmUtYXNzZXRzL2ZpbGUvYnJhbmQucG5n&e=1&s=s", format: "png" },
    };
    const events = stream("not-html", { fallback: [file] });
    await mockAssetRoutes(page, events);
    await scan(page, events);
    await expectPanel(page, "This URL is a file, not a page", "You can download it directly.", []);
    await expect(page.getByTestId("asset-card")).toHaveCount(1);
    await expect(page.getByTestId("asset-card").getByTestId("asset-filename")).toHaveText("linear-brand.png");
  });

  test("Copy debug info copies the diagnostics with the scan id", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await scan(page, stream("internal"));
    await panel(page).getByRole("button", { name: "Copy debug info" }).click();
    await expect(page.getByTestId("toast")).toContainText("Debug info copied");
    const text = await page.evaluate(() => navigator.clipboard.readText());
    const debug = JSON.parse(text) as { scanId: string; code: string; diagnostics: { scanId: string } };
    expect(debug).toMatchObject({ scanId: diagnostics.scanId, code: "internal", diagnostics: { scanId: diagnostics.scanId } });
  });

  test("a scan with no assets shows the empty state with Rescan", async ({ page }) => {
    const empty: ScanEvent[] = loadFixture("linear").flatMap((event): ScanEvent[] => {
      if (event.type === "assets" || event.type === "palette") return [];
      if (event.type === "fonts") return [{ ...event, families: [] }];
      return [event];
    });
    const record = await scan(page, empty);
    await expect(page.getByText("No SVGs, images or fonts on this page")).toBeVisible();
    await expect(page.getByText("Some sites only load content after sign-in.")).toBeVisible();
    await page.getByRole("button", { name: "Rescan" }).click();
    await expect.poll(() => record.bodies.length).toBe(2);
  });

  test("an empty tab says so", async ({ page }) => {
    const noFonts = loadFixture("linear").map((event): ScanEvent => (event.type === "fonts" ? { ...event, families: [] } : event));
    await mockAssetRoutes(page, noFonts);
    await scan(page, noFonts);
    await page.getByRole("tab", { name: /^Fonts/ }).click();
    await expect(page.getByText("No fonts on this page")).toBeVisible();
  });
});
