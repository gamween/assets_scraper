import { describe, expect, it } from "vitest";
import { formatFontInstall, formatFontList, formatFontUninstall } from "./font-report";
import type { FontInstall } from "./types";

/** What the CLI prints about fonts. The installer itself is in `fonts.test.ts`. */

const inter: FontInstall = {
  family: "Inter",
  files: ["/tmp/fonts/Inter-Regular.ttf"],
  license: { kind: "open", text: "SIL Open Font License" },
  sourceHost: "cdn.example.com",
  installedAt: "2026-09-28T09:00:00.000Z",
  converted: true,
};

const sohne: FontInstall = {
  ...inter,
  family: "Söhne",
  files: ["/tmp/fonts/Sohne-Regular.ttf"],
  license: { kind: "commercial", text: "Copyright\n  Klim Type Foundry" },
  converted: false,
};

describe("formatFontInstall", () => {
  it("prints the licence of every install, the files, and a reason for every family it skipped", () => {
    const report = formatFontInstall({
      fontDir: "/tmp/fonts",
      manifestPath: "/tmp/state/installed-fonts.json",
      installed: [inter, sohne],
      skipped: [
        { family: "Kit", reason: "adobe-fonts" },
        { family: "Huge", reason: "too-large", detail: "9000000 bytes" },
      ],
    });

    expect(report).toContain("Inter: open licence (SIL Open Font License)");
    expect(report).toContain("/tmp/fonts/Inter-Regular.ttf (converted to TTF)");
    // A commercial font installs too, with its licence on one line and the warning that goes with it (spec 5.5).
    expect(report).toContain("Söhne: commercial licence (Copyright Klim Type Foundry). Read it before you ship");
    expect(report).not.toContain("Sohne-Regular.ttf (converted");
    expect(report).toContain("Kit: not installed, Adobe Fonts never exposes the file");
    expect(report).toContain("Huge: not installed, the file is larger than the install limit: 9000000 bytes");
    expect(report).toContain("font directory: /tmp/fonts");
    expect(report).not.toMatch(/[—–]/);
  });

  it("says so when the page carried no font to install", () => {
    const report = formatFontInstall({ fontDir: "/tmp/fonts", manifestPath: "/tmp/state/installed-fonts.json", installed: [], skipped: [] });
    expect(report).toContain("no font family to install on this page");
  });
});

describe("formatFontList", () => {
  it("prints what was installed, from where and when", () => {
    const listed = formatFontList([inter]);
    expect(listed).toContain("Inter: open licence");
    expect(listed).toContain("from cdn.example.com, installed 2026-09-28");
    expect(listed).toContain("/tmp/fonts/Inter-Regular.ttf");
  });

  it("says nothing was installed rather than printing an empty list", () => {
    expect(formatFontList([])).toBe("this tool has installed no font yet");
  });
});

describe("page text in a font report", () => {
  /** A CSS family name keeps what a page escaped into it, `\1b` included, so every report cleans it before printing. */
  it("never reaches the terminal with its control characters", () => {
    const hostile = { ...inter, family: "Inter\u001b]52;c;cGF5bG9hZA==\u0007", sourceHost: "cdn\u001b[2J.example", license: { kind: "commercial" as const, text: "Read me\u001b[1A\u001b[2K" } };
    const reports = [
      formatFontInstall({ fontDir: "/tmp/fonts", manifestPath: "/tmp/state/installed-fonts.json", installed: [hostile], skipped: [{ family: hostile.family, reason: "exists", detail: "/tmp/fonts/x\u001b[2J" }] }),
      formatFontList([hostile]),
      formatFontUninstall({ removed: [hostile], missing: [hostile.family], stillInstalled: [], changed: [{ family: hostile.family, files: ["/tmp/fonts/Inter-Regular.ttf"] }] }),
    ];
    for (const report of reports) expect(report).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
    expect(reports[0]).toContain("Read it before you ship anything with this font");
  });
});

describe("formatFontUninstall", () => {
  it("names what it removed and what it never installed", () => {
    const report = formatFontUninstall({ removed: [inter], missing: ["Nope"], stillInstalled: [], changed: [] });
    expect(report).toContain("removed Inter");
    expect(report).toContain("/tmp/fonts/Inter-Regular.ttf");
    expect(report).toContain("Nope: this tool did not install it, nothing removed");
  });

  /** Regression: a family none of whose files could be removed printed as `removed`, with no file lines and no warning. */
  it("says a family is still installed rather than claiming it was removed", () => {
    const report = formatFontUninstall({ removed: [], missing: [], stillInstalled: [{ family: "Inter", files: ["/elsewhere/Inter-Regular.ttf"] }], changed: [] });
    expect(report).toContain("Inter: still installed, none of its files could be removed");
    expect(report).toContain("/elsewhere/Inter-Regular.ttf");
    expect(report).not.toContain("removed Inter");
  });

  it("says which recorded files it left because they are not the ones it installed", () => {
    const report = formatFontUninstall({ removed: [], missing: [], stillInstalled: [], changed: [{ family: "Inter", files: ["/tmp/fonts/Inter-Regular.ttf"] }] });
    expect(report).toContain("Inter: left in place, these files are no longer the ones this tool installed");
    expect(report).toContain("/tmp/fonts/Inter-Regular.ttf");
    expect(report).not.toContain("nothing to remove");
  });
});
