import { describe, expect, it } from "vitest";
import { brandFileType, isBrandFileWord, isBrandPortal, isBrandWord, isGenericLabel, isStrongBrandPhrase, linkKey, siteOf } from "./brand";

describe("siteOf", () => {
  it("keeps the registrable domain, three labels under a co.uk-like suffix, and addresses as they are", () => {
    expect(siteOf("www.stellar.org")).toBe("stellar.org");
    expect(siteOf("live.standards.site")).toBe("standards.site");
    expect(siteOf("assets.shop.co.uk")).toBe("shop.co.uk");
    expect(siteOf("127.0.0.1")).toBe("127.0.0.1");
    expect(siteOf("localhost")).toBe("localhost");
  });
});

describe("isBrandWord", () => {
  it("matches a brand word at the start of a word, run on or camelCase, and not inside another word", () => {
    for (const text of ["brand-kit", "Press kit", "/brandassets", "logopack", "OurBrand", "newsroom", "media_kit", "Guidelines"]) {
      expect(isBrandWord(text), text).toBe(true);
    }
    for (const text of ["logout", "logon", "pressure", "wordpress", "impressum", "express", "Other"]) {
      expect(isBrandWord(text), text).toBe(false);
    }
  });

  it("takes the names only logo files carry as brand file words", () => {
    expect(isBrandFileWord("Wordmark.svg")).toBe(true);
    expect(isBrandFileWord("primary-lockup.png")).toBe(true);
    expect(isBrandFileWord("discord.svg")).toBe(false);
  });
});

describe("isStrongBrandPhrase", () => {
  it("takes the phrases real pages use for a kit kept on another host", () => {
    for (const text of [
      "Brand Kit", // sui.io, to live.standards.site
      "Download the Media Kit", // raisesummit.com/media, to a Google Drive folder
      "Brand manual", // trezor.io/press-and-media, the heading over its Visualbook link
      "Official logo files on Drive →", // signalweekhq.com, to a Google Drive folder
      "Press kit",
      "Brand guidelines",
      "Brand Resource Hub",
      "brandkit",
      "MediaKit",
      "sui-media-kit",
      "Logo pack",
      "Visual identity",
    ]) {
      expect(isStrongBrandPhrase(text), text).toBe(true);
    }
  });

  it("refuses one word, and phrases that only start like a kit", () => {
    for (const text of ["Other brand", "Their brand", "Brand", "Press", "Press release", "Academic research awards", "Brand new", "branding", "Media coverage"]) {
      expect(isStrongBrandPhrase(text), text).toBe(false);
    }
  });
});

describe("isBrandPortal", () => {
  const portal = (url: string) => isBrandPortal(new URL(url));

  it("takes a portal on a vendor subdomain, or under a path of the vendor's host", () => {
    expect(portal("https://live.standards.site/sui-media-kit")).toBe(true);
    expect(portal("https://satoshilabs.visualbook.pro/trezor")).toBe(true);
    expect(portal("https://acme.frontify.com/d/abc123/brand-guidelines")).toBe(true);
    expect(portal("https://brandfolder.com/acme")).toBe(true);
  });

  it("refuses the vendor's own home page and every other host", () => {
    expect(portal("https://www.frontify.com/")).toBe(false);
    expect(portal("https://standards.site")).toBe(false);
    expect(portal("https://notstandards.site/kit")).toBe(false);
    expect(portal("https://drive.google.com/drive/folders/1PozkRBtCbjbqqQFChGFTc45xZe_kcjMT")).toBe(false);
  });
});

describe("linkKey", () => {
  const key = (url: string) => linkKey(new URL(url));

  it("reads a path with and without its trailing slash as one link, and drops the fragment and credentials", () => {
    // francefintech.org links its press releases both ways.
    expect(key("https://francefintech.org/cp/")).toBe(key("https://francefintech.org/cp"));
    expect(key("https://acme.frontify.com/d/kit/#logos")).toBe("https://acme.frontify.com/d/kit");
    expect(key("https://user:secret@x.com/press/")).toBe("https://x.com/press");
    expect(key("https://x.com/")).toBe("https://x.com/");
    expect(key("https://x.com/press/?lang=fr")).toBe("https://x.com/press?lang=fr");
  });

  it("keeps everything else apart", () => {
    expect(key("https://x.com/Press")).not.toBe(key("https://x.com/press"));
    expect(key("https://x.com/press?lang=fr")).not.toBe(key("https://x.com/press"));
    expect(key("https://x.com/press/index.html")).not.toBe(key("https://x.com/press"));
    expect(key("http://x.com/press")).not.toBe(key("https://x.com/press"));
    expect(key("https://x.com/press//")).not.toBe(key("https://x.com/press"));
  });
});

describe("brandFileType", () => {
  it("reads the type from the extension, whatever its case, and nothing else", () => {
    expect(brandFileType("/brandkit/downloads/1225_Arbitrum_Logo_all.zip")).toBe("zip");
    expect(brandFileType("Monad Brand and Media Kit.ZIP")).toBe("zip");
    expect(brandFileType("guidelines.pdf")).toBe("pdf");
    expect(brandFileType("logo.ai")).toBe("ai");
    expect(brandFileType("logo.eps")).toBe("eps");
    expect(brandFileType("/brand-page-assets/Logomark.svg")).toBe("svg");
    expect(brandFileType("Full.png")).toBe("png");
    expect(brandFileType("/brand")).toBeUndefined();
    expect(brandFileType("photo.jpg")).toBeUndefined();
    expect(brandFileType("archive.zip.html")).toBeUndefined();
  });
});

describe("isGenericLabel", () => {
  it("is true for labels that only say download, a format or a size", () => {
    for (const text of ["", "Download", "View", "DOWNLOAD PNG + SVG", "Get the ZIP (2.4 MB)", "Download all files", "Open →"]) {
      expect(isGenericLabel(text), text).toBe(true);
    }
  });

  it("is false once a label names the file", () => {
    for (const text of ["Download All Arbitrum Logo Variations", "Stellar logo pack", "Go to Visualbook", "Brand guidelines"]) {
      expect(isGenericLabel(text), text).toBe(false);
    }
  });
});
