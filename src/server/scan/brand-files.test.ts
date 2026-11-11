import { afterEach, describe, expect, it, vi } from "vitest";
import type { SafeFetch, SafeResponse } from "./types";
import { brandFilesFrom, isBrandPage, probeBrandFiles, quotedFilePaths, sameSite, withoutAssets } from "./brand-files";

describe("quotedFilePaths", () => {
  it("reads the downloads a brand page's code starts on a click, as monad.xyz's bundle quotes them", () => {
    // Cut from monad.xyz's chunk: the kit button builds an <a> on click, so no link on the page carries the URL.
    const chunk =
      'let eB=["/brand-page-assets/Logomark.svg","/brand-page-assets/Wordmark.svg"],eP=["/brand-page-assets/Full.png"];' +
      'onClick:()=>{let e=document.createElement("a");e.href="/brand-page-assets/Monad Brand and Media Kit.zip",' +
      'e.download="Monad Brand and Media Kit.zip",document.body.appendChild(e),e.click()},src:`https://cdn.example/press/kit.pdf?v=2`,' +
      "x:'/socials/discord.svg',y:\"/not a file.zip.js\",z:\"/broken\\\".zip\"";
    expect(quotedFilePaths(chunk)).toEqual([
      "/brand-page-assets/Logomark.svg",
      "/brand-page-assets/Wordmark.svg",
      "/brand-page-assets/Full.png",
      "/brand-page-assets/Monad Brand and Media Kit.zip",
      "https://cdn.example/press/kit.pdf",
      "/socials/discord.svg",
    ]);
  });

  it("stops at the number it was asked for, and never crosses a quote, a line or a space in a URL", () => {
    const many = Array.from({ length: 50 }, (_, index) => `"/brand/${index}.svg"`).join(",");
    expect(quotedFilePaths(many, 3)).toEqual(["/brand/0.svg", "/brand/1.svg", "/brand/2.svg"]);
    expect(quotedFilePaths(many, 0)).toEqual([]);
    expect(quotedFilePaths('"/brand/one\nkit.zip" "https://x.com/a b.zip" "/brand/kit.zip\'')).toEqual([]);
  });
});

describe("isBrandPage and sameSite", () => {
  it("names a page a brand page by a segment of its path", () => {
    expect(isBrandPage("https://monad.xyz/brand-and-media-kit")).toBe(true);
    expect(isBrandPage("https://token2049.com/dubai/brand-kit")).toBe(true);
    expect(isBrandPage("https://trezor.io/press-and-media")).toBe(true);
    expect(isBrandPage("https://monad.xyz/")).toBe(false);
    expect(isBrandPage("https://stripe.com/pricing?ref=brand")).toBe(false);
    expect(isBrandPage("not a url")).toBe(false);
  });

  it("tells a page's own scripts from another site's", () => {
    expect(sameSite("https://monad.xyz/_next/static/chunks/a.js", "https://www.monad.xyz/brand-and-media-kit")).toBe(true);
    expect(sameSite("https://www.googletagmanager.com/gtm.js", "https://monad.xyz/brand-and-media-kit")).toBe(false);
    expect(sameSite("nope", "https://monad.xyz/")).toBe(false);
  });
});

