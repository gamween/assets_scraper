import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, rm, statfs, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Browser, BrowserContext, CDPSession, Frame, Page } from "playwright-core";
import { limits } from "@/server/config/limits";

export class BusyError extends Error {
  constructor(message = "All browsers are busy") {
    super(message);
    this.name = "BusyError";
  }
}

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  cold: boolean;
  queueMs: number;
  launchMs: number;
  health: { tmpFreeMb?: number; memAvailableMb?: number };
  /** PID of the Chromium process, read from the pidfile its wrapper script writes. */
  pid?: number;
}

const MB = 1024 * 1024;

/** Flags from `@sparticuz/chromium` that let a page read other origins and internal services (critic R1). */
const INSECURE_FLAGS = ["--disable-web-security", "--allow-running-insecure-content", "--disable-site-isolation-trials"];
const EXTRA_FLAGS = ["--disable-blink-features=AutomationControlled", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--hide-scrollbars", "--mute-audio"];
const BROWSER_ENV_KEYS = ["PATH", "HOME", "LD_LIBRARY_PATH", "FONTCONFIG_PATH", "TZ"];
/** Media never helps a scan and can be huge (spec 7.3). Posters are images and still load. */
const MEDIA_URL_PATTERNS = ["*.mp4", "*.mp4?*", "*.webm", "*.webm?*", "*.m3u8", "*.m3u8?*", "*.mov", "*.mov?*"];
/** Leftovers of earlier launches in `/tmp` (spec 7.3). */
const STALE_TMP_ENTRY = /^(core\.|playwright_chromiumdev_profile-|playwright-artifacts-)/;

export const PIDFILE_ENV = "ASSETS_SCRAPER_PIDFILE";
/**
 * Chromium ignores switches it does not know. This one names the pidfile of the launch on the browser's command line,
 * so a stale pidfile can only ever kill the browser it was written for (see `isOwnBrowser`).
 */
export const pidfileMarker = (pidfile: string) => `--assets-scraper-pidfile=${pidfile}`;

export function chromiumArgs(baseArgs: string[]): string[] {
  const kept = baseArgs.filter((arg) => !INSECURE_FLAGS.includes(arg.split("=")[0]));
  return [...kept, ...EXTRA_FLAGS.filter((flag) => !kept.includes(flag))];
}

/**
 * Launch wrapper (spec 7.3): no core dumps (a single-process Chromium segfaults on close and writes ~300 MB into
 * `/tmp`), and the PID written before `exec`, so it is Chromium's own PID and a stale browser can be killed later.
 */
export function wrapperScript(binary: string): string {
  const quoted = `'${binary.replaceAll("'", `'\\''`)}'`;
  return `#!/bin/sh\nulimit -c 0\necho $$ > "$${PIDFILE_ENV}"\nunset ${PIDFILE_ENV}\nexec ${quoted} "$@"\n`;
}

export function parseMemAvailableMb(meminfo: string): number | undefined {
  const match = /^MemAvailable:\s+(\d+)\s*kB/m.exec(meminfo);
  return match ? Math.floor(Number(match[1]) / 1024) : undefined;
}

/** Chromium gets no app secrets in its environment (spec 7.3). */
export function browserEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  return Object.fromEntries(BROWSER_ENV_KEYS.flatMap((key) => (env[key] === undefined ? [] : [[key, env[key]]])));
}

export function userAgentFor(browserVersion: string): string {
  const major = browserVersion.split(".")[0];
  return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

const isServerless = () => Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);

function localExecutablePath(): string {
  if (process.env.CHROME_EXECUTABLE_PATH) return process.env.CHROME_EXECUTABLE_PATH;
  if (process.platform === "darwin") return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (process.platform === "win32") return "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  return "/usr/bin/google-chrome";
}

const stateDir = () => path.join(tmpdir(), "assets-scraper");
/** One pidfile per Node process and semaphore slot, so a launch never kills a browser another scan is using. */
const pidfilePath = (slot: number, owner = process.pid) => path.join(stateDir(), `chromium-${owner}-${slot}.pid`);

interface Executable {
  binary: string;
  args: string[];
}

let serverlessExecutable: Promise<Executable> | null = null;

async function resolveExecutable(): Promise<Executable> {
  if (!isServerless()) return { binary: localExecutablePath(), args: [] };
  // Single flight: concurrent executablePath() calls race while inflating (Sparticuz/chromium#507).
  serverlessExecutable ??= (async () => {
    const chromium = (await import("@sparticuz/chromium")).default;
    chromium.setGraphicsMode = false;
    return { binary: await chromium.executablePath(), args: chromium.args };
  })().catch((error: unknown) => {
    serverlessExecutable = null;
    throw error;
  });
  return serverlessExecutable;
}

