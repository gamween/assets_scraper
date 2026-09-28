import { describe, expect, it, vi } from "vitest";
import { testAsset, testScan } from "@/agent/testing";
import type { ScanSource } from "@/agent/types";
import type { AssetSource } from "@/lib/contract";
import type { ProxyBytesMeter } from "@/server/security/budget";
import { TRUNCATED_NOTE, buildAssetsZip, zipMaxBytes } from "./zip";

/**
 * `buildAssetsZip` when it cannot fit the whole selection (plan Task G4.3: "stops cleanly when the budget runs out, the
 * ZIP ends with what it had plus a note in the manifest"). Nothing exercised that path: the three integration tests only
 * ever asserted `truncated === false`, so the header, the note and the `unavailable` arithmetic could all regress in
 * silence (review issue 21).
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

  it("reads AGENT_ZIP_MAX_BYTES for the per request cap", () => {
    vi.stubEnv("AGENT_ZIP_MAX_BYTES", "4096");
    expect(zipMaxBytes()).toBe(4_096);
    vi.stubEnv("AGENT_ZIP_MAX_BYTES", "not a number");
    expect(zipMaxBytes()).toBe(64 * 1024 * 1024);
    vi.unstubAllEnvs();
  });
});
