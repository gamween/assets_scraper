import { describe, expect, it } from "vitest";
import { originalCandidates, variantKey } from "./cdn";
import samples from "./cdn.samples.json";

/**
 * Verified samples from the 2026-09-16 discovery lab (`cdn-verify.json`): for each, the original URL returned a valid
 * image. The Squarespace samples are left out because that rule changed after the run (`?format=original` gave a
 * smaller WebP than `?format=2500w`); it is covered by an explicit case below.
 */
describe("originalCandidates on verified samples", () => {
  it.each(samples.map((s) => [s.rule, s.url, s] as const))("%s %s", (_rule, url, sample) => {
    const hints = { pageUrl: sample.pageUrl, server: "server" in sample ? sample.server : undefined };
    expect(originalCandidates(url, hints)[0]).toBe(sample.original);
  });
});

describe("originalCandidates", () => {
  it.each([
    ["https://www.notion.com/_next/image?url=%2Ffront-static%2Fa.png&w=256&q=75", "https://www.notion.com/front-static/a.png"],
    ["https://vercel.com/vc-ap-vercel-marketing/_next/image?url=https%3A%2F%2Fassets.vercel.com%2Fimage%2Fupload%2Fx.png&w=1920&q=75", "https://assets.vercel.com/image/upload/x.png"],
    ["https://framerusercontent.com/images/abc.jpg?scale-down-to=512", "https://framerusercontent.com/images/abc.jpg"],
    ["https://cdn.prod.website-files.com/a/b-p-500.avif", "https://cdn.prod.website-files.com/a/b.avif"],
    ["https://static.wixstatic.com/media/11_abc~mv2.png/v1/fill/w_200,h_40,al_c/logo.png", "https://static.wixstatic.com/media/11_abc~mv2.png"],
    ["https://cdn.shopify.com/s/files/1/products/shoe_600x.jpg?v=12&width=600", "https://cdn.shopify.com/s/files/1/products/shoe.jpg?v=12"],
    ["https://images.unsplash.com/photo-1?ixid=abc&w=400&q=80&fit=crop", "https://images.unsplash.com/photo-1?ixid=abc"],
    ["https://cdn.sanity.io/images/p/production/id-1200x800.png?w=300&auto=format", "https://cdn.sanity.io/images/p/production/id-1200x800.png"],
    ["https://images.ctfassets.net/s/a/b/c.png?w=400&fm=avif", "https://images.ctfassets.net/s/a/b/c.png"],
  ])("%s", (input, expected) => expect(originalCandidates(input, { pageUrl: "https://site.example/" })[0]).toBe(expected));

  it.each([
    ["Vercel", "https://site.example/_vercel/image?url=%2Fimg%2Fa.jpg&w=640&q=75", "https://site.example/img/a.jpg"],
    ["Netlify", "https://site.netlify.app/.netlify/images?url=/img/a.jpg&w=300", "https://site.netlify.app/img/a.jpg"],
    ["Astro", "https://astro.build/_image?href=%2F_astro%2Fhero.abc.png&w=256&f=webp", "https://astro.build/_astro/hero.abc.png"],
    ["Nuxt IPX", "https://nuxt.com/_ipx/w_400&f_webp/images/a.png", "https://nuxt.com/_ipx/_/images/a.png"],
    ["IPX host", "https://ipx.example.com/s_200x200/images/a.png", "https://ipx.example.com/_/images/a.png"],
    ["Gatsby", "https://www.gatsbyjs.com/_gatsby/image/abc/def/hero.png?u=https%3A%2F%2Fimages.ctfassets.net%2Fs%2Fa%2Fb%2Fhero.png&a=w%3D800", "https://images.ctfassets.net/s/a/b/hero.png"],
    ["Cloudflare relative", "https://site.example/cdn-cgi/image/width=400,quality=75/uploads/a.jpg", "https://site.example/uploads/a.jpg"],
    ["Cloudflare absolute", "https://site.example/cdn-cgi/image/width=400/https://other.example/a.jpg", "https://other.example/a.jpg"],
    ["Squarespace", "https://images.squarespace-cdn.com/content/v1/abc/a.jpeg?format=500w", "https://images.squarespace-cdn.com/content/v1/abc/a.jpeg?format=2500w"],
    ["Squarespace malformed query", "https://images.squarespace-cdn.com/content/abc/image-asset.jpeg?content-type=image%2Fjpeg?format=500w", "https://images.squarespace-cdn.com/content/abc/image-asset.jpeg?format=2500w"],
    ["Cloudinary fetch", "https://res.cloudinary.com/demo/image/fetch/w_300,f_auto/https://upload.wikimedia.org/a.png", "https://upload.wikimedia.org/a.png"],
    ["Contentful by Server header", "https://images.stripeassets.com/s/a/b/c.png?w=400&q=80", "https://images.stripeassets.com/s/a/b/c.png", "Contentful Images API"],
    ["Prismic", "https://images.prismic.io/repo/a.png?auto=compress,format&w=400", "https://images.prismic.io/repo/a.png"],
    ["DatoCMS", "https://www.datocms-assets.com/1/a.png?fit=clamp&w=350", "https://www.datocms-assets.com/1/a.png"],
    ["Storyblok", "https://a.storyblok.com/f/1234/3260x1774/abc/a.jpg/m/1280x0", "https://a.storyblok.com/f/1234/3260x1774/abc/a.jpg"],
    ["Storyblok legacy", "https://img2.storyblok.com/300x200/f/1234/1000x800/abc/a.jpg", "https://a.storyblok.com/f/1234/1000x800/abc/a.jpg"],
    ["HubSpot", "https://www.hubspot.com/hs-fs/hubfs/a.png?width=200&name=a.png", "https://www.hubspot.com/hubfs/a.png"],
    ["WordPress -scaled", "https://site.example/wp-content/uploads/2024/01/big-scaled.jpg", "https://site.example/wp-content/uploads/2024/01/big.jpg"],
    ["WordPress Jetpack params", "https://techcrunch.com/wp-content/uploads/2024/01/a-1024x683.jpg?w=668", "https://techcrunch.com/wp-content/uploads/2024/01/a-1024x683.jpg"],
    ["Jetpack Photon", "https://i0.wp.com/site.example/wp-content/uploads/a.jpg", "https://site.example/wp-content/uploads/a.jpg"],
    ["Ghost", "https://ghost.org/content/images/size/w600/format/webp/2024/01/a.png", "https://ghost.org/content/images/2024/01/a.png"],
    ["ImageKit", "https://ik.imagekit.io/demo/tr:w-300,h-300/a.jpg", "https://ik.imagekit.io/demo/a.jpg"],
    ["Builder.io", "https://cdn.builder.io/api/v1/image/assets%2Fabc%2Fdef?width=218&format=webp", "https://cdn.builder.io/api/v1/image/assets%2Fabc%2Fdef"],
    ["generic base64 proxy", "https://www.binance.com/bapi/fe/resource/image?image=aHR0cHM6Ly9wdWJsaWMuYm5iLmNvbS9pbWFnZS9hLnBuZw&w=500", "https://public.bnb.com/image/a.png"],
    ["generic plain proxy", "https://proxy.example/img?src=https%3A%2F%2Fcdn.example%2Fa.png&w=50", "https://cdn.example/a.png"],
  ])("%s", (_name, input, expected, server?: string) => {
    expect(originalCandidates(input, { pageUrl: "https://site.example/", server })[0]).toBe(expected);
  });

  describe("a query built only from transform parameters", () => {
    it("drops it on a host no rule knows, with no Server hint", () => {
      // images.stripeassets.com is a Contentful custom domain: the host pattern misses it and the Server header is
      // only there for URLs the collector captured, so the whole reference scan kept these transformed.
      expect(originalCandidates("https://images.stripeassets.com/fzn2n1nzq965/24BNV3GGtvCprFLrYovyaa/b2eac20a1d5ec75e4bff3888b998d163/kettle.jpg?w=1080&q=80&fm=avif", {})[0])
        .toBe("https://images.stripeassets.com/fzn2n1nzq965/24BNV3GGtvCprFLrYovyaa/b2eac20a1d5ec75e4bff3888b998d163/kettle.jpg");
      expect(originalCandidates("https://cdn.unknown.example/a/b/photo.png?width=400&height=300&fit=cover", {})[0])
        .toBe("https://cdn.unknown.example/a/b/photo.png");
    });

    it("leaves a query that carries anything else alone", () => {
      // A version or cache-busting key names the same bytes, so stripping it buys nothing and costs a probe.
      expect(originalCandidates("https://www.notion.com/front-static/agentTop.png?v=2", {})).toEqual([]);
      // A signature, a token or an id is load-bearing.
      expect(originalCandidates("https://cdn.example/a.jpg?w=400&sig=abcdef", {})).toEqual([]);
      expect(originalCandidates("https://cdn.example/a.jpg?id=7", {})).toEqual([]);
      // The path has to name an image file: a transformer endpoint is not one.
      expect(originalCandidates("https://cdn.example/resize?w=400", {})).toEqual([]);
    });

    it("never outranks the rule that knows the host", () => {
      // Squarespace wants ?format=2500w, not a bare path, and this fallback must not win by recursing one level deeper.
      expect(originalCandidates("https://images.squarespace-cdn.com/content/v1/abc/a.jpeg?format=500w", {})[0])
        .toBe("https://images.squarespace-cdn.com/content/v1/abc/a.jpeg?format=2500w");
    });
  });

  it("lists every rewrite, most unwrapped first, and resolves relative inputs against the page", () => {
    expect(originalCandidates("https://www.gymshark.com/_next/image?url=https%3A%2F%2Fimages.ctfassets.net%2Fs%2Fa%2Fb%2Fc.png%3Fw%3D400%26fm%3Davif&w=1920&q=75", {})).toEqual([
      "https://images.ctfassets.net/s/a/b/c.png",
      "https://images.ctfassets.net/s/a/b/c.png?w=400&fm=avif",
    ]);
    expect(originalCandidates("https://gohugo.io/images/hero_hu3f9ab1c2e4a5b6c7_123456_300x0_resize_q75_box.webp", {})).toEqual([
      "https://gohugo.io/images/hero.png",
      "https://gohugo.io/images/hero.jpg",
      "https://gohugo.io/images/hero.jpeg",
      "https://gohugo.io/images/hero.webp",
    ]);
    expect(originalCandidates("/_next/image?url=%2Fa.png&w=64", { pageUrl: "https://site.example/blog/" })).toEqual(["https://site.example/a.png"]);
  });

  it("stops unwrapping at depth 3 and never loops", () => {
    let url = "https://final.example/a.png";
    for (let i = 0; i < 5; i++) url = `https://p${i}.example/_next/image?url=${encodeURIComponent(url)}&w=64`;
    expect(originalCandidates(url, {}).map((href) => new URL(href).hostname)).toEqual(["p1.example", "p2.example", "p3.example"]);
    expect(originalCandidates("https://a.example/_next/image?url=https%3A%2F%2Fa.example%2F_next%2Fimage%3Furl%3Dx", {})).toEqual([
      "https://a.example/x",
      "https://a.example/_next/image?url=x",
    ]);
  });

  it("skips signed URLs and returns nothing for plain URLs", () => {
    expect(originalCandidates("https://res.cloudinary.com/x/image/upload/s--abcdefgh--/w_300/a.jpg", { pageUrl: "https://s.example/" })).toEqual([]);
    expect(originalCandidates("https://assets.imgix.net/a.jpg?w=320&s=abcdef", { pageUrl: "https://s.example/" })).toEqual([]);
    expect(originalCandidates("https://example.com/logo.png", { pageUrl: "https://example.com/" })).toEqual([]);
  });

  it("ignores URLs that are not http(s)", () => {
    expect(originalCandidates("data:image/png;base64,AAAA", {})).toEqual([]);
    expect(originalCandidates("blob:https://a.example/1", {})).toEqual([]);
    expect(originalCandidates("https://a.example/_next/image?url=javascript%3Aalert(1)", {})).toEqual([]);
    expect(originalCandidates("::", {})).toEqual([]);
  });
});