/** Written on every launch (write then rename), so a cleaned `/tmp` or a half-written file never breaks a launch. */
async function writeWrapper(binary: string): Promise<string> {
  const dir = stateDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `chromium-${createHash("sha1").update(binary).digest("hex").slice(0, 12)}.sh`);
  const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}`;
  await writeFile(temp, wrapperScript(binary), { mode: 0o700 });
  await chmod(temp, 0o700);
  await rename(temp, file);
  return file;
}

function killProcessTree(pid: number): void {
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, "SIGKILL");
    } catch {
      // Already gone, or not a group leader.
    }
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Guards against PID reuse: only kill a process whose command line runs the browser binary with the marker of this
 * pidfile. Locally the binary is the developer's own Google Chrome, which a reused PID must never kill.
 */
async function isOwnBrowser(pid: number, binary: string, pidfile: string): Promise<boolean> {
  try {
    const command = process.platform === "linux"
      ? (await readFile(`/proc/${pid}/cmdline`, "utf8")).replaceAll("\0", " ")
      : (await promisify(execFile)("ps", ["-ww", "-o", "command=", "-p", String(pid)])).stdout;
    return command.includes(binary) && command.includes(pidfileMarker(pidfile));
  } catch {
    return false;
  }
}

const readPid = async (file: string) => {
  const pid = Number((await readFile(file, "utf8").catch(() => "")).trim());
  return Number.isSafeInteger(pid) && pid > 1 ? pid : undefined;
};

/**
 * Kills a browser left behind by a scan that never reached its cleanup (an invocation terminated mid-scan), in this
 * slot, or in any slot of a Node process that no longer exists.
 */
async function killStaleChromium(slot: number, binary: string): Promise<void> {
  const files = await readdir(stateDir()).catch(() => [] as string[]);
  for (const name of files) {
    const match = /^chromium-(\d+)-(\d+)\.pid$/.exec(name);
    if (!match) continue;
    const owner = Number(match[1]);
    if (owner === process.pid ? Number(match[2]) !== slot : isAlive(owner)) continue;
    const file = path.join(stateDir(), name);
    const pid = await readPid(file);
    if (pid && (await isOwnBrowser(pid, binary, file))) killProcessTree(pid);
    await rm(file, { force: true });
  }
}

async function sweepTmp(): Promise<void> {
  const dir = tmpdir();
  const entries = await readdir(dir).catch(() => [] as string[]);
  await Promise.all(entries.filter((name) => STALE_TMP_ENTRY.test(name)).map((name) => rm(path.join(dir, name), { recursive: true, force: true }).catch(() => {})));
}

export async function readMemAvailableMb(): Promise<number | undefined> {
  return parseMemAvailableMb(await readFile("/proc/meminfo", "utf8").catch(() => ""));
}

async function readHealth(): Promise<BrowserSession["health"]> {
  const health: BrowserSession["health"] = {};
  try {
    const stats = await statfs(tmpdir());
    health.tmpFreeMb = Math.floor((Number(stats.bavail) * Number(stats.bsize)) / MB);
  } catch {
    // Unknown free space does not block a scan.
  }
  const memAvailableMb = await readMemAvailableMb();
  if (memAvailableMb !== undefined) health.memAvailableMb = memAvailableMb;
  return health;
}

const isHealthy = ({ tmpFreeMb, memAvailableMb }: BrowserSession["health"]) =>
  (tmpFreeMb === undefined || tmpFreeMb >= limits.minTmpFreeMb) && (memAvailableMb === undefined || memAvailableMb >= limits.minMemAvailableMb);

/** Spec 7.3: kill stale browsers, sweep `/tmp`, check free space and memory, retry once after a sweep, else busy. */
async function prepareLaunch(slot: number, binary: string): Promise<BrowserSession["health"]> {
  // Sweeping deletes profile directories, so only when no other browser can be using one: on a serverless instance
  // with no other scan running. A local temp dir is shared with every other process of the user.
  const canSweep = () => isServerless() && busySlots.size === 1;
  await killStaleChromium(slot, binary);
  if (canSweep()) await sweepTmp();
  let health = await readHealth();
  if (isHealthy(health)) return health;
  await killStaleChromium(slot, binary);
  if (canSweep()) await sweepTmp();
  health = await readHealth();
  if (!isHealthy(health)) throw new BusyError(`Not enough resources to start a browser (tmp ${health.tmpFreeMb ?? "?"} MB, memory ${health.memAvailableMb ?? "?"} MB)`);
  return health;
}

// Per-instance semaphore (spec 7.3): one browser per scan, `maxConcurrentScans` browsers at a time.
const busySlots = new Set<number>();
const waiters: { grant(slot: number): void }[] = [];

function freeSlot(): number | undefined {
  for (let slot = 0; slot < limits.maxConcurrentScans; slot += 1) if (!busySlots.has(slot)) return slot;
  return undefined;
}

function drainQueue(): void {
  for (let slot = freeSlot(); slot !== undefined && waiters.length; slot = freeSlot()) {
    busySlots.add(slot);
    waiters.shift()?.grant(slot);
  }
}

function releaseSlot(slot: number): void {
  busySlots.delete(slot);
  drainQueue();
}

function acquireSlot(signal: AbortSignal, onQueued?: () => void): Promise<{ slot: number; queueMs: number }> {
  const slot = waiters.length ? undefined : freeSlot();
  if (slot !== undefined) {
    busySlots.add(slot);
    return Promise.resolve({ slot, queueMs: 0 });
  }
  const started = performance.now();
  onQueued?.();
  return new Promise((resolve, reject) => {
    const leave = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      const index = waiters.indexOf(waiter);
      if (index >= 0) waiters.splice(index, 1);
    };
    const waiter = {
      grant(granted: number) {
        leave();
        resolve({ slot: granted, queueMs: Math.max(1, Math.round(performance.now() - started)) });
      },
    };
    const onAbort = () => {
      leave();
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      leave();
      reject(new BusyError());
    }, limits.queueWaitMs);
    signal.addEventListener("abort", onAbort, { once: true });
    waiters.push(waiter);
  });
}

/** Rejects with the abort reason as soon as the signal aborts. A later rejection of `promise` is ignored. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  promise.catch(() => {});
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** Resolves with the result, or with undefined once `ms` have passed or the signal aborts. */
const within = <T>(promise: Promise<T>, ms: number, signal?: AbortSignal): Promise<T | undefined> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return resolve(undefined);
    const stop = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", giveUp);
    };
    const giveUp = () => {
      stop();
      resolve(undefined);
    };
    const timer = setTimeout(giveUp, ms);
    signal?.addEventListener("abort", giveUp, { once: true });
    promise.then(
      (value) => {
        stop();
        resolve(value);
      },
      (error: unknown) => {
        stop();
        reject(error);
      },
    );
  });

interface Launched {
  browser: Browser;
  pid?: number;
  pidfile: string;
  binary: string;
}

async function launch(slot: number, executable: Executable, egressPort: number): Promise<Launched> {
  const { chromium } = await import("playwright-core");
  const pidfile = pidfilePath(slot);
  await rm(pidfile, { force: true });
  const browser = await chromium.launch({
    executablePath: await writeWrapper(executable.binary),
    args: [...chromiumArgs(executable.args), pidfileMarker(pidfile)],
    headless: true,
    timeout: limits.launchMs,
    proxy: { server: `http://127.0.0.1:${egressPort}` },
    env: { ...browserEnv(), [PIDFILE_ENV]: pidfile },
  });
  return { browser, pid: await readPid(pidfile), pidfile, binary: executable.binary };
}

