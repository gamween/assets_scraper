import { describe, expect, it } from "vitest";
import type { Diagnostics } from "@/lib/contract";
import type { StreamEvent } from "./scan-client";
import { createAppStore, getDetailList, getVisibleItems } from "./store";
import { makeAsset, makeFont } from "./testing";

const diagnostics: Diagnostics = {
  scanId: "scan-1",
  cold: false,
  phases: {},
  queueMs: 0,
  egress: { bytes: 0, blocked: 0 },
  bodyTimeouts: 0,
  collector: "isolated",
  version: "test",
};

const logo = makeAsset({ id: "logo", kind: "svg", role: "site-logo", score: 1100, order: 1 });
const illu = makeAsset({ id: "illu", kind: "svg", role: "illustration", score: 300, order: 2, renderedWidth: 400, renderedHeight: 300 });
const hero = makeAsset({ id: "hero", role: "image", score: 250, order: 3, renderedWidth: 800, renderedHeight: 600 });
const photo = makeAsset({ id: "photo", role: "image", score: 200, order: 4, renderedWidth: 600, renderedHeight: 400 });
const icon = makeAsset({ id: "icon", kind: "svg", role: "icon", score: 20, order: 5, renderedWidth: 16, renderedHeight: 16 });
const font = makeFont({ id: "inter", name: "Inter" });

function loadedStore() {
  const store = createAppStore();
  const s = store.getState();
  s.beginScan({ url: "https://linear.app/", host: "linear.app" });
  const events: StreamEvent[] = [
    { type: "accepted", scanId: "scan-1", url: "https://linear.app/" },
    { type: "assets", items: [hero, icon, logo] },
    { type: "assets", items: [photo, illu] },
    { type: "fonts", families: [font] },
    { type: "done", partial: false, stats: { assets: 5, svg: 3, images: 2, fonts: 1, hidden: {}, durationMs: 1000 }, diagnostics },
  ];
  for (const event of events) store.getState().applyEvent(event);
  return store;
}

const keys = (store: ReturnType<typeof createAppStore>) => [...store.getState().selection];

describe("app store", () => {
  it("accumulates scan events into results", () => {
    const store = loadedStore();
    const state = store.getState();
    expect(state.phase).toBe("results");
    expect(state.assets.map((a) => a.id)).toEqual(["hero", "icon", "logo", "photo", "illu"]);
    expect(getVisibleItems(state).map((item) => item.key)).toEqual(["asset:logo", "asset:illu", "asset:hero", "asset:photo", "font:inter"]);
  });

  it("replaces page info with each page event", () => {
    const store = createAppStore();
    store.getState().beginScan({ url: "https://linear.app/", host: "linear.app" });
    const page = { requestedUrl: "https://linear.app/", finalUrl: "https://linear.app/", host: "linear.app", title: "Linear", status: 200, brandLinks: [] };
    store.getState().applyEvent({ type: "page", page });
    store.getState().applyEvent({ type: "page", page: { ...page, brandLinks: [{ href: "https://linear.app/brand", text: "Brand" }] } });
    store.getState().applyEvent({ type: "page", page: { ...page, title: "Linear 2", brandLinks: [] } });
    expect(store.getState().page?.title).toBe("Linear 2");
    expect(store.getState().page?.brandLinks).toEqual([]);
  });

  it("tracks steps in order", () => {
    const store = createAppStore();
    store.getState().beginScan({ url: "https://linear.app/", host: "linear.app" });
    store.getState().applyEvent({ type: "step", step: "open", state: "start" });
    expect(store.getState().steps).toEqual({ open: "active" });
    store.getState().applyEvent({ type: "step", step: "queue", state: "start" });
    store.getState().applyEvent({ type: "step", step: "queue", state: "done" });
    store.getState().applyEvent({ type: "step", step: "load", state: "start" });
    expect(store.getState().steps).toEqual({ open: "done", queue: "done", load: "active" });
  });

  it("toggles, selects and clears", () => {
    const store = loadedStore();
    store.getState().toggle("asset:hero");
    store.getState().select("asset:logo");
    store.getState().select("asset:logo");
    expect(keys(store)).toEqual(["asset:hero", "asset:logo"]);
    store.getState().toggle("asset:hero");
    expect(keys(store)).toEqual(["asset:logo"]);
    store.getState().clearSelection();
    expect(keys(store)).toEqual([]);
  });

  it("selects a range in visual order from the last toggled item", () => {
    const store = loadedStore();
    store.getState().toggle("asset:photo");
    store.getState().selectRange("asset:illu");
    expect(new Set(keys(store))).toEqual(new Set(["asset:illu", "asset:hero", "asset:photo"]));
    // Without an anchor, a range starts at the first visible item.
    store.getState().clearSelection();
    store.getState().selectRange("asset:hero");
    expect(new Set(keys(store))).toEqual(new Set(["asset:logo", "asset:illu", "asset:hero"]));
  });

  it("selects every visible item, never collapsed sections", () => {
    const store = loadedStore();
    store.getState().selectAllVisible();
    expect(new Set(keys(store))).toEqual(new Set(["asset:logo", "asset:illu", "asset:hero", "asset:photo", "font:inter"]));
    store.getState().clearSelection();
    store.getState().toggleSection("small-icons");
    store.getState().selectAllVisible();
    expect(keys(store)).toContain("asset:icon");
  });

  it("keeps the selection across tab changes", () => {
    const store = loadedStore();
    store.getState().toggle("asset:hero");
    store.getState().setTab("svg");
    store.getState().setTab("fonts");
    expect(keys(store)).toEqual(["asset:hero"]);
    store.getState().selectAllVisible();
    expect(new Set(keys(store))).toEqual(new Set(["asset:hero", "font:inter"]));
  });

  it("opens detail and wraps next and previous within the visible list", () => {
    const store = loadedStore();
    expect(getDetailList(store.getState()).map((a) => a.id)).toEqual(["logo", "illu", "hero", "photo"]);
    store.getState().openDetail("photo");
    store.getState().nextDetail();
    expect(store.getState().detailId).toBe("logo");
    store.getState().previousDetail();
    expect(store.getState().detailId).toBe("photo");
    store.getState().setTab("svg");
    store.getState().openDetail("illu");
    store.getState().nextDetail();
    expect(store.getState().detailId).toBe("logo");
    store.getState().setQuery("hero");
    store.getState().setTab("all");
    store.getState().openDetail("hero");
    store.getState().nextDetail();
    expect(store.getState().detailId).toBe("hero");
    store.getState().closeDetail();
    expect(store.getState().detailId).toBeNull();
  });

  it("expands a collapsed section when its asset opens in detail", () => {
    const store = loadedStore();
    store.getState().openDetail("icon");
    expect(store.getState().expanded).toContain("small-icons");
    expect(getDetailList(store.getState()).map((a) => a.id)).toContain("icon");
  });

  it("shows fallback assets on a blocked error", () => {
    const store = createAppStore();
    store.getState().beginScan({ url: "https://g2.com/", host: "g2.com" });
    store.getState().failScan({ code: "blocked", message: "blocked", fallback: [makeAsset({ id: "fav", role: "favicon", foundIn: ["public-source"] })] });
    expect(store.getState().phase).toBe("error");
    expect(getVisibleItems(store.getState()).map((item) => item.key)).toEqual(["asset:fav"]);
  });
});
