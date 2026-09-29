import { describe, expect, it } from "vitest";
import { filenameForFormat, replaceExtension } from "./download";

describe("filenameForFormat", () => {
  it("names the bytes by their format", () => {
    expect(filenameForFormat("linear-hero.webp", "png")).toBe("linear-hero.png");
    expect(filenameForFormat("linear-logo", "svg")).toBe("linear-logo.svg");
    expect(replaceExtension("linear-hero.webp", "png")).toBe("linear-hero.png");
  });

  it("keeps the extension of a file whose format has no name", () => {
    // A PDF or a TIFF scanned as the page itself: its server filename is the only record of what it is, not `.bin`.
    expect(filenameForFormat("example-guide.pdf", "other")).toBe("example-guide.pdf");
    expect(filenameForFormat("example-map.tif", "other")).toBe("example-map.tif");
  });
});
