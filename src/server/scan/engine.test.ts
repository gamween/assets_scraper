import vm from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FIT_COLLECTOR_OUTPUT, pageContextFor, paletteCap, pageWorkMs, postProcessingWindow, safeBrandLinks, safeNoise } from "./engine";

const S = 1000;
const window = (now: number) => postProcessingWindow({ startedAt: 0, now: now * S, deadlineMs: 90 * S, verifyMs: 8 * S });

describe("pageWorkMs", () => {
  it("stops page work 5 s before the scan deadline", () => {
    expect(pageWorkMs(90 * S)).toBe(85 * S);
    expect(pageWorkMs(3 * S)).toBe(0);
  });
});

describe("paletteCap", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("aborts the palette 1 s after its budget by default", () => {
    expect(paletteCap()).toBe(4 * S);
  });

  it("moves with a raised palette budget, so extractPalette still gets its whole budget", () => {
    vi.stubEnv("PALETTE_BUDGET_MS", "5000");
    expect(paletteCap()).toBe(6 * S);
  });
});

describe("postProcessingWindow", () => {
  it("gives network work its budget, and CPU work the rest of the scan", () => {
    expect(window(30)).toEqual({ networkDeadline: 38 * S, endsAt: 90 * S });
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

describe("pageContextFor", () => {
  const base = { requestedUrl: "https://example.com/", finalUrl: "https://www.example.com/home", earlyTitle: "Early title", headSiteName: "Head Co" };
  const collected = { baseUrl: "https://www.example.com/home", elementCount: 10 };

  it("takes the collector's title and site name, trimmed", () => {
    expect(pageContextFor({ ...base, collected: { ...collected, title: "  Example  ", siteName: " Example Co " } })).toEqual({
      requestedUrl: "https://example.com/",
      finalUrl: "https://www.example.com/home",
      host: "www.example.com",
      title: "Example",
      siteName: "Example Co",
    });
  });

  it("cuts a huge title and site name to their caps without splitting a surrogate pair", () => {
    const context = pageContextFor({ ...base, collected: { ...collected, title: `${"t".repeat(2_047)}😀${"t".repeat(5_000_000)}`, siteName: "s".repeat(5_000_000) } });
    expect(context.title).toBe("t".repeat(2_047));
    expect(context.siteName).toBe("s".repeat(200));
  });

  it("falls back to the early title and the preflight site name", () => {
    expect(pageContextFor({ ...base, collected: { ...collected, title: " " } })).toMatchObject({ title: "Early title", siteName: "Head Co" });
    // A main-world page can hand over anything.
    const hostile = { ...collected, title: 42, siteName: { name: "x" } } as unknown as Parameters<typeof pageContextFor>[0]["collected"];
    expect(pageContextFor({ ...base, collected: hostile })).toMatchObject({ title: "Early title", siteName: "Head Co" });
    expect(pageContextFor({ ...base, headSiteName: undefined, collected: { ...collected, title: "" } }).siteName).toBe("");
  });
});

describe("FIT_COLLECTOR_OUTPUT", () => {
  // A context of its own, like the isolated world the code runs in.
  const fit = vm.runInNewContext(`(${FIT_COLLECTOR_OUTPUT})`) as (output: unknown, budget: number) => Output;
  type Output = { page: { title: string; siteName?: string }; candidates: { url: string; order: number }[]; svgs: { markup: string }[]; blobs: unknown[]; brandLinks: unknown[]; stats: { truncated: boolean } };
  const output = (parts: Partial<Output> = {}): Output => ({
    page: { title: "Home" },
    candidates: [],
    svgs: [],
    blobs: [],
    brandLinks: [],
    stats: { truncated: false },
    ...parts,
  });
  const dataUri = (char: string, length: number) => `data:image/png;base64,${char.repeat(length)}`;

  it("leaves output within the budget as it is, apart from cutting the title and the site name", () => {
    const small = output({ page: { title: "t".repeat(10_000), siteName: "s".repeat(1_000) }, candidates: [{ url: "https://example.com/a.png", order: 0 }] });
    const fitted = fit(small, 1_000_000);
    expect(fitted.page).toEqual({ title: "t".repeat(2_049), siteName: "s".repeat(201) });
    expect(fitted.candidates).toHaveLength(1);
    expect(fitted.stats.truncated).toBe(false);
  });

  it("drops the candidates that repeat a URL first, then the largest items, until the output fits", () => {
    const repeated = dataUri("a", 50_000);
    const candidates = [
      { url: repeated, order: 0 },
      { url: "https://example.com/logo.png", order: 1 },
      ...Array.from({ length: 499 }, (_, i) => ({ url: repeated, order: i + 2 })),
    ];
    const svgs = [{ markup: `<svg>${"x".repeat(300_000)}</svg>` }, { markup: "<svg><path/></svg>" }];
    const budget = 200_000;
    const fitted = fit(output({ candidates, svgs, brandLinks: [{ href: "https://example.com/press", text: "Press" }] }), budget);
    // One use of the repeated data URI stays; the largest SVG goes; small items stay.
    expect(fitted.candidates.map((candidate) => candidate.order)).toEqual([0, 1]);
    expect(fitted.svgs).toEqual([{ markup: "<svg><path/></svg>" }]);
    expect(fitted.brandLinks).toHaveLength(1);
    expect(fitted.stats.truncated).toBe(true);
    expect(JSON.stringify(fitted).length).toBeLessThanOrEqual(budget);
  });

  it("drops the later of equal-size items first, so page order wins", () => {
    const svgs = ["a", "b", "c"].map((char) => ({ markup: `<svg>${char.repeat(1_000)}</svg>` }));
    const whole = output({ svgs });
    const budget = JSON.stringify(whole).length - 500;
    const fitted = fit(whole, budget);
    expect(fitted.svgs.map((svg) => svg.markup[5])).toEqual(["a", "b"]);
  });

  it("drops an item that cannot be stringified instead of throwing, and keeps the rest", () => {
    // Stands for an item past V8's maximum string length, which a replaced collector can return
    const huge = { toJSON: () => { throw new RangeError("Invalid string length"); } };
    const candidates = [{ url: "https://example.com/logo.png", order: 0 }];
    const fitted = fit(output({ candidates, blobs: [huge, "small"] }), 10_000);
    expect(fitted.blobs).toEqual(["small"]);
    expect(fitted.candidates).toEqual(candidates);
    expect(fitted.stats.truncated).toBe(true);
  });

  it("never goes over a budget that the output can fit, lists that end up empty included", () => {
    const bare = JSON.stringify(output({ stats: { truncated: true } })).length;
    for (let budget = bare; budget < bare + 120; budget += 1) {
      const fitted = fit(output({ candidates: [{ url: "https://example.com/1.png", order: 0 }], svgs: [{ markup: "<svg/>" }], blobs: ["b".repeat(30)] }), budget);
      expect(JSON.stringify(fitted).length).toBeLessThanOrEqual(budget);
    }
  });
});

describe("safeNoise", () => {
  it("keeps hidden reasons with whole non-negative counts", () => {
    const noise = { "lottie-frame": 3, "unreferenced-symbol": 0, "tiny-svg": 1.5, spacer: -1, tracker: Infinity, pixel: "2", made_up: 1 };
    expect(safeNoise(noise)).toEqual({ "lottie-frame": 3, "unreferenced-symbol": 0 });
  });

  it("drops a page's made-up keys however many", () => {
    const noise = Object.fromEntries(Array.from({ length: 100_000 }, (_, i) => [`fake-${i}`, 1]));
    expect(safeNoise({ ...noise, "tiny-svg": 2 })).toEqual({ "tiny-svg": 2 });
    expect(safeNoise(null)).toEqual({});
    expect(safeNoise([1, 2])).toEqual({});
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
