import { describe, expect, it } from "vitest";
import { contentDisposition, downloadName } from "./download-name";

describe("downloadName", () => {
  it("keeps the last path segment without control, bidi, reserved characters or dot runs", () => {
    expect(downloadName("../../x.svg", "image/svg+xml")).toBe("x.svg");
    expect(downloadName("..\\Logo (dark)\u202Egvs.exe'\n.svg", "image/svg+xml")).toBe("Logo (dark)gvs.exe'.svg");
    expect(downloadName("..", "image/svg+xml")).toBe("download.svg");
    expect(downloadName(" .hidden..logo. ", "image/png")).toBe("hidden.png");
  });

  it("forces an extension that matches the served type", () => {
    expect(downloadName("Invoice.exe", "image/png")).toBe("Invoice.png");
    expect(downloadName("Invoice.png.exe", "image/png")).toBe("Invoice.png.png");
    expect(downloadName("setup.hta", "font/woff2")).toBe("setup.woff2");
    expect(downloadName("logo", "image/svg+xml")).toBe("logo.svg");
    expect(downloadName("v1.2 logo", "image/webp")).toBe("v1.2 logo.webp");
    expect(downloadName("photo.JPEG", "image/jpeg")).toBe("photo.JPEG");
    expect(downloadName("inter.ttf", "font/otf")).toBe("inter.otf");
    expect(downloadName("hero.png", "image/avif")).toBe("hero.avif");
  });

  it("keeps an image or font extension for a type it does not know, and uses .bin otherwise", () => {
    expect(downloadName("logo.svg", "image/x-unknown")).toBe("logo.svg");
    expect(downloadName("run.exe", "image/x-unknown")).toBe("run.bin");
    expect(downloadName("run", "application/x-font-unknown")).toBe("run.bin");
  });

  it("caps the name by code points, so a cut never splits a surrogate pair", () => {
    const name = downloadName(`${"a".repeat(199)}\u{1F600}.svg`, "image/svg+xml");
    expect(name).toBe(`${"a".repeat(199)}\u{1F600}.svg`);
    expect(downloadName(`${"a".repeat(199)}\u{1F600}\u{1F600}x.svg`, "image/svg+xml")).toBe(`${"a".repeat(199)}\u{1F600}.svg`);
    expect(Array.from(downloadName("b".repeat(255), "image/png"))).toHaveLength(204);
  });
});

describe("contentDisposition", () => {
  it("is inline without a name and an encoded attachment with one", () => {
    expect(contentDisposition(undefined, "image/png")).toBe("inline");
    expect(contentDisposition("Logo (dark)'!*.svg", "image/svg+xml")).toBe("attachment; filename*=UTF-8''Logo%20%28dark%29%27%21.svg");
    expect(contentDisposition(`${"a".repeat(199)}\u{1F600}.svg`, "image/svg+xml")).toBe(`attachment; filename*=UTF-8''${"a".repeat(199)}%F0%9F%98%80.svg`);
  });
});
