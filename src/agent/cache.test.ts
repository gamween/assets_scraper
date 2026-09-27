import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cacheDir, findRecentScan, loadScan, pruneScans, saveScan, scanCachePath } from "./cache";
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

  it("ignores a file that is valid JSON but not a scan", async () => {
    // Regression: readScan checked scanId, scannedAt and assets and then cast, so a file without `page` made the whole
    // lookup reject with "Cannot read properties of undefined (reading 'url')" and broke the cache for every URL.
    const xdg = makeTree();
    vi.stubEnv("XDG_CACHE_HOME", xdg);
    await saveScan(testScan({ scanId: "good", scannedAt: new Date().toISOString() }));
    const dir = path.join(xdg, "assets-scraper");
    fs.writeFileSync(path.join(dir, "half.json"), JSON.stringify({ scanId: "half", scannedAt: new Date().toISOString(), assets: [] }));
    fs.writeFileSync(path.join(dir, "untitled.json"), JSON.stringify({ ...testScan(), page: { url: "https://stripe.com" } }));
    fs.writeFileSync(path.join(dir, "list.json"), JSON.stringify([1, 2, 3]));
    fs.writeFileSync(path.join(dir, "empty.json"), "null");
    expect((await findRecentScan("stripe.com", 3_600_000))?.scanId).toBe("good");
    expect(await loadScan("half")).toBeNull();
    expect(await loadScan("untitled")).toBeNull();
    expect(await loadScan("list")).toBeNull();
    expect(await loadScan("empty")).toBeNull();
  });

  it("ignores a file that has the shape of a scan but is missing a field a caller reads", async () => {
    // Regression: the check stopped at scanId, scannedAt, assets and page, so a file that was a scan minus stats passed
    // the load and summarize(loaded) threw "Cannot read properties of undefined (reading 'hidden')". findRecentScan
    // prefers the newest file it accepts, so that one file broke every lookup for its URL until it aged out a day later.
    const xdg = makeTree();
    vi.stubEnv("XDG_CACHE_HOME", xdg);
    const scannedAt = new Date().toISOString();
    await saveScan(testScan({ scanId: "good", scannedAt: new Date(Date.now() - 60_000).toISOString() }));
    const dir = path.join(xdg, "assets-scraper");
    const write = (name: string, scan: Record<string, unknown>): void =>
      fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(scan));
    for (const field of ["source", "stats", "warnings", "fonts", "palette"] as const) {
      const without: Record<string, unknown> = { ...testScan({ scanId: field, scannedAt }) };
      delete without[field];
      write(field, without);
    }
    write("statsless", { ...testScan({ scanId: "statsless", scannedAt }), stats: { assets: 1 } });
    write("fontless", { ...testScan({ scanId: "fontless", scannedAt }), fonts: [{ name: "Inter" }] });
    write("sourceless", { ...testScan({ scanId: "sourceless", scannedAt }), source: "elsewhere" });
    write("assetless", { ...testScan({ scanId: "assetless", scannedAt }), assets: [{ id: "a" }] });
    write("hueless", { ...testScan({ scanId: "hueless", scannedAt }), palette: { brand: [{ hex: "purple" }], neutrals: [] } });

    for (const name of ["source", "stats", "warnings", "fonts", "palette", "statsless", "fontless", "sourceless", "assetless", "hueless"]) {
      expect(await loadScan(name), name).toBeNull();
    }
    expect((await findRecentScan("stripe.com", 3_600_000))?.scanId).toBe("good");
  });

  it("keeps a field the schema does not know about", async () => {
    const xdg = makeTree();
    vi.stubEnv("XDG_CACHE_HOME", xdg);
    const scan = { ...testScan({ scanId: "extra" }), somethingNewer: { kept: true } };
    fs.mkdirSync(path.join(xdg, "assets-scraper"), { recursive: true });
    fs.writeFileSync(path.join(xdg, "assets-scraper", "extra.json"), JSON.stringify(scan));
    expect(await loadScan("extra")).toEqual(scan);
  });

  it("skips a file older than the TTL without reading it", async () => {
    const xdg = makeTree();
    vi.stubEnv("XDG_CACHE_HOME", xdg);
    await saveScan(testScan({ scanId: "stale", scannedAt: new Date().toISOString() }));
    const stale = path.join(xdg, "assets-scraper", "stale.json");
    const long = new Date(Date.now() - 7_200_000);
    fs.utimesSync(stale, long, long);
    expect(await findRecentScan("stripe.com", 3_600_000)).toBeNull();
    expect((await loadScan("stale"))?.scanId).toBe("stale");
  });

  it("returns null when nothing has been cached yet", async () => {
    vi.stubEnv("XDG_CACHE_HOME", path.join(makeTree(), "not-created"));
    expect(await findRecentScan("stripe.com", 3_600_000)).toBeNull();
  });
});

describe("pruneScans", () => {
  it("deletes the files older than the age it keeps, and nothing else", async () => {
    const xdg = makeTree();
    vi.stubEnv("XDG_CACHE_HOME", xdg);
    await saveScan(testScan({ scanId: "fresh" }));
    const dir = path.join(xdg, "assets-scraper");
    const old = path.join(dir, "old.json");
    fs.writeFileSync(old, "{}");
    fs.utimesSync(old, new Date(Date.now() - 200_000), new Date(Date.now() - 200_000));
    fs.writeFileSync(path.join(dir, "notes.txt"), "kept");

    expect(await pruneScans(100_000)).toBe(1);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(path.join(dir, "fresh.json"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "notes.txt"))).toBe(true);
  });

  it("does nothing when there is no cache", async () => {
    vi.stubEnv("XDG_CACHE_HOME", path.join(makeTree(), "not-created"));
    expect(await pruneScans()).toBe(0);
  });
});
