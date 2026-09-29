import { describe, expect, it } from "vitest";
import { createAppStore } from "@/lib/client/store";
import { makeAsset, makeFont } from "@/lib/client/testing";
import { announcement } from "./announcer";

describe("announcement", () => {
  it("says each step a scan moves to, once, then the end of the scan", () => {
    const store = createAppStore();
    const said: string[] = [];
    store.subscribe((next, previous) => {
      const text = announcement(previous, next);
      if (text) said.push(text);
    });
    store.getState().beginScan({ url: "https://linear.app/", host: "linear.app" });
    store.getState().applyEvent({ type: "step", step: "open", state: "start" });
    store.getState().applyEvent({ type: "step", step: "load", state: "start" });
    store.getState().applyEvent({ type: "step", step: "load", state: "start" });
    store.getState().applyEvent({ type: "assets", items: [makeAsset({ id: "a" }), makeAsset({ id: "b" })] });
    store.getState().applyEvent({ type: "fonts", families: [makeFont({ id: "inter", name: "Inter" })] });
    store.getState().applyEvent({
      type: "done",
      partial: false,
      stats: { assets: 2, svg: 0, images: 2, fonts: 1, hidden: {}, durationMs: 1 },
      diagnostics: { scanId: "s", cold: false, phases: {}, queueMs: 0, egress: { bytes: 0, blocked: 0, refused: 0 }, bodyTimeouts: 0, skippedBodies: 0, collector: "isolated", version: "t" },
    });
    store.getState().select("asset:a");
    store.getState().selectAllVisible();
    store.getState().clearSelection();
    expect(said).toEqual([
      "Opening linear.app",
      "Waiting for the page to load",
      "Scan finished, 2 assets and 1 font",
      "1 selected",
      "3 selected",
      "Selection cleared",
    ]);
  });

  it("says the new page when a scan replaces one still opening", () => {
    const store = createAppStore();
    const said: string[] = [];
    store.subscribe((next, previous) => {
      const text = announcement(previous, next);
      if (text) said.push(text);
    });
    store.getState().beginScan({ url: "https://linear.app/", host: "linear.app" });
    store.getState().applyEvent({ type: "step", step: "open", state: "start" });
    // A second address typed in the top bar before the first page opened: both scans stand on the same step.
    store.getState().beginScan({ url: "https://stripe.com/", host: "stripe.com" });
    expect(said).toEqual(["Opening linear.app", "Opening stripe.com"]);
  });
});