/**
 * Graceful close when the scan ended normally, SIGKILL otherwise or when close hangs (critic R6). A graceful close stops
 * waiting as soon as the signal aborts too, so a hung close never holds a scan past its deadline. Never rejects: a
 * cleanup step that fails (a pidfile that cannot be removed) is left to the stale-browser check of the next launch.
 */
async function shutdown({ browser, pid, pidfile, binary }: Launched, graceful: boolean, signal: AbortSignal): Promise<void> {
  const closed = graceful && (await within(browser.close().then(() => true, () => false), 5_000, signal));
  if (pid && !closed) killProcessTree(pid);
  // A close that worked waited for Chromium to exit, so a live PID now may be another process that reused it.
  if (pid && closed && isAlive(pid) && (await isOwnBrowser(pid, binary, pidfile))) killProcessTree(pid);
  if (!closed) await within(browser.close().catch(() => {}), 2_000);
  await rm(pidfile, { force: true }).catch(() => {});
  if (isServerless() && busySlots.size === 1) await sweepTmp();
}

/** Blocks media URLs (spec 7.3) in one CDP target: a page, or a frame that runs in its own process. */
async function blockMedia(context: BrowserContext, target: Page | Frame): Promise<CDPSession> {
  const cdp = await context.newCDPSession(target);
  // Small buffers: this session only blocks URLs, Playwright's own session keeps the bodies.
  await cdp.send("Network.enable", { maxTotalBufferSize: 1024, maxResourceBufferSize: 1024 });
  await cdp.send("Network.setBlockedURLs", { urls: MEDIA_URL_PATTERNS });
  return cdp;
}

