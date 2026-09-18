import { describe, expect, it } from "vitest";
import { makeAsset, remoteSource } from "@/lib/client/testing";
import { frameStyle } from "./asset-preview";

/**
 * The clamp is what keeps a small asset from being blown up and a tall one from being cut by the well it sits in, and
 * the percentage half of every `min()` is what makes the pixel half resolvable at all (see the comment on frameStyle).
 */
describe("frameStyle", () => {
  it("clamps an SVG to six times its own size, a raster to twice", () => {
    const svg = makeAsset({ id: "logo", kind: "svg", width: 24, height: 16 });
    expect(frameStyle(svg, "tile")).toEqual({ width: "min(76%, 144px)", height: "min(76%, 96px)" });
    expect(frameStyle(svg, "detail")).toEqual({ width: "min(82%, 144px)", height: "min(82%, 96px)" });

    const raster = makeAsset({ id: "photo", width: 100, height: 50 });
    expect(frameStyle(raster, "tile")).toEqual({ width: "min(calc(100% - 24px), 200px)", height: "min(calc(100% - 24px), 100px)" });
    expect(frameStyle(raster, "detail")).toEqual({ width: "min(calc(100% - 48px), 200px)", height: "min(calc(100% - 48px), 100px)" });
  });

  it("falls back to the well itself when a dimension is missing", () => {
    const unsized = makeAsset({ id: "unknown" });
    expect(frameStyle(unsized, "tile")).toEqual({ width: "calc(100% - 24px)", height: "calc(100% - 24px)" });
    expect(frameStyle(makeAsset({ id: "u2", kind: "svg" }), "detail")).toEqual({ width: "82%", height: "82%" });
  });

  it("measures the tile from the display copy and the detail from the original", () => {
    const asset = makeAsset({
      id: "photo",
      width: 1000,
      height: 800,
      display: remoteSource("https://cdn.test/small.png", { width: 100, height: 80 }),
      original: remoteSource("https://cdn.test/full.png", { width: 400, height: 320 }),
    });
    expect(frameStyle(asset, "tile")).toEqual({ width: "min(calc(100% - 24px), 200px)", height: "min(calc(100% - 24px), 160px)" });
    expect(frameStyle(asset, "detail")).toEqual({ width: "min(calc(100% - 48px), 800px)", height: "min(calc(100% - 48px), 640px)" });
  });
});
