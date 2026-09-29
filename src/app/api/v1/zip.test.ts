import { describe, expect, it, vi } from "vitest";
import { testAsset, testScan } from "@/agent/testing";
import type { ScanSource } from "@/agent/types";
import type { AssetSource } from "@/lib/contract";
import type { ProxyBytesMeter } from "@/server/security/budget";
import { zipMaxBytes } from "./limits";
import { TRUNCATED_NOTE, UNCOMPARED_NOTE, buildAssetsZip } from "./zip";

/**
 * `buildAssetsZip` when it cannot fit the whole selection (plan Task G4.3: "stops cleanly when the budget runs out, the
 * ZIP ends with what it had plus a note in the manifest"): the note, `truncated` and the `unavailable` arithmetic, for
 * each thing that can end an archive early. The route's own test covers the header that says so.
 */

/** Four rasters of 1 KB each, all distinct, all large enough to survive the deck size gate. */
const assets = ["a", "b", "c", "d"].map((id, index) =>
  testAsset({ id, format: "png", role: "illustration", filename: `${id}.png`, width: 1200, height: 800, score: 90 - index }),
);

const scan = testScan({ assets, stats: { assets: assets.length, svg: 0, images: 4, fonts: 0, hidden: {}, durationMs: 100 } });

const sourceOf = (): ScanSource & { fetched: string[] } => {
  const fetched: string[] = [];
  return {
    kind: "local",
    fetched,
    scan: async () => scan,
    fetchBytes: async (target) => {
      const id = /\/([^/]+)\.[a-z0-9]+$/.exec((target as AssetSource).url)?.[1] ?? "";
      fetched.push(id);
      return Buffer.alloc(1_024, id.charCodeAt(0));
    },
  };
};

/** A meter that grants `budget` bytes in total and refuses everything after that, like a spent daily budget. */
const meterOf = (budget: number): ProxyBytesMeter => {
  let left = budget;
  return {
    reserve: async (bytes: number) => bytes <= left,
    take: async (bytes: number) => {
      if (bytes > left) return false;
      left -= bytes;
      return true;
    },
    settle: async () => {},
  };
};