describe("brandFilesFrom", () => {
  it("names stellar.org's files from the better of two links, the heading over a hashed PDF, never a hash", () => {
    const sanity = "https://cdn.sanity.io/files/e2r40yh6/production-i18n";
    const files = brandFilesFrom({
      pageUrl: "https://stellar.org/brand-resources",
      links: [
        { href: `${sanity}/c155385509c73b245ff4f752ade94048a06245bc.pdf`, text: "Download", label: "Download", caption: "Discover the brand guide" },
        { href: `${sanity}/9ef5ab890833c2571489b41a23a0ffc29307300c.zip`, text: "", label: "Stellar logo pack" },
        { href: `${sanity}/9ef5ab890833c2571489b41a23a0ffc29307300c.zip`, text: "View" },
        { href: `${sanity}/a67dbd8d337a9570b51623e09616ad816a0c0bd3.zip#top`, text: "View" },
      ],
    });
    expect(files.map(({ name, type, foundIn }) => ({ name, type, foundIn }))).toEqual([
      { name: "Discover the brand guide", type: "pdf", foundIn: "link" },
      { name: "Stellar logo pack", type: "zip", foundIn: "link" },
      { name: "ZIP file", type: "zip", foundIn: "link" },
    ]);
    expect(files[2].url).toBe(`${sanity}/a67dbd8d337a9570b51623e09616ad816a0c0bd3.zip`);
    expect(files.every((file) => /^[0-9a-f]{12}$/.test(file.id))).toBe(true);
  });

  it("names arbitrum.io's and token2049.com's archives from their file names when the button says only download", () => {
    const files = brandFilesFrom({
      pageUrl: "https://arbitrum.io/brand-kit",
      links: [
        { href: "/brandkit/downloads/1225_Arbitrum_Logo_all.zip", text: "Download All Arbitrum Logo Variations" },
        { href: "/brandkit/downloads/1225_Arbitrum_Logo_FullColorNavy.zip", text: "DOWNLOAD PNG + SVG" },
        { href: "https://token2049.nyc3.cdn.digitaloceanspaces.com/Dubai/Brandkit/TOKEN2049%20LOGOS%20-%20Primary%20-%202027.zip", text: "" },
        { href: "/press/kit", text: "Press kit", download: "Acme_Press-Kit.pdf" },
      ],
    });
    expect(files.map((file) => file.name)).toEqual(["Download All Arbitrum Logo Variations", "1225 Arbitrum Logo FullColorNavy", "TOKEN2049 LOGOS Primary 2027", "Press kit"]);
    expect(files.map((file) => file.url)).toContain("https://arbitrum.io/brandkit/downloads/1225_Arbitrum_Logo_all.zip");
    // A link with no file extension is a file when its `download` attribute names one.
    expect(files[3]).toMatchObject({ url: "https://arbitrum.io/press/kit", type: "pdf" });
  });

  it("keeps the files a brand page's code names in a brand folder, and none of the rest of the site's bundle", () => {
    const files = brandFilesFrom({
      pageUrl: "https://monad.xyz/brand-and-media-kit",
      links: [],
      scriptFiles: [
        "/brand-page-assets/Monad Brand and Media Kit.zip",
        "/brand-page-assets/Logomark.svg",
        "/brand-page-assets/Wordmark.png",
        "/developers/eips-for-designers/eips-logo.png",
        "/socials/discord.svg",
        "/legal/privacy.pdf",
        "/press/2026-annual-report.pdf",
        "javascript:alert(1).zip",
      ],
    });
    expect(files.map(({ url, name, type, foundIn }) => ({ url, name, type, foundIn }))).toEqual([
      { url: "https://monad.xyz/brand-page-assets/Monad%20Brand%20and%20Media%20Kit.zip", name: "Monad Brand and Media Kit", type: "zip", foundIn: "script" },
      { url: "https://monad.xyz/brand-page-assets/Logomark.svg", name: "Logomark", type: "svg", foundIn: "script" },
      { url: "https://monad.xyz/brand-page-assets/Wordmark.png", name: "Wordmark", type: "png", foundIn: "script" },
      { url: "https://monad.xyz/press/2026-annual-report.pdf", name: "2026 annual report", type: "pdf", foundIn: "script" },
    ]);
  });

  it("leaves out a picture the scan already holds as an asset, a link it already has, and caps the list", () => {
    const links = Array.from({ length: 40 }, (_, index) => ({ href: `https://x.com/brand/logo-${index}.svg`, text: `Logo ${index}` }));
    const files = brandFilesFrom({
      pageUrl: "https://x.com/brand",
      links: [{ href: "https://x.com/brand/kit.zip", text: "Kit" }, ...links],
      scriptFiles: ["/brand/kit.zip"],
      known: (url) => url === "https://x.com/brand/logo-0.svg" || url === "https://x.com/brand/kit.zip",
    });
    expect(files).toHaveLength(16);
    expect(files[0]).toMatchObject({ name: "Kit", type: "zip", foundIn: "link" });
    expect(files.map((file) => file.url)).not.toContain("https://x.com/brand/logo-0.svg");
  });

  it("ignores what a replaced collector could hand over: wrong shapes, other schemes, long URLs, no extension", () => {
    const files = brandFilesFrom({
      pageUrl: "https://x.com/brand",
      links: [null, "kit.zip", { href: 7, text: "" }, { href: "data:application/zip;base64,AA==", text: "" }, { href: `https://x.com/${"a".repeat(3_000)}.zip`, text: "" }, { href: "https://x.com/brand", text: "Brand" }],
      scriptFiles: [7 as unknown as string],
    });
    expect(files).toEqual([]);
    expect(brandFilesFrom({ pageUrl: "https://x.com/", links: { href: "https://x.com/kit.zip" } })).toEqual([]);
  });
});

