import { afterEach, describe, expect, it, vi } from "vitest";
import { AssetUnavailableError, getAssetBlob, getFontFileBlob, previewSrc } from "./asset-bytes";
import { makeAsset, makeFontFile, remoteSource } from "./testing";

afterEach(() => {
  vi.unstubAllGlobals();
});

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

describe("getAssetBlob", () => {
  it("returns inline SVG markup as an image/svg+xml blob without network", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const asset = makeAsset({ id: "svg", kind: "svg", inline: { mime: "image/svg+xml", text: "<svg xmlns='http://www.w3.org/2000/svg'/>" } });
    const blob = await getAssetBlob(asset, "original");
    expect(blob.type).toBe("image/svg+xml");
    expect(await blob.text()).toBe("<svg xmlns='http://www.w3.org/2000/svg'/>");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("decodes inline base64 bytes", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const asset = makeAsset({ id: "blob", inline: { mime: "image/png", base64: Buffer.from(png).toString("base64") } });
    const blob = await getAssetBlob(asset, "display");
    expect(blob.type).toBe("image/png");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(png);
  });

  it("tries a direct CORS fetch first for https", async () => {
    const fetchMock = vi.fn(async () => new Response(png, { headers: { "content-type": "image/png" } }));
    vi.stubGlobal("fetch", fetchMock);
    const asset = makeAsset({ id: "remote", original: remoteSource("https://cdn.test/a.png") });
    const blob = await getAssetBlob(asset, "original");
    expect(blob.size).toBe(4);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://cdn.test/a.png");
    expect(init).toMatchObject({ mode: "cors", credentials: "omit", referrerPolicy: "no-referrer" });
  });

  it("falls back to the proxy on a thrown fetch or a non-OK status", async () => {
    const source = remoteSource("https://cdn.test/a.png");
    const asset = makeAsset({ id: "remote", original: source });

    const thrown = vi.fn().mockRejectedValueOnce(new TypeError("CORS")).mockResolvedValueOnce(new Response(png));
    vi.stubGlobal("fetch", thrown);
    await getAssetBlob(asset, "original");
    expect(thrown.mock.calls.map((call) => call[0])).toEqual(["https://cdn.test/a.png", source.proxy]);

    const forbidden = vi.fn().mockResolvedValueOnce(new Response("no", { status: 403 })).mockResolvedValueOnce(new Response(png));
    vi.stubGlobal("fetch", forbidden);
    await getAssetBlob(asset, "original");
    expect(forbidden.mock.calls.map((call) => call[0])).toEqual(["https://cdn.test/a.png", source.proxy]);
  });

  it("sends http URLs straight to the proxy", async () => {
    const source = remoteSource("http://old.test/a.png");
    const fetchMock = vi.fn(async () => new Response(png));
    vi.stubGlobal("fetch", fetchMock);
    await getAssetBlob(makeAsset({ id: "http", original: source }), "original");
    expect(fetchMock.mock.calls.map((call) => (call as unknown[])[0])).toEqual([source.proxy]);
    expect(previewSrc(source)).toBe(source.proxy);
    expect(previewSrc(remoteSource("https://cdn.test/b.png"))).toBe("https://cdn.test/b.png");
  });

  it("uses the display source for display and falls back to the other source when one is missing", async () => {
    const fetchMock = vi.fn(async () => new Response(png));
    vi.stubGlobal("fetch", fetchMock);
    const asset = makeAsset({ id: "both", display: remoteSource("https://cdn.test/small.png"), original: remoteSource("https://cdn.test/large.png") });
    await getAssetBlob(asset, "display");
    await getAssetBlob(asset, "original");
    await getAssetBlob({ ...asset, display: null }, "display");
    expect(fetchMock.mock.calls.map((call) => (call as unknown[])[0])).toEqual([
      "https://cdn.test/small.png",
      "https://cdn.test/large.png",
      "https://cdn.test/large.png",
    ]);
  });

  it("throws AssetUnavailableError when the proxy fails too", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("gone", { status: 404 })));
    const asset = makeAsset({ id: "gone", original: remoteSource("https://cdn.test/gone.png") });
    await expect(getAssetBlob(asset, "original")).rejects.toBeInstanceOf(AssetUnavailableError);
    await expect(getAssetBlob(makeAsset({ id: "nothing" }), "original")).rejects.toBeInstanceOf(AssetUnavailableError);
  });

  it("fetches a source past the signing cap (proxy \"\") directly only, and marks it unavailable when that fails", async () => {
    const capped = remoteSource("https://cdn.test/capped.png", { proxy: "" });
    const ok = vi.fn(async () => new Response(png));
    vi.stubGlobal("fetch", ok);
    expect((await getAssetBlob(makeAsset({ id: "capped", original: capped }), "original")).size).toBe(4);
    expect(ok.mock.calls.map((call) => (call as unknown[])[0])).toEqual([capped.url]);

    for (const failure of [vi.fn().mockRejectedValue(new TypeError("CORS")), vi.fn(async () => new Response("no", { status: 403 }))]) {
      vi.stubGlobal("fetch", failure);
      await expect(getAssetBlob(makeAsset({ id: "capped", original: capped }), "original")).rejects.toBeInstanceOf(AssetUnavailableError);
      expect(failure.mock.calls.map((call) => (call as unknown[])[0])).toEqual([capped.url]);
    }

    // An http: source cannot load directly from the app (mixed content), so without a proxy it is unavailable at once.
    const insecure = remoteSource("http://old.test/capped.png", { proxy: "" });
    const none = vi.fn();
    vi.stubGlobal("fetch", none);
    await expect(getAssetBlob(makeAsset({ id: "insecure", original: insecure }), "original")).rejects.toBeInstanceOf(AssetUnavailableError);
    expect(none).not.toHaveBeenCalled();
    expect(previewSrc(capped)).toBe(capped.url);
  });

  it("does not fall back to the proxy once aborted", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => {
      controller.abort();
      throw new DOMException("Aborted", "AbortError");
    });
    vi.stubGlobal("fetch", fetchMock);
    const asset = makeAsset({ id: "abort", original: remoteSource("https://cdn.test/a.png") });
    await expect(getAssetBlob(asset, "original", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("getFontFileBlob", () => {
  it("decodes an inline data URI font without any fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const bytes = new Uint8Array([0x77, 0x4f, 0x46, 0x32]);
    const file = makeFontFile({ url: "", proxy: "", inline: { mime: "font/woff2", base64: Buffer.from(bytes).toString("base64") } });
    const blob = await getFontFileBlob(file);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
    expect(blob.type).toBe("font/woff2");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches a font file past the signing cap directly only, and marks it unavailable when that fails", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("CORS"));
    vi.stubGlobal("fetch", fetchMock);
    const file = makeFontFile({ url: "https://fonts.test/capped.woff2", proxy: "" });
    await expect(getFontFileBlob(file)).rejects.toBeInstanceOf(AssetUnavailableError);
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual(["https://fonts.test/capped.woff2"]);
  });

  it("fetches a remote font file through the proxy only: a direct fetch could only fail on CORS", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(png));
    vi.stubGlobal("fetch", fetchMock);
    const file = makeFontFile({ url: "https://fonts.test/inter.woff2", proxy: "/api/asset?u=aW50ZXI&e=1&s=sig" });
    await getFontFileBlob(file);
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual(["/api/asset?u=aW50ZXI&e=1&s=sig"]);
  });

  it("falls back to the direct URL for a file past the signing cap, which has no proxy path", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(png));
    vi.stubGlobal("fetch", fetchMock);
    await getFontFileBlob(makeFontFile({ url: "https://fonts.test/inter.woff2", proxy: "" }));
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual(["https://fonts.test/inter.woff2"]);
  });
});
