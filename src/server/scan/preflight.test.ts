import { describe, expect, it } from "vitest";
import { parseHead } from "./preflight";

const BASE = "https://www.example.com/products/page";

describe("parseHead", () => {
  it("reads the title, site name, icons, social images and manifest with absolute URLs", () => {
    const html = `<!doctype html><html><head>
      <meta charset="utf-8">
      <title>  Example &amp; Co  </title>
      <meta property="og:site_name" content="Example">
      <link rel="icon" href="/favicon.svg" type="image/svg+xml">
      <link rel='apple-touch-icon' sizes='180x180' href='touch.png'>
      <link href=/mask.svg rel=mask-icon color="#000">
      <link rel="SHORTCUT ICON" href="https://cdn.example.com/favicon.ico?v=2&amp;x=1">
      <link rel="stylesheet" href="/style.css">
      <link rel="manifest" href="/site.webmanifest">
      <meta property="og:image" content="/og.png">
      <meta content="https://cdn.example.com/og-secure.png" property="og:image:secure_url">
      <meta name="twitter:image" content="/twitter.png">
      </head><body><img src="/not-in-head.png"></body></html>`;
    expect(parseHead(html, BASE)).toEqual({
      title: "Example & Co",
      siteName: "Example",
      icons: [
        { href: "https://www.example.com/favicon.svg", rel: "icon", type: "image/svg+xml" },
        { href: "https://www.example.com/products/touch.png", rel: "apple-touch-icon", sizes: "180x180" },
        { href: "https://www.example.com/mask.svg", rel: "mask-icon" },
        { href: "https://cdn.example.com/favicon.ico?v=2&x=1", rel: "shortcut icon" },
      ],
      ogImages: ["https://www.example.com/og.png", "https://cdn.example.com/og-secure.png", "https://www.example.com/twitter.png"],
      jsonLdLogos: [],
      manifestUrl: "https://www.example.com/site.webmanifest",
    });
  });

  it("reads JSON-LD logos as strings, url objects, contentUrl objects and @graph arrays", () => {
    const html = `<head>
      <script type="application/ld+json">{"@type":"Organization","logo":"/logo-a.png"}</script>
      <script type='application/ld+json'>[{"@type":"Organization","logo":{"@type":"ImageObject","url":"https://cdn.example.com/logo-b.svg"}}]</script>
      <script type="application/ld+json">{"@graph":[{"@type":"WebSite"},{"@type":"Organization","logo":{"contentUrl":"/logo-c.png"}},{"publisher":{"logo":{"url":"/logo-d.png"}}}]}</script>
      <script type="application/ld+json">{ not json </script>
      <script type="application/ld+json">{"logo":"/logo-a.png"}</script>
    </head>`;
    expect(parseHead(html, BASE).jsonLdLogos).toEqual([
      "https://www.example.com/logo-a.png",
      "https://cdn.example.com/logo-b.svg",
      "https://www.example.com/logo-c.png",
      "https://www.example.com/logo-d.png",
    ]);
  });

  it("honors <base href>, skips unusable URLs and dedupes", () => {
    const html = `<head><base href="https://static.example.org/root/">
      <link rel="icon" href="icon.png"><link rel="icon" href="icon.png">
      <link rel="icon" href="javascript:alert(1)"><link rel="icon" href="">
      <meta property="og:image" content="data:image/png;base64,AAAA">
      <meta property="og:image" content="http://[bad">
    </head>`;
    const head = parseHead(html, BASE);
    expect(head.icons).toEqual([{ href: "https://static.example.org/root/icon.png", rel: "icon" }]);
    expect(head.ogImages).toEqual([]);
  });

  it("returns an empty head for markup without one and never throws", () => {
    expect(parseHead("", BASE)).toEqual({ icons: [], ogImages: [], jsonLdLogos: [] });
    expect(parseHead("<title>Only a title", BASE)).toEqual({ icons: [], ogImages: [], jsonLdLogos: [] });
    expect(parseHead("<title>Hi</title>", "not a url")).toEqual({ title: "Hi", icons: [], ogImages: [], jsonLdLogos: [] });
  });

  it("stays linear on hostile markup", () => {
    for (const unit of ['<meta "', "<link a=\"", "<title>", "<script>", '<script type="application/ld+json">', "&amp"]) {
      const started = performance.now();
      parseHead(unit.repeat(Math.ceil((1024 * 1024) / unit.length)), BASE);
      expect(performance.now() - started).toBeLessThan(1000);
    }
  });

  it("only reads the first megabyte", () => {
    const html = `<title>Big</title>${" ".repeat(1024 * 1024)}<link rel="icon" href="/late.png">`;
    expect(parseHead(html, BASE)).toEqual({ title: "Big", icons: [], ogImages: [], jsonLdLogos: [] });
  });
});
