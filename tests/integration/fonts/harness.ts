import { chromium, type Browser } from "playwright-core";
import { startCapture } from "@/server/scan/capture";
import type { CapturedNetwork, RawCollectorOutput, Signer } from "@/server/scan/types";
import { collectorOptions, runCollector } from "../assets/harness";

export function launchChrome(): Promise<Browser> {
  const executablePath = process.env.CHROME_EXECUTABLE_PATH;
  return chromium.launch(executablePath ? { executablePath } : { channel: "chrome" });
}

/**
 * Loads a page in a fresh context and reads its fonts the way the engine does: the engine's network capture
 * (`startCapture`) and the bundled in-page collector, whose `fontFaces`, `fontStatuses` and `fontUsage` feed
 * `buildFontFamilies`. The collector used to be a hand-written stand-in for its font part, which the real one could
 * drift from without any font test noticing.
 */
export async function scanPageFonts(browser: Browser, url: string): Promise<{ collector: RawCollectorOutput; network: CapturedNetwork }> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const page = await context.newPage();
    const capture = startCapture(page, { signal: new AbortController().signal });
    await page.goto(url, { waitUntil: "load" });
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    const collector = await runCollector(page, collectorOptions(new URL(url).host, ""));
    const network = await capture.settle(30_000);
    return { collector, network };
  } finally {
    await context.close();
  }
}

export interface RecordingSigner extends Signer {
  signed: string[];
}

export function fakeSigner(): RecordingSigner {
  const signed: string[] = [];
  return {
    signed,
    sign(url) {
      signed.push(url);
      return `/api/asset?u=${encodeURIComponent(url)}`;
    },
    get count() {
      return signed.length;
    },
  };
}
