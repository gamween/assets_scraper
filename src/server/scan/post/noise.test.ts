import { describe, expect, it } from "vitest";
import { noiseReason, svgNoiseReason } from "./noise";

const dataUri = (mime: string, bytes: number) => `data:${mime};base64,${Buffer.alloc(bytes, 1).toString("base64")}`;

describe("noiseReason", () => {
  it("drops tracker hosts and tracking paths of tiny images", () => {
    expect(noiseReason({ url: "https://www.google-analytics.com/collect?v=1" })).toBe("tracker");
    expect(noiseReason({ url: "https://px.ads.linkedin.com/collect/?pid=1" })).toBe("tracker");
    expect(noiseReason({ url: "https://t.co/i/adsct?txn_id=1" })).toBe("tracker");
    expect(noiseReason({ url: "https://shop.example/tr?ev=1", width: 1, height: 1 })).toBe("tracker");
    expect(noiseReason({ url: "https://shop.example/pixel/abc", width: 2, height: 2 })).toBe("tracker");
    expect(noiseReason({ url: "https://shop.example/track/hero.png", width: 800, height: 400 })).toBeNull();
  });

  it("matches host lists with a path prefix only on that path", () => {
    expect(noiseReason({ url: "https://s.pinimg.com/ct/lib/main.png" })).toBe("tracker");
    expect(noiseReason({ url: "https://i.pinimg.com/736x/ab/cd/photo.jpg" })).toBeNull();
    expect(noiseReason({ url: "https://notfacebook.com/logo.png" })).toBeNull();
  });

  it("drops spacer names but not lazy-looking names", () => {
    expect(noiseReason({ url: "https://a.example/pixel.gif" })).toBe("spacer");
    expect(noiseReason({ url: "https://a.example/img/Blank.PNG" })).toBe("spacer");
    expect(noiseReason({ url: "https://a.example/blank.svg" })).toBe("spacer");
    expect(noiseReason({ url: "https://a.example/lazy.jpg" })).toBeNull();
    expect(noiseReason({ url: "https://a.example/placeholder-hero.jpg" })).toBeNull();
  });

  it("drops decoded images of 2x2 or less", () => {
    expect(noiseReason({ url: "https://a.example/x.png", width: 1, height: 1 })).toBe("pixel");
    expect(noiseReason({ url: "https://a.example/x.png", width: 2, height: 2 })).toBe("pixel");
    expect(noiseReason({ url: "https://a.example/x.png", width: 3, height: 1 })).toBeNull();
  });

  it("drops tiny raster data URIs", () => {
    expect(noiseReason({ url: dataUri("image/png", 4000), width: 40, height: 40 })).toBe("tiny-data-uri");
    expect(noiseReason({ url: dataUri("image/png", 500), width: 200, height: 200 })).toBe("tiny-data-uri");
    expect(noiseReason({ url: dataUri("image/png", 4000), bytes: 4000, width: 200, height: 100 })).toBeNull();
  });

  it("drops SVG data URI placeholders and keeps drawable ones", () => {
    const svg = (markup: string) => ({ url: `data:image/svg+xml,${encodeURIComponent(markup)}`, svgText: markup });
    expect(noiseReason(svg('<svg xmlns="http://www.w3.org/2000/svg"><defs/></svg>'))).toBe("placeholder");
    expect(noiseReason(svg('<svg><filter id="b"><feGaussianBlur stdDeviation="20"/></filter><image href="data:image/jpeg;base64,AA" filter="url(#b)"/></svg>'))).toBe("placeholder");
    expect(noiseReason(svg('<svg viewBox="0 0 2 2"><path d="M0 0h2v2z"/></svg>'))).toBeNull();
  });

  it("drops responses that are not images", () => {
    expect(noiseReason({ url: "https://a.example/logo.png", contentType: "text/html; charset=utf-8" })).toBe("not-image");
    expect(noiseReason({ url: "https://a.example/logo.png", contentType: "application/octet-stream" })).toBeNull();
    expect(noiseReason({ url: "https://a.example/logo.png", contentType: "image/png" })).toBeNull();
  });

  it("drops consent managers and third-party widgets", () => {
    expect(noiseReason({ url: "https://cdn.cookielaw.org/logos/x.png" })).toBe("consent");
    expect(noiseReason({ url: "https://www.gstatic.com/recaptcha/api2/logo_48.png" })).toBe("widget");
    expect(noiseReason({ url: "https://js.intercomcdn.com/images/x.png" })).toBe("widget");
    expect(noiseReason({ url: "https://www.gstatic.com/images/branding/logo.png" })).toBeNull();
  });

  it("drops blob URLs without bytes and odd schemes", () => {
    expect(noiseReason({ url: "blob:https://a.example/1" })).toBe("blob-unavailable");
    expect(noiseReason({ url: "blob:https://a.example/1", blobCaptured: true })).toBeNull();
    expect(noiseReason({ url: "ftp://a.example/x.png" })).toBe("not-image");
  });

  it("keeps a normal logo", () => {
    expect(noiseReason({ url: "https://linear.app/static/logo.svg", contentType: "image/svg+xml", width: 88, height: 22 })).toBeNull();
  });
});

describe("svgNoiseReason", () => {
  const svg = { markup: "<svg/>", visible: true, rect: { x: 0, y: 0, width: 24, height: 24 } };
  it("drops tiny visible SVGs and oversized markup", () => {
    expect(svgNoiseReason(svg, 1000)).toBeNull();
    expect(svgNoiseReason({ ...svg, rect: { x: 0, y: 0, width: 5, height: 4 } }, 1000)).toBe("tiny-svg");
    expect(svgNoiseReason({ ...svg, visible: false, rect: undefined }, 1000)).toBeNull();
    expect(svgNoiseReason({ ...svg, markup: "<svg>".padEnd(2000, " ") }, 1000)).toBe("svg-too-large");
  });
});
