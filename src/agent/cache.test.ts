import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cacheDir, findRecentScan, loadScan, saveScan, scanCachePath } from "./cache";
import { testScan } from "./testing";

const trees: string[] = [];
const makeTree = (): string => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-cache-")));
  trees.push(root);
  return root;
};

afterEach(() => {
  for (const tree of trees.splice(0)) fs.rmSync(tree, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("cacheDir", () => {
  it("is ~/.cache/assets-scraper, or under XDG_CACHE_HOME", () => {
    const home = makeTree();
    vi.stubEnv("HOME", home);
    vi.stubEnv("XDG_CACHE_HOME", undefined);
    expect(cacheDir()).toBe(path.join(home, ".cache", "assets-scraper"));
    const xdg = makeTree();
    vi.stubEnv("XDG_CACHE_HOME", xdg);
    expect(cacheDir()).toBe(path.join(xdg, "assets-scraper"));
  });

  it("refuses a scan id that is not a plain name", () => {
    vi.stubEnv("XDG_CACHE_HOME", makeTree());
    expect(() => scanCachePath("../../etc/passwd")).toThrow(/scan id/i);
    expect(() => scanCachePath("a/b")).toThrow(/scan id/i);
    expect(() => scanCachePath("")).toThrow(/scan id/i);
    expect(scanCachePath("stripe.com-1759000000000")).toMatch(/stripe\.com-1759000000000\.json$/);
  });
});

describe("saveScan and loadScan", () => {
  it("round-trips a scan", async () => {
    const xdg = makeTree();
    vi.stubEnv("XDG_CACHE_HOME", xdg);
    const scan = testScan();
    const file = await saveScan(scan);
    expect(file).toBe(path.join(xdg, "assets-scraper", "scan-1.json"));
    expect(fs.existsSync(file)).toBe(true);
    expect(await loadScan("scan-1")).toEqual(scan);
  });

  it("returns null for an unknown scan and for a corrupt file", async () => {
    const xdg = makeTree();
    vi.stubEnv("XDG_CACHE_HOME", xdg);
    expect(await loadScan("missing")).toBeNull();
    await saveScan(testScan());
    fs.writeFileSync(path.join(xdg, "assets-scraper", "broken.json"), "{ not json");
    expect(await loadScan("broken")).toBeNull();
    expect(await loadScan("../../etc/passwd")).toBeNull();
  });
});

describe("findRecentScan", () => {
  it("returns the newest scan of that URL inside the TTL", async () => {
    vi.stubEnv("XDG_CACHE_HOME", makeTree());
    const older = testScan({ scanId: "older", scannedAt: new Date(Date.now() - 600_000).toISOString() });
    const newer = testScan({ scanId: "newer", scannedAt: new Date(Date.now() - 60_000).toISOString() });
    const elsewhere = testScan({
      scanId: "elsewhere",
      scannedAt: new Date().toISOString(),
      page: { url: "https://vercel.com", finalUrl: "https://vercel.com/", host: "vercel.com", title: "Vercel" },
    });
    for (const scan of [older, newer, elsewhere]) await saveScan(scan);

    expect((await findRecentScan("https://stripe.com", 3_600_000))?.scanId).toBe("newer");
    expect((await findRecentScan("stripe.com", 3_600_000))?.scanId).toBe("newer");
    expect((await findRecentScan("www.stripe.com/", 3_600_000))?.scanId).toBe("newer");
    expect(await findRecentScan("stripe.com", 30_000)).toBeNull();
    expect(await findRecentScan("nowhere.example", 3_600_000)).toBeNull();
  });

  it("ignores a corrupt file rather than throwing", async () => {
    const xdg = makeTree();
    vi.stubEnv("XDG_CACHE_HOME", xdg);
    await saveScan(testScan({ scanId: "good", scannedAt: new Date().toISOString() }));
    fs.writeFileSync(path.join(xdg, "assets-scraper", "broken.json"), "{ not json");
    fs.writeFileSync(path.join(xdg, "assets-scraper", "notes.txt"), "ignored");
    expect((await findRecentScan("stripe.com", 3_600_000))?.scanId).toBe("good");
  });

  it("returns null when nothing has been cached yet", async () => {
    vi.stubEnv("XDG_CACHE_HOME", path.join(makeTree(), "not-created"));
    expect(await findRecentScan("stripe.com", 3_600_000)).toBeNull();
  });
});
