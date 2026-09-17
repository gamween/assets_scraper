import { describe, expect, it } from "vitest";
import { pageWorkMs, postProcessingWindow, safeBrandLinks } from "./engine";

const S = 1000;
const window = (now: number) => postProcessingWindow({ startedAt: 0, now: now * S, deadlineMs: 90 * S, verifyMs: 8 * S });

describe("pageWorkMs", () => {
  it("stops page work 5 s before the scan deadline", () => {
    expect(pageWorkMs(90 * S)).toBe(85 * S);
    expect(pageWorkMs(3 * S)).toBe(0);
  });
});

describe("postProcessingWindow", () => {
  it("gives network work its budget, then 5 s of CPU work", () => {
    expect(window(30)).toEqual({ networkDeadline: 38 * S, endsAt: 43 * S });
  });

  it("cuts network work so that post-processing ends by the scan deadline", () => {
    expect(window(84)).toEqual({ networkDeadline: 85 * S, endsAt: 90 * S });
    expect(window(85)).toEqual({ networkDeadline: 85 * S, endsAt: 90 * S });
  });

  it("gives no network time to a scan whose page work reached its deadline, and never runs past the scan deadline", () => {
    expect(window(87)).toEqual({ networkDeadline: 87 * S, endsAt: 90 * S });
    expect(window(90)).toEqual({ networkDeadline: 90 * S, endsAt: 90 * S });
    expect(window(91).endsAt).toBe(90 * S);
  });
});

describe("safeBrandLinks", () => {
  it("keeps http and https links with text, at most maxBrandLinks, with their text cut", () => {
    const links = [
      { href: "javascript:alert(1)", text: "Press" },
      { href: "https://example.com/press", text: "  Press kit  " },
      { href: "https://example.com/brand", text: 42 },
      { href: `https://example.com/${"a".repeat(3000)}`, text: "Long" },
      "https://example.com/media",
      null,
      { href: "data:text/html,hi", text: "Data" },
      { href: "not a url", text: "Broken" },
      { href: "http://example.com/logos", text: `${"x".repeat(199)}😀 and more` },
      ...Array.from({ length: 10 }, (_, i) => ({ href: `https://example.com/brand/${i}`, text: `Brand ${i}` })),
    ];
    expect(safeBrandLinks(links)).toEqual([
      { href: "https://example.com/press", text: "Press kit" },
      { href: "http://example.com/logos", text: "x".repeat(199) },
      ...Array.from({ length: 4 }, (_, i) => ({ href: `https://example.com/brand/${i}`, text: `Brand ${i}` })),
    ]);
  });

  it("gives no links for output that is not a list", () => {
    expect(safeBrandLinks({ href: "https://example.com/press", text: "Press" })).toEqual([]);
    expect(safeBrandLinks(undefined)).toEqual([]);
  });
});