describe("buildAssetsZip", () => {
  it("ends the archive with what it had when the request cap runs out", async () => {
    const source = sourceOf();

    const built = await buildAssetsZip(scan, source, {}, { maxBytes: 2_048, concurrency: 1, meter: meterOf(Infinity) });

    expect(built.manifest.truncated).toBe(true);
    expect(built.manifest.note).toBe(TRUNCATED_NOTE);
    expect(built.manifest.files.map((file) => file.id)).toEqual(["a", "b"]);
    expect(built.manifest.totalBytes).toBe(2_048);
    // The two it never got to are counted, so an agent can tell a partial archive from a complete one.
    expect(built.manifest.dropped.unavailable).toBe(2);
    expect(built.manifest.failed).toEqual([]);
  });

  it("ends it the same way when the daily byte budget refuses a file", async () => {
    const built = await buildAssetsZip(scan, sourceOf(), {}, { maxBytes: zipMaxBytes(), concurrency: 1, meter: meterOf(3_072) });

    expect(built.manifest.truncated).toBe(true);
    expect(built.manifest.files.map((file) => file.id)).toEqual(["a", "b", "c"]);
    expect(built.manifest.dropped.unavailable).toBe(1);
  });

  it("answers an archive holding nothing but a manifest when the budget is already spent", async () => {
    const built = await buildAssetsZip(scan, sourceOf(), {}, { maxBytes: zipMaxBytes(), concurrency: 1, meter: meterOf(0) });

    expect(built.manifest.truncated).toBe(true);
    expect(built.manifest.files).toEqual([]);
    expect(built.manifest.totalBytes).toBe(0);
    expect(built.manifest.dropped.unavailable).toBe(4);
    expect(built.manifest.note).toBe(TRUNCATED_NOTE);
  });

  /**
   * The route gives the build a deadline, so the archive goes out before the platform's limit. A fetch the deadline cut
   * short used to be listed as a failed file, and the files after it were not counted at all.
   */
  it("ends the archive at its deadline with what it fetched, and counts the fetch it cut as unavailable, not failed", async () => {
    const source = sourceOf();
    const stalling: ScanSource = {
      ...source,
      fetchBytes: (target, options = {}) =>
        (target as AssetSource).url.endsWith("/c.png")
          ? new Promise((_, reject) => options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true }))
          : source.fetchBytes(target, options),
    };

    const built = await buildAssetsZip(scan, stalling, {}, { concurrency: 1, meter: meterOf(Infinity), signal: AbortSignal.timeout(100) });

    expect(built.manifest.truncated).toBe(true);
    expect(built.manifest.files.map((file) => file.id)).toEqual(["a", "b"]);
    expect(built.manifest.failed).toEqual([]);
    expect(built.manifest.dropped.unavailable).toBe(2);
    expect(built.manifest.note).toContain(TRUNCATED_NOTE);
    expect(built.manifest.note).toMatch(/time limit/);
  });

  it("keeps every image it had no time to compare, and says so", async () => {
    const source = sourceOf();
    const deadline = new AbortController();
    // Every file is in when the time runs out, so nothing is missing: only the near duplicate pass is cut short.
    const late: ScanSource = {
      ...source,
      fetchBytes: async (target, options) => {
        const bytes = await source.fetchBytes(target, options);
        if ((target as AssetSource).url.endsWith("/d.png")) deadline.abort();
        return bytes;
      },
    };

    const built = await buildAssetsZip(scan, late, {}, { concurrency: 1, meter: meterOf(Infinity), signal: deadline.signal });

    expect(built.manifest.truncated).toBe(false);
    expect(built.manifest.files).toHaveLength(4);
    expect(built.manifest.note).toBe(UNCOMPARED_NOTE);
    expect(UNCOMPARED_NOTE).not.toMatch(/[\u2013\u2014!]/);
  });

  it("is not truncated when everything fits, and settles the meter either way", async () => {
    const settle = vi.fn(async () => {});
    const meter: ProxyBytesMeter = { ...meterOf(Infinity), settle };

    const built = await buildAssetsZip(scan, sourceOf(), {}, { maxBytes: zipMaxBytes(), meter });

    expect(built.manifest.truncated).toBe(false);
    expect(built.manifest.note).toBeUndefined();
    expect(built.manifest.files).toHaveLength(4);
    expect(built.manifest.dropped.unavailable ?? 0).toBe(0);
    expect(settle).toHaveBeenCalledTimes(1);
  });

  /**
   * The hosted archive runs the selection the CLI and the MCP tool run, so the same budget bounds it: the request cap
   * and the daily meter bound what is fetched, `selectAssets` bounds what is archived.
   */
  it("holds the archive to the byte budget and says so in the manifest", async () => {
    const source = sourceOf();

    const built = await buildAssetsZip(scan, source, { maxTotalBytes: 2_048 }, { meter: meterOf(Infinity) });

    expect(built.manifest.files.map((file) => file.id)).toEqual(["a", "b"]);
    expect(built.manifest.totalBytes).toBe(2_048);
    expect(built.manifest.truncated).toBe(false);
    expect(built.manifest.dropped["over-budget"]).toBe(2);
    expect(built.manifest.budget).toEqual({ maxTotalBytes: 2_048, maxFileBytes: 8 * 1024 * 1024, keptBytes: 2_048 });
  });

  it("drops a file over the per-file ceiling from the archive", async () => {
    const source = sourceOf();

    const built = await buildAssetsZip(scan, source, { maxFileBytes: 512 }, { meter: meterOf(Infinity) });

    expect(built.manifest.files).toEqual([]);
    expect(built.manifest.dropped["too-large"]).toBe(4);
  });
});
