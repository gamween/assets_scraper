import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readZip } from "../../../e2e/support/zip";
import { buildZip, zipFileName, type ZipItem } from "./zip";
import { makeAsset, makeFont, makeFontFile, remoteSource } from "./testing";

afterEach(() => {
  vi.unstubAllGlobals();
});

const text = (value: Uint8Array) => new TextDecoder().decode(value);
const interWoff2 = readFileSync(path.join(process.cwd(), "tests/fixtures/site/assets/__inter.woff2"));

const logo = makeAsset({ id: "logo", kind: "svg", role: "site-logo", filename: "linear-logo.svg", inline: { mime: "image/svg+xml", text: "<svg>logo</svg>" } });
const hero = makeAsset({ id: "hero", filename: "linear-hero.png", original: remoteSource("https://cdn.test/hero.png") });
const broken = makeAsset({ id: "broken", name: "Broken image", filename: "linear-broken.png", original: remoteSource("https://cdn.test/broken.png") });
const clash = makeAsset({ id: "clash", filename: "linear-hero.png", original: remoteSource("https://cdn.test/other.png") });

const interRegular = makeFontFile({ url: "https://static.linear.app/fonts/InterVariable.woff2", proxy: "/api/asset?u=cmVndWxhcg&e=1&s=a" });
const interItalic = makeFontFile({ url: "https://static.linear.app/fonts/InterVariable-Italic.woff2", proxy: "/api/asset?u=aXRhbGlj&e=1&s=b" });
const inter = makeFont({
  id: "inter",
  name: "Inter Variable",
  license: { kind: "open" },
  convertible: true,
  faces: [
    { weight: "100 900", style: "normal", loaded: true, files: [interRegular] },
    { weight: "100 900", style: "italic", loaded: false, files: [interItalic] },
  ],
});
const mono = makeFont({
  id: "mono",
  name: "Berkeley Mono",
  convertible: false,
  faces: [{ weight: "400", style: "normal", loaded: true, files: [makeFontFile({ url: "https://static.linear.app/fonts/Berkeley-Mono.woff2", proxy: "/api/asset?u=bW9ubw&e=1&s=c" })] }],
});
const dataUri = makeFont({
  id: "brand",
  name: "Brand Serif",
  source: "data-uri",
  license: { kind: "open" },
  convertible: true,
  faces: [{ weight: "400", style: "normal", loaded: true, files: [makeFontFile({ url: "", proxy: "", inline: { mime: "font/woff2", base64: interWoff2.toString("base64") } })] }],
});
const adobe = makeFont({ id: "adobe", name: "Proxima Nova", source: "adobe-fonts", downloadable: false });

function mockFetch() {
  const responses: Record<string, () => Response> = {
    "https://cdn.test/hero.png": () => new Response("HERO"),
    "https://cdn.test/other.png": () => new Response("OTHER"),
    [broken.original!.proxy]: () => new Response("gone", { status: 404 }),
    "https://static.linear.app/fonts/InterVariable.woff2": () => new Response("WOFF2-REGULAR"),
    "https://static.linear.app/fonts/InterVariable-Italic.woff2": () => new Response("WOFF2-ITALIC"),
    [`${interRegular.proxy}&fmt=ttf`]: () => new Response("TTF-REGULAR"),
    [`${interItalic.proxy}&fmt=ttf`]: () => new Response("TTF-ITALIC"),
    "https://static.linear.app/fonts/Berkeley-Mono.woff2": () => new Response("WOFF2-MONO"),
  };
  const fetchMock = vi.fn(async (url: string) => {
    const respond = responses[url];
    if (!respond) throw new TypeError(`Failed to fetch ${url}`);
    return respond();
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("buildZip", () => {
  it("names the archive after the host", () => {
    expect(zipFileName("linear.app")).toBe("linear.app-assets.zip");
  });

  it("lays out svg, images and fonts, adds TTFs for open remote WOFF2 fonts and reports failures", async () => {
    const fetchMock = mockFetch();
    const items: ZipItem[] = [
      { type: "asset", asset: logo },
      { type: "asset", asset: hero },
      { type: "asset", asset: broken },
      { type: "asset", asset: clash },
      { type: "font", font: inter },
      { type: "font", font: mono },
      { type: "font", font: dataUri },
      { type: "font", font: adobe },
    ];
    const progress: [number, number][] = [];
    const { response, result } = buildZip(items, "linear.app", { onProgress: (done, total) => progress.push([done, total]) });
    const entries = readZip(new Uint8Array(await response.arrayBuffer()));
    const { failed } = await result;

    expect(entries.map((entry) => entry.name)).toEqual([
      "linear.app-assets/svg/linear-logo.svg",
      "linear.app-assets/images/linear-hero.png",
      "linear.app-assets/images/linear-hero-2.png",
      "linear.app-assets/fonts/Inter Variable/inter-variable-100-900.woff2",
      "linear.app-assets/fonts/Inter Variable/inter-variable-100-900.ttf",
      "linear.app-assets/fonts/Inter Variable/inter-variable-100-900-italic.woff2",
      "linear.app-assets/fonts/Inter Variable/inter-variable-100-900-italic.ttf",
      "linear.app-assets/fonts/Berkeley Mono/berkeley-mono-400.woff2",
      "linear.app-assets/fonts/Brand Serif/brand-serif-400.woff2",
    ]);
    const byName = new Map(entries.map((entry) => [entry.name.split("/").slice(-1)[0], entry.data]));
    expect(text(byName.get("linear-logo.svg")!)).toBe("<svg>logo</svg>");
    expect(text(byName.get("linear-hero-2.png")!)).toBe("OTHER");
    expect(text(byName.get("inter-variable-100-900.ttf")!)).toBe("TTF-REGULAR");
    // Inline data-URI fonts come from their own bytes. They get no TTF: the proxy cannot fetch them and the app CSP
    // blocks the WebAssembly the in-browser converter needs.
    expect(Buffer.from(byName.get("brand-serif-400.woff2")!)).toEqual(interWoff2);

    expect(failed).toEqual([{ name: "Broken image", path: "linear.app-assets/images/linear-broken.png" }]);
    expect(progress.at(-1)).toEqual([10, 10]);
    expect(fetchMock.mock.calls.some((call) => String(call[0]).startsWith("https://static.linear.app/fonts/Berkeley") && String(call[0]).includes("fmt"))).toBe(false);
  });

  it("stops fetching when aborted", async () => {
    const fetchMock = mockFetch();
    const controller = new AbortController();
    controller.abort();
    const { response, result } = buildZip([{ type: "asset", asset: hero }], "linear.app", { signal: controller.signal });
    await expect(response.arrayBuffer()).rejects.toThrow();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
