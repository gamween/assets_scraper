import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { BusyError, PIDFILE_ENV, withBrowser, wrapperScript } from "@/server/browser/launch";
import { serveFixture, type FixtureServer } from "../../fixtures/serve";
import { delay, isProcessAlive, startTestProxy, type TestProxy } from "./helpers";

let fixture: FixtureServer;
let proxy: TestProxy;
const hits = { sw: 0, file: 0, video: 0 };

beforeAll(async () => {
  fixture = await serveFixture({
    "/blank.html": (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end('<!doctype html><title>Blank</title><a id="dl" href="/file.bin" download>file</a>');
    },
    "/sw.js": (_req, res) => {
      hits.sw += 1;
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end("");
    },
    "/file.bin": (_req, res) => {
      hits.file += 1;
      res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": "attachment; filename=file.bin" });
      res.end("download payload");
    },
    "/clip.mp4": (_req, res) => {
      hits.video += 1;
      res.writeHead(200, { "content-type": "video/mp4" });
      res.end("not a video");
    },
  });
  proxy = await startTestProxy({ allow: [fixture.host] });
});

afterAll(async () => {
  await proxy.close();
  await fixture.close();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const open = () => ({ egressPort: proxy.port, signal: new AbortController().signal });

describe("withBrowser", () => {
  it("gives a working page and closes the browser afterwards", async () => {
    let pid = 0;
    const state = await withBrowser(open(), async (session) => {
      pid = session.pid ?? 0;
      expect(isProcessAlive(pid)).toBe(true);
      expect(session.cold).toBe(true);
      expect(session.launchMs).toBeGreaterThan(0);
      await session.page.goto("about:blank");
      return session.page.evaluate(() => document.readyState);
    });
    expect(state).toBe("complete");
    expect(pid).toBeGreaterThan(1);
    await expect.poll(() => isProcessAlive(pid), { timeout: 5000 }).toBe(false);
  });

  it("runs concurrent calls one at a time", async () => {
    const onQueued = vi.fn();
    let running = 0;
    let maxRunning = 0;
    const run = () =>
      withBrowser({ ...open(), onQueued }, async (session) => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await delay(300);
        running -= 1;
        return session.queueMs;
      });
    const queueTimes = await Promise.all([run(), run()]);
    expect(maxRunning).toBe(1);
    expect(onQueued).toHaveBeenCalledTimes(1);
    expect(Math.min(...queueTimes)).toBe(0);
    expect(Math.max(...queueTimes)).toBeGreaterThan(0);
  });

  it("rejects queued calls with BusyError after the queue wait", async () => {
    vi.stubEnv("MAX_CONCURRENT_SCANS", "1");
    vi.stubEnv("QUEUE_WAIT_MS", "200");
    const results = await Promise.allSettled([
      withBrowser(open(), () => delay(1500)),
      withBrowser(open(), async () => "second"),
      withBrowser(open(), async () => "third"),
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected", "rejected"]);
    for (const result of results.slice(1)) expect((result as PromiseRejectedResult).reason).toBeInstanceOf(BusyError);
  });

  it("uses the hardened context behind the egress proxy", async () => {
    await withBrowser(open(), async ({ browser, page, cold }) => {
      expect(cold).toBe(false);
      await page.goto(`${fixture.origin}/blank.html`);
      expect(proxy.requests).toContain(`${fixture.origin}/blank.html`);

      const info = await page.evaluate(() => ({ ua: navigator.userAgent, width: innerWidth, height: innerHeight, dpr: devicePixelRatio, language: navigator.language }));
      expect(info.ua).not.toContain("HeadlessChrome");
      expect(info.ua).toContain(`Chrome/${browser.version().split(".")[0]}.0.0.0`);
      expect(info).toMatchObject({ width: 1440, height: 900, dpr: 1, language: "en-US" });
      expect(page.viewportSize()).toEqual({ width: 1440, height: 900 });

      expect(await page.evaluate(() => navigator.serviceWorker.register("/sw.js").then(String))).toBe("undefined");

      const [download] = await Promise.all([page.waitForEvent("download"), page.click("#dl")]);
      await expect(download.path()).rejects.toThrow(/acceptDownloads/);

      expect(await page.evaluate(() => fetch("/clip.mp4").then(() => "loaded", () => "blocked"))).toBe("blocked");
    });
    expect(hits.sw).toBe(0);
    expect(hits.video).toBe(0);
  });

  it("kills the browser and rejects when the signal aborts while fn runs", async () => {
    const controller = new AbortController();
    let pid = 0;
    const running = withBrowser({ egressPort: proxy.port, signal: controller.signal }, async (session) => {
      pid = session.pid ?? 0;
      await new Promise(() => {});
    });
    await expect.poll(() => pid, { timeout: 20_000 }).toBeGreaterThan(1);
    const started = Date.now();
    controller.abort(new Error("scan cancelled"));
    await expect(running).rejects.toThrow("scan cancelled");
    expect(Date.now() - started).toBeLessThan(5000);
    await expect.poll(() => isProcessAlive(pid), { timeout: 5000 }).toBe(false);

    expect(await withBrowser(open(), async () => "next scan runs")).toBe("next scan runs");
  });

  it("kills a browser left behind by a Node process that died mid-scan before launching", async () => {
    const binary = process.env.CHROME_EXECUTABLE_PATH ?? (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/google-chrome");
    const deadOwner = spawnSync("true").pid;
    const stateDir = path.join(tmpdir(), "assets-scraper");
    const scratch = await mkdtemp(path.join(tmpdir(), "stale-browser-"));
    await mkdir(stateDir, { recursive: true });
    const wrapper = path.join(scratch, "wrapper.sh");
    const pidfile = path.join(stateDir, `chromium-${deadOwner}-0.pid`);
    await writeFile(wrapper, wrapperScript(binary));
    await chmod(wrapper, 0o755);
    const orphan = spawn(wrapper, ["--headless", "--no-sandbox", "--no-first-run", `--user-data-dir=${path.join(scratch, "profile")}`, "about:blank"], {
      detached: true,
      stdio: "ignore",
      env: { PATH: process.env.PATH, HOME: process.env.HOME, [PIDFILE_ENV]: pidfile } as unknown as NodeJS.ProcessEnv,
    });
    try {
      await expect.poll(() => isProcessAlive(orphan.pid ?? 0) && spawnSync("cat", [pidfile]).stdout.toString().trim(), { timeout: 10_000 }).toBe(String(orphan.pid));
      await withBrowser(open(), async () => {});
      await expect.poll(() => isProcessAlive(orphan.pid ?? 0), { timeout: 5000 }).toBe(false);
    } finally {
      if (orphan.pid && isProcessAlive(orphan.pid)) process.kill(-orphan.pid, "SIGKILL");
      await rm(scratch, { recursive: true, force: true });
      await rm(pidfile, { force: true });
    }
  });

  it("rejects at once when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("already gone"));
    const fn = vi.fn();
    await expect(withBrowser({ egressPort: proxy.port, signal: controller.signal }, fn)).rejects.toThrow("already gone");
    expect(fn).not.toHaveBeenCalled();
  });
});
