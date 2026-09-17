import type { CDPSession, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { withBrowser } from "@/server/browser/launch";
import { InPageResultTooLargeError, InPageTimeoutError, PageGoneError, runInPage } from "@/server/scan/inpage/run";
import { serveFixture, type FixtureServer } from "../../fixtures/serve";
import { delay, startTestProxy, type TestProxy } from "./helpers";

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

const onPage = <T>(pathname: string, fn: (page: Page, pid?: number) => Promise<T>) =>
  withBrowser({ egressPort: proxy.port, signal: new AbortController().signal }, async ({ page, pid }) => {
    await page.goto(`${fixture.origin}${pathname}`);
    return fn(page, pid);
  });

/**
 * A CDP session whose target is gone. Its page lives in a context of its own: the scan context closes every page other
 * than the scan page as it opens.
 */
async function createDeadSession(page: Page): Promise<CDPSession> {
  const browser = page.context().browser();
  if (!browser) throw new Error("expected a browser");
  const context = await browser.newContext();
  const session = await context.newCDPSession(await context.newPage());
  await context.close();
  return session;
}

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
      const deadSession = await createDeadSession(page);
      const result = await runInPage(page, "globalThis.__main = 41", "document.title + ' ' + (globalThis.__main + 1)", { timeoutMs: 2000, createSession: async () => deadSession });
      expect(result).toEqual({ value: "Fixture Co 42", world: "main" });
      expect(await page.evaluate(() => (globalThis as { __main?: number }).__main)).toBe(41);
    });
  });

  it("caps the result it sends to Node, even when a main-world page patches JSON", async () => {
    await onPage("/", async (page) => {
      await expect(runInPage(page, "", "'x'.repeat(5000)", { timeoutMs: 2000, maxResultChars: 1000 })).rejects.toBeInstanceOf(InPageResultTooLargeError);
      expect(await runInPage(page, "", "({ text: 'x'.repeat(500) })", { timeoutMs: 2000, maxResultChars: 1000 })).toEqual({ value: { text: "x".repeat(500) }, world: "isolated" });
      expect(await runInPage(page, "", "undefined", { timeoutMs: 2000 })).toEqual({ value: undefined, world: "isolated" });

      await page.evaluate(() => {
        JSON.stringify = () => "y".repeat(10_000);
      });
      const deadSession = await createDeadSession(page);
      const main = runInPage(page, "", "({ ok: true })", { timeoutMs: 2000, maxResultChars: 1000, createSession: async () => deadSession });
      await expect(main).rejects.toBeInstanceOf(InPageResultTooLargeError);
    });
  });

  it("detaches a session that arrives after the timeout and never runs the code late", async () => {
    await onPage("/", async (page) => {
      const detached = vi.fn();
      const lateSession = async (target: Page): Promise<CDPSession> => {
        await delay(400);
        const session = await target.context().newCDPSession(target);
        const detach = session.detach.bind(session);
        session.detach = () => {
          detached();
          return detach();
        };
        return session;
      };
      const mark = "document.documentElement.dataset.ran = 'late'";
      await expect(runInPage(page, "", mark, { timeoutMs: 100, createSession: lateSession })).rejects.toBeInstanceOf(InPageTimeoutError);
      await expect.poll(() => detached.mock.calls.length, { timeout: 3000 }).toBe(1);

      // A session that fails after the timeout does not start the main-world fallback either.
      const lateFailure = async (): Promise<CDPSession> => {
        await delay(400);
        throw new Error("no CDP session");
      };
      await expect(runInPage(page, "", mark, { timeoutMs: 100, createSession: lateFailure })).rejects.toBeInstanceOf(InPageTimeoutError);
      await delay(800);
      expect(await page.evaluate(() => document.documentElement.dataset.ran)).toBeUndefined();
    });
  });

  it("never starts the code in an isolated world that arrives after the timeout", async () => {
    await onPage("/", async (page) => {
      const sent: string[] = [];
      let worldArrived = () => {};
      const arrived = new Promise<void>((resolve) => (worldArrived = resolve));
      // A page busy in a script answers Page.createIsolatedWorld late.
      const slowWorld = async (target: Page): Promise<CDPSession> => {
        const session = await target.context().newCDPSession(target);
        const send = session.send.bind(session) as (method: string, params?: object) => Promise<unknown>;
        session.send = (async (method: string, params?: object) => {
          sent.push(method);
          const result = await send(method, params);
          if (method !== "Page.createIsolatedWorld") return result;
          await delay(400);
          // Runs after every continuation of this answer, so runInPage has sent what it sends next by then.
          setImmediate(worldArrived);
          return result;
        }) as CDPSession["send"];
        return session;
      };
      const onWorld = vi.fn();
      const mark = "document.documentElement.dataset.ran = 'late'";
      await expect(runInPage(page, "", mark, { timeoutMs: 100, createSession: slowWorld, onWorld })).rejects.toBeInstanceOf(InPageTimeoutError);
      await arrived;
      expect(sent).toEqual(["Page.getFrameTree", "Page.createIsolatedWorld"]);
      expect(onWorld).not.toHaveBeenCalled();
      expect(await page.evaluate(() => document.documentElement.dataset.ran)).toBeUndefined();
    });
  });

  it("tells which world the code started in, before it fails or times out there", async () => {
    await onPage("/", async (page) => {
      const onWorld = vi.fn();
      await expect(runInPage(page, "", "new Promise(() => {})", { timeoutMs: 300, onWorld })).rejects.toBeInstanceOf(InPageTimeoutError);
      expect(onWorld.mock.calls).toEqual([["isolated"]]);

      onWorld.mockClear();
      const deadSession = await createDeadSession(page);
      await expect(runInPage(page, "", "new Promise(() => {})", { timeoutMs: 300, createSession: async () => deadSession, onWorld })).rejects.toBeInstanceOf(InPageTimeoutError);
      expect(onWorld.mock.calls).toEqual([["main"]]);
    });
  });

  it("rejects at once when the renderer crashes or the browser dies, which leave a CDP call unanswered", async () => {
    /** Code that marks the page once it runs, then never ends: the test acts once the evaluation is in flight. */
    const hang = "(document.documentElement.dataset.running = 'yes', new Promise(() => {}))";
    const running = (page: Page) => expect.poll(() => page.evaluate(() => document.documentElement.dataset.running), { timeout: 5000 }).toBe("yes");
    await onPage("/", async (page) => {
      const evaluation = runInPage(page, "", hang, { timeoutMs: 20_000 });
      await running(page);
      const crashedAt = Date.now();
      void page.context().newCDPSession(page).then((cdp) => cdp.send("Page.crash")).catch(() => {});
      await expect(evaluation).rejects.toBeInstanceOf(PageGoneError);
      expect(Date.now() - crashedAt).toBeLessThan(5000);
    });

    let killedAt = 0;
    const result = await onPage("/", async (page, pid) => {
      const evaluation = runInPage(page, "", hang, { timeoutMs: 20_000 });
      await running(page);
      killedAt = Date.now();
      process.kill(pid ?? 0, "SIGKILL");
      return evaluation.then(() => "resolved", (error: unknown) => error);
    });
    expect(result).toBeInstanceOf(PageGoneError);
    expect(Date.now() - killedAt).toBeLessThan(5000);
  });
});
