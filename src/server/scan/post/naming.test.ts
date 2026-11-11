import { describe, expect, it } from "vitest";
import { cleanBasename, createFilenamer, displayName, fileName, hrefName, markupName, type NameInput } from "./naming";

const name = (patch: Partial<NameInput>) => displayName({ kind: "image", role: "image", index: 12, siteName: "Linear", ...patch });

describe("displayName", () => {
  it("uses the first usable source", () => {
    expect(name({ label: "Linear home", linkText: "Home", url: "https://linear.app/logo.svg" })).toBe("Linear home");
    expect(name({ label: "  ", linkText: "Read the story", url: "https://linear.app/hero.png" })).toBe("Read the story");
    expect(name({ url: "https://linear.app/static/hero-image.png" })).toBe("hero-image");
    expect(name({ kind: "svg" })).toBe("svg 12");
    expect(name({})).toBe("image 12");
  });

  it("names logos, favicons and social images after the site when nothing better exists", () => {
    expect(name({ role: "site-logo", jsonLdLogo: true, url: "https://linear.app/x.png" })).toBe("Linear logo");
    expect(name({ role: "site-logo", url: "https://linear.app/brand.svg" })).toBe("Linear logo");
    expect(name({ role: "favicon", url: "https://linear.app/favicon.ico" })).toBe("Linear favicon");
    expect(name({ role: "social", linkText: "x", url: "https://linear.app/og.png" })).toBe("Linear social image");
    expect(name({ role: "site-logo", label: "Linear wordmark" })).toBe("Linear wordmark");
    expect(name({ role: "logo", linkText: "Customer", url: "https://linear.app/c.svg" })).toBe("Customer");
  });

  it("collapses whitespace, strips control characters and caps long labels", () => {
    expect(name({ label: "Acme\n\t  Corp\u0000" })).toBe("Acme Corp");
    expect(name({ label: "https://cdn.example/a.png", url: "https://cdn.example/a.png" })).toBe("a");
    const long = name({ label: "word ".repeat(40) });
    expect(long.length).toBeLessThanOrEqual(80);
    expect(long.endsWith(" ")).toBe(false);
  });
});

describe("displayName last-resort hints", () => {
  // stripe.com: the inline logos of the testimonial carousel and of the payment graphics carry no label of their own,
  // so v1 called them "svg 121" to "svg 124". Each rule below is one place a real name was sitting.
  it("takes a short ancestor label before anything else", () => {
    expect(name({ kind: "svg", hints: { ancestorLabel: "Show the Substack testimonial" } })).toBe("Show the Substack testimonial");
    // The label of the element still wins, and so does the text of its link.
    expect(name({ kind: "svg", label: "Substack", hints: { ancestorLabel: "Show the Substack testimonial" } })).toBe("Substack");
    expect(name({ kind: "svg", linkText: "Substack", hints: { ancestorLabel: "Show the Substack testimonial" } })).toBe("Substack");
    // A file name of its own is more specific than the region around it, so a raster keeps it.
    expect(name({ url: "https://stripe.com/img/hertz-story.png", hints: { ancestorLabel: "Customers" } })).toBe("hertz-story");
  });

  it("names a logo after the customer page its link points at", () => {
    expect(name({ kind: "svg", hints: { linkHref: "https://stripe.com/customers/hertz" } })).toBe("hertz");
    expect(name({ kind: "svg", hints: { linkHref: "https://stripe.com/fr-fr/customers/le-monde/" } })).toBe("le monde");
    // A locale or a container names nothing, and a link to the section itself names every logo on the wall the same
    // way, so linear.app's whole customer wall pointing at /customers keeps the generic name instead.
    expect(name({ kind: "svg", hints: { linkHref: "https://stripe.com/customers/en-gb" } })).toBe("svg 12");
    expect(name({ kind: "svg", hints: { linkHref: "https://linear.app/customers" } })).toBe("svg 12");
    expect(name({ kind: "svg", hints: { linkHref: "https://stripe.com/" } })).toBe("svg 12");
    expect(hrefName("mailto:sales@stripe.com")).toBeUndefined();
    expect(hrefName(undefined)).toBeUndefined();
  });

  it("reads the id a sprite reference or a hand built vector carries", () => {
    expect(markupName('<svg><use href="#visa-logo"/></svg>')).toBe("visa");
    expect(markupName('<svg><linearGradient id="bsport-linear-gradient-a-:R4nrnmr6l6:"/><path/></svg>')).toBe("bsport");
    expect(markupName('<svg><radialGradient id="connect-payment-card-graphic-daybreak-yoga-logo-gradient"/></svg>')).toBe("connect payment card daybreak yoga");
    // Ids a drawing tool wrote name nothing.
    expect(markupName('<svg><path id="a"/><clipPath id="clip0_1_2"/></svg>')).toBeUndefined();
    // Illustrator and Sketch keep the default layer name of the language the artist worked in, and their shape names
    // say what was drawn: figma.com serves a customer logo as id="Capa_1", and on iberia.com and sncf-connect.com the
    // first id of a vector is "Rectangle" or "Bouton". "site-rectangle.svg" is worse than "svg 49".
    for (const id of ["Capa_1", "Calque_1", "Ebene_1", "Livello_1", "Isolation_Mode", "XMLID_1_", "Rectangle", "Oval",
      "Artboard", "Page-1", "Combined-Shape", "Bouton", "Untitled-1"]) {
      expect(markupName(`<svg><path id="${id}"/></svg>`), id).toBeUndefined();
    }
    expect(markupName('<svg><linearGradient id="paint0_linear_23_1"/></svg>')).toBeUndefined();
    expect(markupName("<svg><path d=\"M0 0h8v8z\"/></svg>")).toBeUndefined();
    expect(markupName(undefined)).toBeUndefined();
    expect(name({ kind: "svg", markup: '<svg><use href="#klarna"/></svg>' })).toBe("klarna");
  });

  it("reads an id of a long digit run that does not end the word", () => {
    // `\d+$` tried from every digit of the run: 400,000 digits in one id took minutes on the event loop.
    expect(markupName(`<svg><path id="${"1".repeat(400_000)}x"/></svg>`)).toBe("1".repeat(80));
    expect(markupName('<svg><path id="acme2-logo"/></svg>')).toBe("acme");
  });

  it("falls back to the caption beside the element, then to the generic name", () => {
    expect(name({ kind: "svg", hints: { nearbyText: "Jackson Hot Yoga" } })).toBe("Jackson Hot Yoga");
    // Everything closer wins over it.
    expect(name({ kind: "svg", markup: '<svg><use href="#klarna"/></svg>', hints: { nearbyText: "Jackson Hot Yoga" } })).toBe("klarna");
    expect(name({ kind: "svg", hints: {} })).toBe("svg 12");
  });
});

