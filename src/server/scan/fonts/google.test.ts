import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearGoogleFontsCache, familySpellings, googleFontsCacheSize, googleFontsCssUrl, matchGoogleFamilies } from "./google";
import { fakeGoogleFetch, fakeResponse } from "./testing";

beforeEach(() => clearGoogleFontsCache());
afterEach(() => vi.useRealTimers());

describe("familySpellings", () => {
  it("splits camel case and separators into the catalogue spelling", () => {
    for (const declared of ["SourceCodePro", "Source_Code_Pro", "source-code-pro", "source code pro"]) {
      expect(familySpellings(declared), declared).toContain("Source Code Pro");
    }
    expect(familySpellings("SFProText")).toContain("SF Pro Text");
    // A name already spelled the catalogue way is asked about once.
    expect(familySpellings("Source Code Pro")).toEqual(["Source Code Pro"]);
    expect(familySpellings("Inter:wght@700")).toEqual([]);
  });
});

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

  it("finds a family declared without its spaces, and reports the catalogue spelling", async () => {
    const fetch = fakeGoogleFetch(["Source Code Pro"]);
    const matches = await matchGoogleFamilies(["SourceCodePro"], { fetch });
    expect(matches).toEqual(new Map([["SourceCodePro", "Source Code Pro"]]));
    expect(fetch.calls.map((call) => new URL(call.url).searchParams.get("family"))).toEqual(["SourceCodePro", "Source Code Pro"]);
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

  it("keeps at most 1,000 answers, dropping expired ones first and then the oldest", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-17T10:00:00Z"));
    const names = (from: number, count: number) => Array.from({ length: count }, (_, index) => `Family ${from + index}`);
    const fetch = fakeGoogleFetch([]);
    await matchGoogleFamilies(names(0, 600), { fetch, maxNames: 600 });
    vi.setSystemTime(new Date("2026-09-17T10:04:00Z"));
    await matchGoogleFamilies(names(600, 300), { fetch, maxNames: 300 });
    expect(googleFontsCacheSize()).toBe(900);

    // The first 600 expire at 10:05, so writing after that drops them all
    vi.setSystemTime(new Date("2026-09-17T10:05:01Z"));
    await matchGoogleFamilies(names(900, 1), { fetch });
    expect(googleFontsCacheSize()).toBe(301);

    // Full of live answers, the oldest ones go
    await matchGoogleFamilies(names(901, 1_000), { fetch, maxNames: 1_000 });
    expect(googleFontsCacheSize()).toBe(1_000);
    fetch.calls.length = 0;
    await matchGoogleFamilies(["Family 600", "Family 1900"], { fetch });
    expect(fetch.calls.map((call) => new URL(call.url).searchParams.get("family"))).toEqual(["Family 600"]);
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
