import { beforeEach, describe, expect, it } from "vitest";
import { fakeGoogleFetch } from "../../../../tests/integration/fonts/fake-google";
import { clearGoogleFontsCache } from "./google";
import { isConvertibleFont } from "./index";

const signal = new AbortController().signal;

beforeEach(() => clearGoogleFontsCache());

describe("isConvertibleFont", () => {
  it("is true for an open licence without any request", async () => {
    const fetch = fakeGoogleFetch([]);
    const meta = { format: "woff2" as const, nameId1: "Brand", licenseDescription: "This Font Software is licensed under the SIL Open Font License, Version 1.1" };
    expect(await isConvertibleFont(meta, { fetch, signal })).toBe(true);
    expect(fetch.calls).toHaveLength(0);
  });

  it("checks Google Fonts when the licence is unknown", async () => {
    const fetch = fakeGoogleFetch(["Inter"]);
    expect(await isConvertibleFont({ format: "woff2", nameId1: "Inter" }, { fetch, signal })).toBe(true);
    expect(await isConvertibleFont({ format: "woff2", nameId1: "Brand Sans" }, { fetch, signal })).toBe(false);
    expect(fetch.calls).toHaveLength(2);
  });

  it("is false for a commercial licence and for unreadable files", async () => {
    const fetch = fakeGoogleFetch(["Inter"]);
    const commercial = { format: "woff2" as const, nameId1: "Inter", copyright: "Copyright 2019 Klim Type Foundry", licenseUrl: "https://klim.co.nz/licences/" };
    expect(await isConvertibleFont(commercial, { fetch, signal })).toBe(false);
    expect(await isConvertibleFont(null, { fetch, signal })).toBe(false);
    expect(await isConvertibleFont({ format: "woff2", nameId1: "." }, { fetch, signal })).toBe(false);
    expect(fetch.calls).toHaveLength(0);
  });
});