describe("cleanBasename", () => {
  it("removes extensions, build hashes and CDN size parameters", () => {
    expect(cleanBasename("https://a.example/static/logo.a1b2c3d4.svg")).toBe("logo");
    expect(cleanBasename("https://a.example/hero-3f9ab1c2e4.png")).toBe("hero");
    expect(cleanBasename("https://a.example/assets/index-BzXk3a9Q.png")).toBe("index");
    expect(cleanBasename("https://a.example/_next/image?url=%2Fimg%2Fteam%20photo.jpg&w=640&q=75")).toBe("team photo");
    expect(cleanBasename("https://www.apple.com/v/home/images/hero_large_2x.jpg")).toBe("hero");
    expect(cleanBasename("https://cdn.prod.website-files.com/a/b/customer-p-500.png")).toBe("customer");
    expect(cleanBasename("https://a.example/deadline-2025.png")).toBe("deadline-2025");
    expect(cleanBasename("https://a.example/")).toBeUndefined();
    expect(cleanBasename("data:image/png;base64,AAAA")).toBeUndefined();
  });

  it("reads the name a file was uploaded to Notion with, whichever way Notion serves it", () => {
    // ethglobal.notion.site/Brand-493ce449e63444288d5b9c0ed59123ca: three logos that used to be one name cut short.
    const space = "6594f729-d57b-4ace-a6ca-ef7eca93bb9d";
    const block = "table=block&id=391d62f1-a412-8070-8626-e588c938f96b&spaceId=6594f729-d57b-4ace-a6ca-ef7eca93bb9d&width=470&userId=&cache=v2";
    expect(cleanBasename(`https://ethglobal.notion.site/image/attachment%3Acf353582-4ab1-4745-854a-c87ed7d7c8b4%3AETHGlobal-Horizontal-Colour.png?${block}`)).toBe("ETHGlobal-Horizontal-Colour");
    expect(cleanBasename(`https://ethglobal.notion.site/image/attachment%3A8e1366cb-6149-47f6-a4d5-5a6ed86adf1b%3AETHGlobal-Vertical-Colour.png?${block}`)).toBe("ETHGlobal-Vertical-Colour");
    expect(cleanBasename(`https://img.notionusercontent.com/s3/prod-files-secure%2F${space}%2F53d5d914-1641-47b8-a0ef-ddca4447d653%2FETHGlobal-Logomark-Colour.png/size/w=250?tok=eyJhbGciOiJFUzI1NiIs`)).toBe("ETHGlobal-Logomark-Colour");
    expect(cleanBasename(`https://www.notion.so/image/https%3A%2F%2Fs3-us-west-2.amazonaws.com%2Fsecure.notion-static.com%2F53d5d914-1641-47b8-a0ef-ddca4447d653%2FPress_Kit_Logo.svg?${block}`)).toBe("Press_Kit_Logo");
    // Notion's own static files keep their plain name, and another host is read as before.
    expect(cleanBasename("https://ethglobal.notion.site/images/notion-logo-block-main.svg")).toBe("notion-logo-block-main");
    expect(cleanBasename("https://a.example/image/attachment%3Acf353582-4ab1-4745-854a-c87ed7d7c8b4%3ALogo.png")).toBe("attachment:cf353582-4ab1-4745-854a-c87ed7d7c8b4:Logo");
  });

  it("drops the upload id in front of a Webflow file name", () => {
    expect(cleanBasename("https://cdn.prod.website-files.com/66f11b59c8366f8c2c21551f/697a5b66a5451b053d6dde00_Bloomberg-logo.svg")).toBe("Bloomberg-logo");
    expect(cleanBasename("https://cdn.prod.website-files.com/a/68c9a39c128261b2128439c9_Docusign-dark-p-500.png")).toBe("Docusign-dark");
    expect(cleanBasename("https://a.example/2025-annual-report.png")).toBe("2025-annual-report");
  });

  it("names nothing after a file name that is only an id", () => {
    // brand.ripple.com: Frontify stores guideline images under random ids.
    for (const id of ["CDrbG9w8RVujxhmrDWHJ", "9RDHFnfBtS5FiS9szDzF", "QM8iRPQg75AZuqCD6Ahr", "eQ8ysJqywFHMaaTRFCoz", "dn3Rqx5ehjCt6414Q1fQ",
      "UqqveTsFV3gNU69w2nTS", "PwZxC5TQw1NYjXiHVqtx", "6964d40aecc2aafdea1a8419", "da39a3ee5e6b4b0d3255bfef95601890afd80709"]) {
      expect(cleanBasename(`https://media.ffycdn.net/us/ripple/${id}.png?width=800`), id).toBeUndefined();
    }
    // A base64 path with a signature after it, which Frontify serves lazy loaded images under.
    expect(cleanBasename("https://media.ffycdn.net/us/ripple/eyJwYXRoIjoicmlwcGxlXC9hY2NvdW50c1wvYTZcLzQwMDA5ODZcL3Byb2plY3RzXC82XC9hc3NldHNc:ripple:aZ9-C2NWnaT0Hvr?mod=v1/resize=770")).toBeUndefined();
    expect(name({ url: "https://media.ffycdn.net/us/ripple/CDrbG9w8RVujxhmrDWHJ.png" })).toBe("image 12");
    // Names in camelCase keep their digits and capitals.
    for (const kept of ["HeroBackground2x", "iPhone15ProMax2x", "RedStoneLogoSymbol", "WhatsAppImage20260630", "Logo2026", "RhythmGame2026Hero", "NYSEWiredLogo2026"]) {
      expect(cleanBasename(`https://a.example/${kept}.png`), kept).toBe(kept);
    }
  });
});

