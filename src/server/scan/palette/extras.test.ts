import { describe, expect, it } from "vitest";
import type { SafeFetch, SafeFetchOptions, SafeResponse } from "../types";
import { fetchPaletteExtras, normHex, svgColors } from "./extras";

describe("normHex", () => {
  it("normalizes 3, 4, 6 and 8 digit hex, with or without #", () => {
    expect(normHex("#ABC")).toBe("#aabbcc");
    expect(normHex("#abcd")).toBe("#aabbcc");
    expect(normHex("0052FF")).toBe("#0052ff");
    expect(normHex(" #0052ff80 ")).toBe("#0052ff");
  });

  it("rejects anything else", () => {
    for (const value of ["", "#12345", "#1234567", "red", "rgb(0,0,0)", "#ggg", 12, null, undefined, {}]) expect(normHex(value)).toBeNull();
  });
});

describe("svgColors", () => {
  it("counts fill, stroke and stop colors from attributes and CSS", () => {
    const svg = `<svg><style>.a{fill:#FF0000}</style><path class="a"/><path fill="#ff0000"/><rect stroke='#0f0'/>
      <stop offset="0" stop-color="rgb(0, 0, 255)"/><circle fill="white"/><path fill="url(#g)"/><path fill="none"/></svg>`;
    const colors = new Map(svgColors(svg));
    expect([...colors.keys()].sort()).toEqual(["#0000ff", "#00ff00", "#ff0000", "#ffffff"]);
    expect(colors.get("#ff0000")).toBeCloseTo(400);
    expect(colors.get("#00ff00")).toBeCloseTo(200);
    expect([...colors.values()].reduce((a, b) => a + b, 0)).toBeCloseTo(1000);
  });

  it("drops the alpha of 4 and 8 digit hex", () => {
    expect(svgColors(`<path fill="#f00c"/><path fill="#00ff0080"/>`)).toEqual([["#ff0000", 500], ["#00ff00", 500]]);
  });

  it("treats shapes without any color as black", () => {
    expect(svgColors(`<svg><path d="M0 0h1v1z"/></svg>`)).toEqual([["#000000", 1000]]);
    expect(svgColors(`<svg><path fill="currentColor"/></svg>`)).toEqual([["#000000", 1000]]);
    expect(svgColors(`<svg></svg>`)).toEqual([]);
  });
});

const response = (url: string, status: number, type: string, body: Buffer | string): SafeResponse => {
  const bytes = Buffer.from(body);
  return {
    url,
    status,
    headers: new Headers({ "content-type": type }),
    redirected: false,
    stream: () => new Response(bytes).body!,
    buffer: async () => bytes,
    text: async () => bytes.toString("utf8"),
    json: async <T>() => JSON.parse(bytes.toString("utf8")) as T,
    cancel: async () => {},
  };
};

const PNG_BYTES = Buffer.from("89504e470d0a1a0a0000000d4948445200000001", "hex");

/** Fake SafeFetch serving a URL -> response map, recording calls. A missing URL never answers until aborted. */
const fakeFetch = (routes: Record<string, () => SafeResponse>) => {
  const calls: { url: string; options?: SafeFetchOptions }[] = [];
  const fetch: SafeFetch = (url, options) => {
    calls.push({ url, options });
    const route = routes[url];
    if (route) return Promise.resolve(route());
    return new Promise((_, reject) => options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  };
  return { fetch, calls };
};

describe("fetchPaletteExtras", () => {
  const signal = new AbortController().signal;

  it("takes the first icon that answers with image bytes and reads the manifest", async () => {
    const { fetch, calls } = fakeFetch({
      "https://a.test/404.png": () => response("https://a.test/404.png", 404, "image/png", PNG_BYTES),
      "https://a.test/page": () => response("https://a.test/page", 200, "text/html", "<!doctype html><html><body>not an icon</body></html>"),
      "https://a.test/icon.png": () => response("https://a.test/icon.png", 200, "image/png", PNG_BYTES),
      "https://a.test/site.webmanifest": () =>
        response("https://a.test/site.webmanifest", 200, "application/manifest+json", JSON.stringify({ theme_color: "#0052FF", background_color: "white" })),
    });
    const extras = await fetchPaletteExtras(
      { iconUrls: ["https://a.test/404.png", "https://a.test/page", "https://a.test/icon.png", "https://a.test/never.png"], manifestUrl: "https://a.test/site.webmanifest" },
      { fetch, signal, budgetMs: 600 },
    );
    expect(extras).toEqual({
      icon: { b64: PNG_BYTES.toString("base64"), mime: "image/png" },
      manifest: { themeColor: "#0052ff", backgroundColor: null },
    });
    expect(calls.map((c) => c.url)).not.toContain("https://a.test/never.png");
    for (const call of calls) {
      expect(call.options?.maxBytes).toBeGreaterThan(0);
      expect(call.options?.timeoutMs).toBeLessThanOrEqual(600);
      expect(call.options?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("recognizes SVG icons by type or content", async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><path fill="#0847f7" d="M0 0h1v1z"/></svg>`;
    const { fetch } = fakeFetch({ "https://a.test/icon": () => response("https://a.test/icon", 200, "application/octet-stream", svg) });
    const extras = await fetchPaletteExtras({ iconUrls: ["https://a.test/icon"], manifestUrl: null }, { fetch, signal, budgetMs: 600 });
    expect(extras).toEqual({ icon: { svg }, manifest: null });
  });

  it("returns what it has when the budget runs out and aborts pending requests", async () => {
    const { fetch, calls } = fakeFetch({
      "https://a.test/site.webmanifest": () => response("https://a.test/site.webmanifest", 200, "application/json", `{"theme_color":"#abc"}`),
    });
    const started = performance.now();
    const extras = await fetchPaletteExtras(
      { iconUrls: ["https://a.test/slow.png"], manifestUrl: "https://a.test/site.webmanifest" },
      { fetch, signal, budgetMs: 50 },
    );
    expect(performance.now() - started).toBeLessThan(500);
    expect(extras).toEqual({ icon: null, manifest: { themeColor: "#aabbcc", backgroundColor: null } });
    expect(calls.find((c) => c.url === "https://a.test/slow.png")?.options?.signal?.aborted).toBe(true);
  });

  it("stops when the scan is aborted", async () => {
    const controller = new AbortController();
    const { fetch } = fakeFetch({});
    const pending = fetchPaletteExtras({ iconUrls: ["https://a.test/slow.png"], manifestUrl: null }, { fetch, signal: controller.signal, budgetMs: 10_000 });
    controller.abort();
    await expect(pending).resolves.toEqual({ icon: null, manifest: null });
  });

  it("survives fetch errors and bad manifests", async () => {
    const fetch: SafeFetch = async (url) => {
      if (url.endsWith(".json")) return response(url, 200, "application/json", "{not json");
      throw new Error("blocked-address");
    };
    const extras = await fetchPaletteExtras({ iconUrls: ["https://a.test/a.png", "https://a.test/b.png"], manifestUrl: "https://a.test/m.json" }, { fetch, signal, budgetMs: 600 });
    expect(extras).toEqual({ icon: null, manifest: null });
  });
});
