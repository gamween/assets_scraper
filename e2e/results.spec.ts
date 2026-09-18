import { expect, test, type Page } from "@playwright/test";
import type { Asset, ScanEvent } from "../src/lib/contract";
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
    // Fonts count in their tab, not in the asset count (contract `stats.assets`).
    const stats = linear.flatMap((event) => (event.type === "done" ? [event.stats] : []))[0];
    expect(linearAssets.length).toBe(stats.assets);
    await expect(page.getByTestId("results-meta")).toHaveText(`linear.app · ${stats.assets} assets · 11s`);
    await expect(page).toHaveTitle(`${stats.assets} assets · linear.app`);
    await expect(page.getByRole("button", { name: "Rescan" })).toBeVisible();
    // The button carries the number of files it would zip: its scope is the whole tab, not the filtered grid.
    await expect(page.getByRole("button", { name: /^Download all \d+$/ })).toBeVisible();

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

  test("Auto never picks the checkerboard, and a pale swatch is still a swatch", async ({ page }) => {
    await openResults(page, linear);
    // Spec 12.3: light on dark, dark on light, everything else on the plain well. The checkerboard is opt-in.
    await expect(page.locator('[data-testid="preview-well"][data-background="grid"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="preview-well"][data-background="plain"]').first()).toBeVisible();

    const contrasts = await page.getByTestId("swatch-chip").evaluateAll((chips) => {
      const channel = (value: number) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
      const luminance = (color: string) => {
        const [r, g, b] = color.match(/[\d.]+/g)!.slice(0, 3).map((part) => channel(Number(part) / 255));
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const ratio = (a: string, b: string) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
      const ground = getComputedStyle(document.body).backgroundColor;
      return chips.map((chip) => {
        const style = getComputedStyle(chip);
        // Either the fill itself is distinguishable from the page, or the border carries the boundary.
        return Math.max(ratio(style.backgroundColor, ground), ratio(style.borderTopColor, ground));
      });
    });
    expect(contrasts.length).toBeGreaterThan(3);
    for (const contrast of contrasts) expect(contrast).toBeGreaterThanOrEqual(3);
  });

  test("the header and the tab title both drop a www the user did not type", async ({ page }) => {
    const wwwHost = linear.map((event) =>
      event.type === "page" ? { ...event, page: { ...event.page, host: "www.linear.app", finalUrl: "https://www.linear.app/" } } : event,
    );
    await openResults(page, wwwHost);
    await expect(page.getByTestId("results-meta")).toContainText("linear.app · ");
    await expect(page.getByTestId("results-meta")).not.toContainText("www.");
    await expect(page).toHaveTitle(/^\d+ assets · linear\.app$/);
  });

  test("Logos lead All, and the SVG tab has no Logos section", async ({ page }) => {
    await openResults(page, linear);
    const headings = page.getByTestId("results").getByRole("heading", { level: 2 });
    await expect(headings.first()).toHaveText("Logos");
    await expect(section(page, "Logos").getByTestId("asset-card").first()).toHaveAttribute("data-role", "site-logo");
    // The badge would repeat the section header on every card in here, so it is dropped (spec 12.3).
    await expect(section(page, "Logos").getByText("Logo", { exact: true })).toHaveCount(0);

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
    // In `All` this card sits under the `Logos` header, so it carries no badge; on the SVG tab it does.
    await expect(card.getByText("Logo", { exact: true })).toHaveCount(0);

    const og = findAsset(linear, (a) => a.role === "social");
    const ogCard = page.locator(`[data-asset-id="${og.id}"]`);
    await expect(ogCard.getByTestId("asset-meta")).toHaveText(`${og.format.toUpperCase()} · ${formatDimensions(og.width, og.height)} · ${formatBytes(og.bytes!)}`);
    await expect(ogCard.getByText("OG image", { exact: true })).toBeVisible();
  });

  test("the file name can be selected with the mouse, and still opens the tile", async ({ page }) => {
    await openResults(page, linear);
    const logo = findAsset(linear, (a) => a.role === "site-logo" && a.width === 88);
    const name = page.locator(`[data-asset-id="${logo.id}"]`).getByTestId("asset-filename");
    await expect(name).toHaveAttribute("title", logo.filename);

    const box = (await name.boundingBox())!;
    await page.mouse.move(box.x + 1, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
    expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).not.toBe("");
    // The drag must not have opened the detail view on mouse up.
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await name.click();
    await expect(page.getByRole("dialog")).toBeVisible();
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

  function withGifs() {
    const photo = findAsset(linear, (a) => a.kind === "image" && a.role === "image" && a.visible && !!a.display && (a.renderedWidth ?? 0) > 100);
    const url = "https://e2e.test/e2e-assets/linear.app/loop.gif";
    const remote = { url, proxy: `/api/asset?u=${Buffer.from(url).toString("base64url")}&e=1&s=s`, format: "gif" as const, width: 400, height: 300 };
    const remoteGif: Asset = { ...photo, id: "remote-gif", name: "loop.gif", filename: "linear-loop.gif", format: "gif", score: 5000, width: 400, height: 300, display: remote, original: remote };
    // Two 8x6 frames: blue, then red.
    const base64 = "R0lGODlhCAAGAIAAAExpcStQ6CH/C05FVFNDQVBFMi4wAwEAAAAh+QQFFAAAACwAAAAACAAGAAACBoyPqct9BQAh+QQFFAAAACwAAAAACAAGAIBMaXHGKCgCBoyPqct9BQA7";
    const inlineGif: Asset = { ...remoteGif, id: "inline-gif", name: "pulse.gif", filename: "linear-pulse.gif", width: 8, height: 6, display: null, original: null, inline: { mime: "image/gif", base64 } };
    let added = false;
    const events = linear.map((event) => {
      if (event.type !== "assets" || added) return event;
      added = true;
      return { ...event, items: [...event.items, remoteGif, inlineGif] };
    });
    return { events, remoteGif, inlineGif };
  }

  test("GIF tiles show their first frame and play only while hovered", async ({ page }) => {
    const { events, remoteGif, inlineGif } = withGifs();
    await openResults(page, events);
    await page.getByRole("tab", { name: /^Images/ }).click();

    for (const id of [remoteGif.id, inlineGif.id]) {
      const card = page.locator(`[data-asset-id="${id}"]`);
      const well = card.getByTestId("preview-well");
      const still = well.getByTestId("gif-still");
      await card.scrollIntoViewIfNeeded();
      await expect(still).toHaveAttribute("data-state", "ready");
      await expect(still).toHaveCSS("opacity", "1");
      // No animated image runs until the card is hovered, not even a hidden one.
      await expect(well.locator("img")).toHaveCount(0);

      await card.hover();
      await expect(well.locator("img")).toHaveAttribute("data-loaded", "");
      await expect(well.locator("img")).toHaveCSS("opacity", "1");
      await expect(still).toHaveCSS("opacity", "0");

      await page.mouse.move(1, 1);
      await expect(well.locator("img")).toHaveCount(0);
      await expect(still).toHaveCSS("opacity", "1");
    }

    // The still frame is the first frame of the animation.
    const pixel = await page
      .locator(`[data-asset-id="${inlineGif.id}"]`)
      .getByTestId("gif-still")
      .evaluate((canvas: HTMLCanvasElement) => [...canvas.getContext("2d")!.getImageData(4, 3, 1, 1).data]);
    expect(pixel).toEqual([43, 80, 232, 255]);
  });

  test("GIF tiles whose first frame can't be drawn still play only while hovered", async ({ page }) => {
    // No 2D context: the still frame is unavailable.
    await page.addInitScript(() => {
      HTMLCanvasElement.prototype.getContext = () => null;
    });
    const { events, remoteGif, inlineGif } = withGifs();
    await openResults(page, events);
    await page.getByRole("tab", { name: /^Images/ }).click();

    for (const id of [remoteGif.id, inlineGif.id]) {
      const card = page.locator(`[data-asset-id="${id}"]`);
      const well = card.getByTestId("preview-well");
      await card.scrollIntoViewIfNeeded();
      await expect(well.getByTestId("gif-still")).toHaveAttribute("data-state", "unavailable");
      await expect(well.locator("img")).toHaveCount(0);
      await expect(well.getByTestId("gif-placeholder")).toHaveText("GIF");

      await card.hover();
      await expect(well.locator("img")).toHaveAttribute("data-loaded", "");
      await expect(well.locator("img")).toHaveCSS("opacity", "1");
      await expect(well.getByTestId("gif-placeholder")).toHaveCSS("opacity", "0");

      await page.mouse.move(1, 1);
      await expect(well.locator("img")).toHaveCount(0);
      await expect(well.getByTestId("gif-placeholder")).toHaveCSS("opacity", "1");
    }
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

  test.describe("on a phone", () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test("the background control is a compact select next to the tabs", async ({ page }) => {
      await openResults(page, linear);
      await expect(page.getByRole("radiogroup", { name: "Preview background" })).toBeHidden();
      const select = page.getByRole("combobox", { name: "Preview background" });
      await expect(select).toBeVisible();
      await expect(select.locator("option")).toHaveText(["Auto", "Light", "Dark", "Grid"]);
      const well = section(page, "Logos").getByTestId("asset-card").first().getByTestId("preview-well");
      await expect(well).toHaveAttribute("data-background", "dark");
      await select.selectOption("grid");
      await expect(well).toHaveAttribute("data-background", "grid");
      // Both controls write the same preference.
      await page.setViewportSize({ width: 1024, height: 768 });
      await expect(page.getByRole("radiogroup", { name: "Preview background" }).getByRole("radio", { name: "Grid" })).toHaveAttribute("aria-checked", "true");
    });
  });

  test("a partial scan shows the banner", async ({ page }) => {
    const partial = withDone(loadFixture("framer"), (done) => ({ ...done, partial: true }));
    await openResults(page, partial, {}, "https://framer.com/");
    await expect(page.getByText("Partial results. The page didn't finish loading.")).toBeVisible();
  });
});
