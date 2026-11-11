import { describe, expect, it } from "vitest";
import { brandFileType, isBrandFileWord, isBrandWord, isGenericLabel, siteOf } from "./brand";

describe("siteOf", () => {
  it("keeps the registrable domain, three labels under a co.uk-like suffix, and addresses as they are", () => {
    expect(siteOf("www.stellar.org")).toBe("stellar.org");
    expect(siteOf("cdn.fixture.co.uk")).toBe("fixture.co.uk");
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