describe("variantKey", () => {
  it("builds the same variant key for size variants", () => {
    expect(variantKey("https://www.apple.com/v/home/a/images/hero_small_2x.jpg")).toBe(variantKey("https://www.apple.com/v/home/a/images/hero_large.jpg"));
    expect(variantKey("https://a.com/x.png?w=300&q=80")).toBe(variantKey("https://a.com/x.png?w=1200"));
    expect(variantKey("https://a.com/x@2x.png")).toBe("https://a.com/x.png");
    expect(variantKey("https://site.example/_next/image?url=%2Fa.png&w=640&q=75")).toBe(variantKey("https://site.example/a.png"));
  });

  it("merges the srcset width descriptor a build pipeline bakes into the file name", () => {
    const widths = ["100w", "300w", "750w", "1500w", "2500w"].map((w) => variantKey(`https://media.example/images/services-desktop-${w}.webp`));
    expect(new Set(widths).size).toBe(1);
    expect(widths[0]).toBe("https://media.example/images/services-desktop.webp");
  });

  it("merges the size segment of an Apple Media Services thumb URL", () => {
    const sizes = ["980x522sr.jpg", "1376x736sr.jpg", "2500x1336sr.jpg"].map((s) => variantKey(`https://is1-ssl.mzstatic.com/image/thumb/x5JjmiSD75wN12-HmmZRcg/${s}`));
    expect(new Set(sizes).size).toBe(1);
    expect(sizes[0]).toBe("https://is1-ssl.mzstatic.com/image/thumb/x5JjmiSD75wN12-HmmZRcg");
    // Different assets behind the same requested size stay apart.
    expect(variantKey("https://is1-ssl.mzstatic.com/image/thumb/AAA/220x54.png")).not.toBe(variantKey("https://is1-ssl.mzstatic.com/image/thumb/BBB/220x54.png"));
  });

  it("keeps different images apart", () => {
    expect(variantKey("https://a.com/x.png")).not.toBe(variantKey("https://a.com/y.png"));
    expect(variantKey("https://a.com/x.png?id=1")).not.toBe(variantKey("https://a.com/x.png?id=2"));
    expect(variantKey("https://a.com/x.png")).not.toBe(variantKey("https://a.com/x.jpg"));
    // A numeric suffix without the srcset `w` sizes a distinct icon file, and must not merge.
    expect(variantKey("https://a.com/apple-touch-icon-180.png")).not.toBe(variantKey("https://a.com/apple-touch-icon-1024.png"));
    // One digit plus `w` is too weak a signal to treat as a width descriptor.
    expect(variantKey("https://a.com/draft-1w.png")).not.toBe(variantKey("https://a.com/draft-2w.png"));
    // The size segment rule is scoped to the CDN that defines it.
    expect(variantKey("https://a.com/image/thumb/id/220x54.png")).not.toBe(variantKey("https://a.com/image/thumb/id/440x108.png"));
  });
});