/**
 * The blocklist of a CDP session covers its own target only. Frames in the process of their page share its target;
 * popups and out-of-process (cross-site) iframes get their own session as they appear. Those start a few milliseconds
 * after the target, so a request sent in that window can still go out.
 */
async function blockMediaEverywhere(context: BrowserContext, page: Page): Promise<void> {
  const frames = new WeakMap<Frame, Promise<CDPSession | undefined>>();
  const onFrame = (frame: Frame) => {
    if (!frame.parentFrame()) return;
    // A cross-site navigation moves a frame to a new target: attach again, then drop the session it had.
    const previous = frames.get(frame);
    const next = blockMedia(context, frame).catch(() => undefined); // Throws for a frame in its page's process.
    frames.set(frame, next);
    void next.then(() => previous).then((cdp) => cdp?.detach()).catch(() => {});
  };
  const pages = new WeakSet<Page>();
  const watch = (target: Page) => {
    if (pages.has(target)) return false;
    pages.add(target);
    target.on("framenavigated", onFrame);
    return true;
  };
  context.on("page", (popup) => {
    if (watch(popup)) void blockMedia(context, popup).catch(() => {});
  });
  watch(page);
  await blockMedia(context, page);
}

let launchedBefore = false;

export interface WithBrowserOptions {
  /**
   * The egress proxy every browser request goes through: its port, or a function that starts it and returns its port.
   * The function runs only once the call has its slot and passed the health gate, right before the launch (spec 7.2
   * phases 2 and 3), so a queued or refused call never holds a proxy. Its caller stops the proxy it started.
   */
  egressPort: number | (() => Promise<number>);
  /** Aborting it kills the browser. It also cuts short the graceful close that follows `fn`. */
  signal: AbortSignal;
  /** Called at once when every slot is busy and the call starts waiting. */
  onQueued?: () => void;
  /** Called when a call that waited gets its slot, before the health gate and the launch. */
  onDequeued?: (queueMs: number) => void;
}

/**
 * Runs `fn` with a fresh hardened browser behind the egress proxy (spec 7.3). One browser per call, never reused,
 * at most `limits.maxConcurrentScans` at a time; queued calls wait `limits.queueWaitMs`, then get `BusyError`.
 * Aborting the signal kills the browser and rejects with the abort reason.
 */
export async function withBrowser<T>(options: WithBrowserOptions, fn: (session: BrowserSession) => Promise<T>): Promise<T> {
  const { signal } = options;
  signal.throwIfAborted();
  const { slot, queueMs } = await acquireSlot(signal, options.onQueued);
  let launching: Promise<Launched> | undefined;
  let launched: Launched | undefined;
  let succeeded = false;
  try {
    if (queueMs > 0) options.onDequeued?.(queueMs);
    signal.throwIfAborted();
    const executable = await resolveExecutable();
    const health = await prepareLaunch(slot, executable.binary);
    signal.throwIfAborted();
    const egressPort = typeof options.egressPort === "number" ? options.egressPort : await options.egressPort();
    signal.throwIfAborted();

    const started = performance.now();
    launching = launch(slot, executable, egressPort);
    launched = await untilAborted(launching, signal);
    const launchMs = Math.max(1, Math.round(performance.now() - started));
    const cold = !launchedBefore;
    launchedBefore = true;

    const { browser } = launched;
    const setup = async () => {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 1,
        userAgent: userAgentFor(browser.version()),
        locale: "en-US",
        extraHTTPHeaders: { "accept-language": "en-US,en;q=0.9" },
        bypassCSP: true,
        serviceWorkers: "block",
        acceptDownloads: false,
        ignoreHTTPSErrors: true,
      });
      const page = await context.newPage();
      await blockMediaEverywhere(context, page);
      return { context, page };
    };
    const { context, page } = await untilAborted(setup(), signal);
    const result = await untilAborted(fn({ browser, context, page, cold, queueMs, launchMs, health, pid: launched.pid }), signal);
    succeeded = true;
    return result;
  } finally {
    if (launched) {
      try {
        await shutdown(launched, succeeded, signal);
      } finally {
        releaseSlot(slot);
      }
    } else if (launching) {
      // Aborted mid-launch: reject now, kill the browser once it is up, and keep the slot (and its pidfile) until then.
      void launching
        .then((late) => shutdown(late, false, signal))
        .catch(() => {})
        .finally(() => releaseSlot(slot));
    } else {
      releaseSlot(slot);
    }
  }
}
