import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeGoogleFetch, fakeResponse } from "../../../../tests/integration/fonts/fake-google";
import { clearGoogleFontsCache, googleFontsCssUrl, matchGoogleFamilies } from "./google";

beforeEach(() => clearGoogleFontsCache());
afterEach(() => vi.useRealTimers());

describe("matchGoogleFamilies", () => {
  it("maps each family the Google Fonts CSS API knows to its exact name", async () => {
    const fetch = fakeGoogleFetch(["Inter", "Source Sans 3"]);
    const matches = await matchGoogleFamilies(["Inter", "Brand Serif", "Source Sans 3"], { fetch });
    expect(matches).toEqual(new Map([["Inter", "Inter"], ["Source Sans 3", "Source Sans 3"]]));
    expect(fetch.calls.map((call) => call.url)).toEqual([
      "https://fonts.googleapis.com/css2?family=Inter",
      "https://fonts.googleapis.com/css2?family=Brand+Serif",
      "https://fonts.googleapis.com/css2?family=Source+Sans+3",
    ]);
    expect(fetch.calls[0].options).toMatchObject({ method: "GET", timeoutMs: 2_000 });
  });

  it("requests at most 8 unique names by default and skips names the API cannot take", async () => {
    const fetch = fakeGoogleFetch([]);
    const names = ["A1", "A1", "(unknown)", "Inter:wght@700", "Sohne; x", ...Array.from({ length: 12 }, (_, i) => `Family ${i}`)];
    await matchGoogleFamilies(names, { fetch });
    expect(fetch.calls.map((call) => new URL(call.url).searchParams.get("family"))).toEqual(["A1", ...Array.from({ length: 7 }, (_, i) => `Family ${i}`)]);

    clearGoogleFontsCache();
    const wider = fakeGoogleFetch([]);
    await matchGoogleFamilies(names, { fetch: wider, maxNames: 10 });
    expect(wider.calls).toHaveLength(10);
  });

  it("gives an empty map when the fetch throws or the API fails", async () => {
    const throwing = async () => {
      throw new Error("connect");
    };
    expect(await matchGoogleFamilies(["Inter"], { fetch: throwing })).toEqual(new Map());
    expect(await matchGoogleFamilies(["Inter"], { fetch: async (url) => fakeResponse(url, 503) })).toEqual(new Map());
  });

  it("caches answers per family for 5 minutes, but not failures", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-17T10:00:00Z"));
    const failing = vi.fn(async (url: string) => fakeResponse(url, 500));
    await matchGoogleFamilies(["Inter"], { fetch: failing });
    const fetch = fakeGoogleFetch(["Inter"]);
    expect(await matchGoogleFamilies(["Inter", "Brand Serif"], { fetch })).toEqual(new Map([["Inter", "Inter"]]));
    expect(fetch.calls).toHaveLength(2);
    vi.setSystemTime(new Date("2026-09-17T10:04:59Z"));
    expect(await matchGoogleFamilies(["Inter", "Brand Serif"], { fetch })).toEqual(new Map([["Inter", "Inter"]]));
    expect(fetch.calls).toHaveLength(2);
    vi.setSystemTime(new Date("2026-09-17T10:05:01Z"));
    await matchGoogleFamilies(["Inter", "Brand Serif"], { fetch });
    expect(fetch.calls).toHaveLength(4);
  });

  it("does not request anything once the signal is aborted", async () => {
    const fetch = fakeGoogleFetch(["Inter"]);
    expect(await matchGoogleFamilies(["Inter"], { fetch, signal: AbortSignal.abort() })).toEqual(new Map());
    expect(fetch.calls).toHaveLength(0);
  });

  it("encodes names for the css2 query", () => {
    expect(googleFontsCssUrl("M PLUS 1p")).toBe("https://fonts.googleapis.com/css2?family=M+PLUS+1p");
  });
});
