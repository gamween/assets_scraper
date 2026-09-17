import { describe, expect, it } from "vitest";
import { makeAsset, remoteSource } from "@/lib/client/testing";
import { assetMeta, foundInLabel, hiddenSummary, roleBadge, roleLabel, splitExtension } from "./labels";

describe("hiddenSummary", () => {
  it("names the reasons by count", () => {
    expect(hiddenSummary({ tracker: 6, spacer: 3 })).toBe("9 hidden: tracking pixels and spacer images");
    expect(hiddenSummary({ spacer: 1, tracker: 2, pixel: 5 })).toBe("8 hidden: tracking pixels and spacer images");
    expect(hiddenSummary({ consent: 1, tracker: 4, "tiny-svg": 2 })).toBe("7 hidden: tracking pixels, tiny SVGs and consent banners");
  });

  it("counts unknown reasons toward the total", () => {
    expect(hiddenSummary({ tracker: 2, "future-reason": 3 })).toBe("5 hidden: tracking pixels and other files");
    expect(hiddenSummary({ "future-reason": 3 })).toBe("3 hidden: other files");
  });

  it("returns nothing when nothing was hidden", () => {
    expect(hiddenSummary({})).toBeNull();
    expect(hiddenSummary({ tracker: 0 })).toBeNull();
  });
});

describe("card labels", () => {
  it("builds the mono meta line", () => {
    const svg = makeAsset({ id: "logo", kind: "svg", width: 88, height: 22, bytes: 3072, inline: { mime: "image/svg+xml", text: "<svg/>" } });
    expect(assetMeta(svg)).toBe("SVG · 88×22 · 3.0 KB · Inline");
    const file = makeAsset({ id: "file", kind: "svg", original: remoteSource("https://cdn.test/logo.svg", { format: "svg", bytes: 512 }) });
    expect(assetMeta(file)).toBe("SVG · 512 B · File");
    const og = makeAsset({ id: "og", format: "jpg", original: remoteSource("https://cdn.test/og.jpg", { format: "jpg", width: 1200, height: 630, bytes: 360_000 }) });
    expect(assetMeta(og)).toBe("JPG · 1200×630 · 352 KB");
  });

  it("labels every role in the detail view and only notable roles on cards", () => {
    const roles = ["site-logo", "logo", "favicon", "social", "icon", "illustration", "image", "sprite-symbol"] as const;
    expect(roles.map((role) => roleLabel({ role }))).toEqual(["Site logo", "Logo", "Favicon", "OG image", "Icon", "Illustration", "Image", "Sprite symbol"]);
    expect(roles.map((role) => roleBadge(makeAsset({ id: role, role })))).toEqual(["Logo", "Logo", "Favicon", "OG image", null, null, null, null]);
  });

  it("names where an asset was found, meta icons as a meta tag", () => {
    expect(foundInLabel(["icon-link", "meta-icon"])).toBe('<link rel="icon">, Meta tag');
  });

  it("keeps the extension apart for middle truncation", () => {
    expect(splitExtension("linear-homepage-og.jpg")).toEqual(["linear-homepage-og", ".jpg"]);
    expect(splitExtension("README")).toEqual(["README", ""]);
  });
});