describe("fileName", () => {
  it("reads the file a URL or an SVGR compiled vector came from", () => {
    expect(fileName("https://www.redstone.finance/images/RedStoneLogoSymbol.svg")).toBe("RedStoneLogoSymbol");
    expect(fileName("https://a.example/_next/image?url=%2Fimg%2Fpartner-logo.png&w=640&q=75")).toBe("partner-logo");
    // ethglobal.com: SVGR prefixes the ids of an inline vector with the file it compiled.
    expect(fileName(undefined, '<svg><g clip-path="url(#logo_svg__a)"><path/></g><clipPath id="logo_svg__a"/></svg>')).toBe("logo");
    expect(fileName(undefined, '<svg><clipPath id="clip0_1_2"/></svg>')).toBeUndefined();
    expect(fileName("data:image/png;base64,AAAA")).toBeUndefined();
  });
});

describe("createFilenamer", () => {
  it("prefixes the site slug once and keeps the extension", () => {
    const filename = createFilenamer("Linear");
    expect(filename("Logo", "svg")).toBe("linear-logo.svg");
    expect(filename("Linear logo", "svg")).toBe("linear-logo-2.svg");
    expect(filename("Linear", "png")).toBe("linear.png");
    expect(filename("Linearity chart", "png")).toBe("linear-linearity-chart.png");
  });

  it("caps names at 80 characters and resolves clashes", () => {
    const filename = createFilenamer("Linear");
    const long = "a".repeat(200);
    const first = filename(long, "png");
    const second = filename(long, "png");
    expect(first.length).toBeLessThanOrEqual(80);
    expect(second.length).toBeLessThanOrEqual(80);
    expect(second).toMatch(/-2\.png$/);
    expect(first).not.toBe(second);
  });

  it("never produces paths or control characters", () => {
    const filename = createFilenamer("Evil");
    const unsafe = filename("../evil/<name>", "svg");
    expect(unsafe).toBe("evil-name.svg");
    expect(filename("..", "png")).toBe("evil.png");
    expect(filename("a/../../b\u0000c", "png")).toBe("evil-a-b-c.png");
    expect(filename("Café Crème", "jpg")).toBe("evil-cafe-creme.jpg");
    expect(filename("東京 タワー", "jpg")).toBe("evil-東京-タワー.jpg");
  });

  it("falls back to a generic slug when the site name has no letters", () => {
    expect(createFilenamer("")("Logo", "svg")).toBe("site-logo.svg");
  });
});
