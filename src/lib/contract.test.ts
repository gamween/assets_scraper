import { describe, expect, it } from "vitest";
import { ApiError, Asset, FontFamily, HiddenReason, ScanEvent, ScanRequest, ScanStats, Swatch } from "./contract";

const asset = {
  id: "a1", kind: "svg", role: "site-logo", name: "Fixture logo", filename: "fixture-logo.svg", format: "svg",
  foundIn: ["inline-svg"], visible: true, declaredOnly: false, order: 0, score: 1140, usedCount: 1,
  tone: "dark", display: null, original: null, inline: { mime: "image/svg+xml", text: "<svg/>" },
};

const blobAsset = {
  ...asset, id: "a2", kind: "image", role: "image", name: "Canvas image", filename: "fixture-canvas.png", format: "png",
  foundIn: ["img"], score: 150, width: 64, height: 64, bytes: 1_234, tone: "opaque",
  inline: { mime: "image/png", base64: "iVBORw0KGgo=" },
};

const remoteAsset = {
  ...asset, id: "a3", kind: "image", role: "social", name: "Social image", filename: "fixture-og.png", format: "png",
  foundIn: ["og-image", "public-source"], visible: false, declaredOnly: false, score: 200, tone: "unknown", inline: undefined,
  display: { url: "https://fixture.example/og.png", proxy: "/api/asset?u=x&e=1&s=y", format: "png", width: 1200, height: 630, bytes: 360_000 },
  original: { url: "https://fixture.example/og.png", proxy: "/api/asset?u=x&e=1&s=y", format: "png" },
  aspectChanged: false,
};

const family = {
  id: "f1", name: "Inter", cssFamilies: ["__Inter_d65c78"], source: "self-hosted", license: { kind: "open", text: "SIL Open Font License" },
  convertible: true, downloadable: true, googleFamily: "Inter", usedOnPage: true, usage: 0.8,
  axes: [{ tag: "wght", min: 100, max: 900, default: 400 }],
  faces: [{ weight: "100 900", style: "normal", loaded: true, files: [{ url: "https://fixture.example/inter.woff2", proxy: "/api/asset?u=x", format: "woff2", coversLatin: true }] }],
};

const diagnostics = {
  scanId: "s1", cold: true, phases: { open: 1200, collect: 800 }, queueMs: 0, tmpFreeMb: 400, memAvailableMb: 1500,
  egress: { bytes: 1_000_000, blocked: 2 }, bodyTimeouts: 1, blockReason: "http-403", collector: "isolated", version: "dev",
};

describe("contract", () => {
  it("accepts a valid asset", () => {
    expect(Asset.parse(asset).name).toBe("Fixture logo");
  });

  it("accepts inline bytes and remote sources, and narrows inline with the in operator", () => {
    const parsed = Asset.parse(blobAsset);
    expect(parsed.inline && "base64" in parsed.inline ? parsed.inline.base64 : null).toBe("iVBORw0KGgo=");
    expect(Asset.parse(remoteAsset).display?.width).toBe(1200);
    expect(() => Asset.parse({ ...blobAsset, inline: { mime: "image/png" } })).toThrow();
  });

  it("rejects an unknown role and a usedCount below 1", () => {
    expect(() => Asset.parse({ ...asset, role: "banner" })).toThrow();
    expect(() => Asset.parse({ ...asset, usedCount: 0 })).toThrow();
  });

  it("requires lowercase six-digit swatch hex", () => {
    expect(Swatch.parse({ hex: "#533afd", role: "primary" }).hex).toBe("#533afd");
    for (const hex of ["#533AFD", "#53afd", "533afd", "#533afd80"]) expect(() => Swatch.parse({ hex })).toThrow();
  });

  it("bounds font usage between 0 and 1 and checks font file formats", () => {
    expect(FontFamily.parse(family).faces[0].files[0].coversLatin).toBe(true);
    expect(FontFamily.parse({ ...family, usage: 0 }).usage).toBe(0);
    expect(FontFamily.parse({ ...family, usage: 1 }).usage).toBe(1);
    expect(() => FontFamily.parse({ ...family, usage: 1.2 })).toThrow();
    expect(() => FontFamily.parse({ ...family, usage: -0.1 })).toThrow();
    const face = family.faces[0];
    expect(() => FontFamily.parse({ ...family, faces: [{ ...face, files: [{ ...face.files[0], format: "svg" }] }] })).toThrow();
  });

  it("carries data URI font bytes inline, with no url or proxy", () => {
    const inlineFile = { url: "", proxy: "", format: "woff2", bytes: 6, coversLatin: true, inline: { mime: "font/woff2", base64: "d09GMgAB" } };
    const dataUriFamily = { ...family, source: "data-uri", faces: [{ ...family.faces[0], files: [inlineFile] }] };
    const file = FontFamily.parse(dataUriFamily).faces[0].files[0];
    expect(file.inline?.base64).toBe("d09GMgAB");
    expect([file.url, file.proxy]).toEqual(["", ""]);
    expect(FontFamily.parse(family).faces[0].files[0].inline).toBeUndefined();
    const withoutBytes = { ...inlineFile, inline: { mime: "font/woff2" } };
    expect(() => FontFamily.parse({ ...dataUriFamily, faces: [{ ...family.faces[0], files: [withoutBytes] }] })).toThrow();
  });

  it("names the noise reasons and keeps the hidden counts open", () => {
    // The reasons Track C tests for (plan C3) must all exist, so producers and the UI share one list.
    for (const reason of ["tracker", "spacer", "pixel", "tiny-data-uri", "placeholder", "not-image", "consent", "widget"]) {
      expect(HiddenReason.parse(reason)).toBe(reason);
    }
    const stats = { assets: 0, svg: 0, images: 0, fonts: 0, hidden: { tracker: 1, "future-reason": 2 }, durationMs: 1 };
    expect(ScanStats.parse(stats).hidden).toEqual({ tracker: 1, "future-reason": 2 });
  });

  it("discriminates scan events by type", () => {
    const event = ScanEvent.parse({ type: "step", step: "load", state: "start" });
    expect(event.type).toBe("step");
    expect(() => ScanEvent.parse({ type: "step", step: "nope", state: "start" })).toThrow();
  });

  it("round-trips done and error events with diagnostics and fallback", () => {
    const done = {
      type: "done", partial: true,
      stats: { assets: 3, svg: 1, images: 2, fonts: 1, hidden: { spacer: 2, tracker: 1 }, durationMs: 11_400 },
      diagnostics,
    };
    const error = { type: "error", code: "blocked", message: "Blocked", httpStatus: 403, fallback: [remoteAsset], diagnostics };
    for (const event of [done, error]) {
      const line = JSON.stringify(ScanEvent.parse(event));
      expect(ScanEvent.parse(JSON.parse(line))).toEqual(JSON.parse(JSON.stringify(event)));
    }
    expect(() => ScanEvent.parse({ ...done, diagnostics: { ...diagnostics, collector: "worker" } })).toThrow();
    expect(() => ScanEvent.parse({ ...error, code: "nope" })).toThrow();
  });

  it("validates requests and API errors", () => {
    expect(ScanRequest.parse({ url: "linear.app" }).url).toBe("linear.app");
    expect(() => ScanRequest.parse({ url: "" })).toThrow();
    expect(() => ScanRequest.parse({ url: "x".repeat(2049) })).toThrow();
    expect(ApiError.parse({ error: { code: "budget", message: "x" } }).error.code).toBe("budget");
  });
});
