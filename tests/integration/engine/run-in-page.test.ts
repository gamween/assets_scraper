import type { Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withBrowser } from "@/server/browser/launch";
import { InPageTimeoutError, runInPage } from "@/server/scan/inpage/run";
import { serveFixture, type FixtureServer } from "../../fixtures/serve";
import { startTestProxy, type TestProxy } from "./helpers";

let fixture: FixtureServer;
let proxy: TestProxy;

beforeAll(async () => {
  fixture = await serveFixture({
    "/hostile.html": (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html><title>Hostile</title><script>Array.prototype.includes = () => { throw new Error('patched by the page'); };</script>");
    },
  });
  proxy = await startTestProxy({ allow: [fixture.host] });
});

afterAll(async () => {
  await proxy.close();
  await fixture.close();
});

const onPage = <T>(pathname: string, fn: (page: Page) => Promise<T>) =>
  withBrowser({ egressPort: proxy.port, signal: new AbortController().signal }, async ({ page }) => {
    await page.goto(`${fixture.origin}${pathname}`);
    return fn(page);
  });

describe("runInPage", () => {
  it("runs bundled code in an isolated world that page patches cannot reach", async () => {
    await onPage("/hostile.html", async (page) => {
      await expect(page.evaluate(() => [1, 2].includes(2))).rejects.toThrow("patched by the page");
      const result = await runInPage(page, "globalThis.__t = { go: () => [1,2].includes(2) }", "globalThis.__t.go()", { timeoutMs: 2000 });
      expect(result).toEqual({ value: true, world: "isolated" });
      expect(await page.evaluate(() => typeof (globalThis as { __t?: unknown }).__t)).toBe("undefined");
    });
  });

  it("awaits promises, returns plain JSON and shares the DOM with the page", async () => {
    await onPage("/", async (page) => {
      const result = await runInPage<{ title: string; svgs: number }>(page, "globalThis.__c = { collect: async (o) => ({ title: document.title, svgs: document.querySelectorAll(o.selector).length }) }", 'globalThis.__c.collect({"selector":"svg"})', { timeoutMs: 5000 });
      expect(result.world).toBe("isolated");
      expect(result.value.title).toBe("Fixture Co");
      expect(result.value.svgs).toBeGreaterThan(5);
    });
  });

  it("rejects with the page exception without retrying in the main world", async () => {
    await onPage("/", async (page) => {
      const source = "globalThis.__c = { collect() { const root = document.documentElement; root.dataset.runs = Number(root.dataset.runs || 0) + 1; throw new TypeError('collector broke') } }";
      await expect(runInPage(page, source, "globalThis.__c.collect()", { timeoutMs: 2000 })).rejects.toThrow("TypeError: collector broke");
      expect(await page.evaluate(() => document.documentElement.dataset.runs)).toBe("1");
      await expect(runInPage(page, "", "Promise.reject(new Error('async failure'))", { timeoutMs: 2000 })).rejects.toThrow("async failure");
    });
  });

  it("rejects after timeoutMs when the expression never resolves", async () => {
    await onPage("/", async (page) => {
      const started = Date.now();
      await expect(runInPage(page, "", "new Promise(() => {})", { timeoutMs: 500 })).rejects.toBeInstanceOf(InPageTimeoutError);
      expect(Date.now() - started).toBeLessThan(2500);
      const controller = new AbortController();
      setTimeout(() => controller.abort(new Error("scan cancelled")), 100);
      await expect(runInPage(page, "", "new Promise(() => {})", { timeoutMs: 5000, signal: controller.signal })).rejects.toThrow("scan cancelled");
      expect(Date.now() - started).toBeLessThan(4000);
      expect(await runInPage(page, "", "1 + 1", { timeoutMs: 2000 })).toEqual({ value: 2, world: "isolated" });
    });
  });

  it("falls back to the main world when the isolated world cannot be created", async () => {
    await onPage("/", async (page) => {
      const closedPage = await page.context().newPage();
      const deadSession = await page.context().newCDPSession(closedPage);
      await closedPage.close();
      const result = await runInPage(page, "globalThis.__main = 41", "document.title + ' ' + (globalThis.__main + 1)", { timeoutMs: 2000, createSession: async () => deadSession });
      expect(result).toEqual({ value: "Fixture Co 42", world: "main" });
      expect(await page.evaluate(() => (globalThis as { __main?: number }).__main)).toBe(41);
    });
  });
});
