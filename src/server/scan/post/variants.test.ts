import { describe, expect, it } from "vitest";
import { groupVariants, pickBest, sizeScore, type VariantMember } from "./variants";

type Member = VariantMember & { width?: number; height?: number; descriptorW?: number; naturalWidth?: number; naturalHeight?: number };

const member = (url: string, patch: Partial<Member> = {}): Member => ({ url, kind: "raster", groups: [], ...patch });
const urls = (groups: Member[][]) => groups.map((g) => g.map((m) => m.url.replace("https://f.example/", "")));

describe("groupVariants", () => {
  it("merges the srcset of one element and picks the largest", () => {
    const small = member("https://f.example/photo-small.png", { groups: [1, 2], preferredGroup: 1, width: 200, height: 100, naturalWidth: 200, naturalHeight: 100 });
    const large = member("https://f.example/photo-large.png", { groups: [1], preferredGroup: 1, descriptorW: 1600 });
    const groups = groupVariants([small, large]);
    expect(urls(groups)).toEqual([["photo-small.png", "photo-large.png"]]);
    expect(pickBest(groups[0]).url).toBe("https://f.example/photo-large.png");
  });

  it("does not merge an art-directed source with the fallback img", () => {
    const hero = member("https://f.example/hero.jpg", { groups: [2], artDirectedOnly: true, descriptorW: 1200 });
    const fallback = member("https://f.example/photo-small.png", { groups: [2] });
    expect(urls(groupVariants([hero, fallback]))).toEqual([["hero.jpg"], ["photo-small.png"]]);
  });

  it("merges URLs with the same bytes or the same variant key", () => {
    const a = member("https://f.example/a.png", { groups: [1], sha1: "abc" });
    const b = member("https://f.example/b.png", { groups: [2], sha1: "abc" });
    const c = member("https://f.example/c_small.png", { groups: [3], key: "https://f.example/c.png" });
    const d = member("https://f.example/c_large.png", { groups: [4], key: "https://f.example/c.png" });
    expect(urls(groupVariants([a, b, c, d]))).toEqual([["a.png", "b.png"], ["c_small.png", "c_large.png"]]);
  });

  it("splits a group that mixes raster and SVG", () => {
    const placeholder = member("https://f.example/placeholder.svg", { groups: [1], kind: "svg" });
    const photo = member("https://f.example/photo.jpg", { groups: [1], preferredGroup: 1 });
    expect(urls(groupVariants([placeholder, photo]))).toEqual([["placeholder.svg"], ["photo.jpg"]]);
  });

  it("joins a shared fallback src only to its preferred group", () => {
    const shared = member("https://f.example/fallback.png", { groups: [1, 2], preferredGroup: 2 });
    const first = member("https://f.example/first.png", { groups: [1] });
    const second = member("https://f.example/second.png", { groups: [2] });
    expect(urls(groupVariants([first, shared, second]))).toEqual([["first.png"], ["fallback.png", "second.png"]]);
    const noPreference = member("https://f.example/fallback.png", { groups: [1, 2] });
    expect(urls(groupVariants([first, noPreference, second]))).toEqual([["first.png", "fallback.png"], ["second.png"]]);
  });
});

describe("sizeScore", () => {
  it("prefers decoded size, then natural size, declared size, w and x descriptors, then bytes", () => {
    expect(sizeScore({ width: 10, height: 10, naturalWidth: 100, naturalHeight: 100 })).toBe(100);
    expect(sizeScore({ naturalWidth: 20, naturalHeight: 10 })).toBe(200);
    expect(sizeScore({ declaredWidth: 30, declaredHeight: 10 })).toBe(300);
    expect(sizeScore({ descriptorW: 100 })).toBe(6000);
    expect(sizeScore({ descriptorX: 2 })).toBe(2);
    expect(sizeScore({ bytes: 500_000 })).toBe(0.5);
    expect(sizeScore({})).toBe(0);
  });
});