describe("withoutAssets", () => {
  it("drops only the pictures the final asset list holds", () => {
    const files = brandFilesFrom({ pageUrl: "https://x.com/brand", links: [{ href: "/brand/logo.svg", text: "Logo" }, { href: "/brand/kit.zip", text: "Kit" }] });
    expect(withoutAssets(files, new Set(["https://x.com/brand/logo.svg", "https://x.com/brand/kit.zip"])).map((file) => file.name)).toEqual(["Kit"]);
  });
});

describe("probeBrandFiles", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const response = (status: number, headers: Record<string, string>): SafeResponse =>
    ({ status, headers: new Headers(headers), cancel: async () => {} }) as unknown as SafeResponse;

  it("reads the size from a range answer or a whole one, and keeps none for a challenge page, an error or a refusal", async () => {
    const answers: Record<string, () => SafeResponse> = {
      "https://x.com/brand/a.zip": () => response(206, { "content-range": "bytes 0-0/29679666", "content-type": "application/zip" }),
      "https://x.com/brand/b.pdf": () => response(200, { "content-length": "6311412", "content-type": "application/pdf" }),
      "https://x.com/brand/c.zip": () => response(403, { "content-type": "text/html", "content-length": "5825" }),
      "https://x.com/brand/d.zip": () => response(200, { "content-type": "text/html; charset=UTF-8", "content-length": "5825" }),
      "https://x.com/brand/e.zip": () => response(200, { "content-length": "100", "content-encoding": "gzip" }),
    };
    const requests: { url: string; range?: string; agent?: string; referer?: string }[] = [];
    const fetch = (async (url: string, options) => {
      requests.push({ url, range: options?.headers?.range, agent: options?.headers?.["user-agent"], referer: options?.headers?.referer });
      const answer = answers[url];
      if (!answer) throw new Error("connect");
      return answer();
    }) as SafeFetch;
    const files = brandFilesFrom({ pageUrl: "https://x.com/brand", links: ["a.zip", "b.pdf", "c.zip", "d.zip", "e.zip", "f.zip"].map((name) => ({ href: `/brand/${name}`, text: "" })) });
    const probed = await probeBrandFiles(files, { fetch, referer: "https://x.com/brand", signal: new AbortController().signal, deadline: Date.now() + 10_000 });
    expect(probed.map((file) => file.bytes)).toEqual([29_679_666, 6_311_412, undefined, undefined, undefined, undefined]);
    // Asked the way the scan's browser asked: the first byte, a browser's user agent, the page as the referrer.
    expect(requests.every((request) => request.range === "bytes=0-0" && /Chrome\/\d/.test(request.agent ?? "") && request.referer === "https://x.com/brand")).toBe(true);
    expect(files.every((file) => file.bytes === undefined)).toBe(true);
  });

  it("starts no probe past the deadline", async () => {
    const fetch = vi.fn<SafeFetch>();
    const files = brandFilesFrom({ pageUrl: "https://x.com/brand", links: [{ href: "/brand/a.zip", text: "" }] });
    expect(await probeBrandFiles(files, { fetch, referer: "https://x.com/brand", signal: new AbortController().signal, deadline: Date.now() - 1 })).toEqual(files);
    expect(fetch).not.toHaveBeenCalled();
  });
});
