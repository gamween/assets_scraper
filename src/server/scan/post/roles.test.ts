import { describe, expect, it, vi } from "vitest";
import { LINEAR_OP_GROWTH_BOUND, opGrowth } from "../fonts/testing";
import type { CandidateContext } from "../types";
import { assignRole, isSpriteSheet, logoScore, relevanceScore, type RoleInput } from "./roles";

/** The characters each `searchFrom` steps over, counted for `opGrowth`. */
const ops = vi.hoisted(() => ({ count: 0 }));
vi.mock("./search", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./search")>();
  return {
    ...actual,
    searchFrom: (text: string, pattern: RegExp, from: number) => {
      const match = actual.searchFrom(text, pattern, from);
      ops.count += (match ? match.index + match[0].length : text.length) - from;
      return match;
    },
  };
});

const context = (patch: Partial<CandidateContext> = {}): CandidateContext => ({
  header: false, nav: false, footer: false, homeLink: false, logoWord: false, siteWord: false, logoWall: false,
  shadowRoot: false, iframe: false, ...patch,
});

const role = (patch: Partial<RoleInput>) => assignRole({ kind: "image", foundIn: ["img"], logoScore: 0, logoWord: false, logoWall: false, ...patch });

describe("logoScore", () => {
  it("adds the logo signals", () => {
    expect(logoScore(context({ header: true, homeLink: true, logoWord: true }), false)).toBe(8);
    expect(logoScore(context({ header: true, homeLink: true, logoWord: true }), true, { x: 0, y: 12, width: 120, height: 32 })).toBe(9);
    expect(logoScore(context({ header: true, nav: true, siteWord: true, footer: true }), true, { x: 0, y: 400, width: 1, height: 1 })).toBe(5);
    expect(logoScore(context(), false)).toBe(0);
  });
});

describe("assignRole", () => {
  it("makes a header SVG in a home link with a logo word the site logo", () => {
    const score = logoScore(context({ header: true, homeLink: true, logoWord: true }), false);
    expect(role({ kind: "svg", foundIn: ["inline-svg"], logoScore: score, logoWord: true, rendered: { width: 120, height: 32 } })).toBe("site-logo");
    expect(role({ foundIn: ["json-ld"] })).toBe("site-logo");
  });

  it("does not promote a hero picture the size of the viewport on position alone", () => {
    // apple.com: a link to home, in the header, near the top scores exactly 6 with nothing logo specific about it.
    const score = logoScore(context({ header: true, homeLink: true }), true, { x: 0, y: 0, width: 3008, height: 692 });
    expect(score).toBe(6);
    expect(role({ logoScore: score, label: "iPhone 18 Pro", rendered: { width: 3008, height: 692 } })).toBe("image");
    // The wordmark beside it still is the site logo.
    expect(role({ kind: "svg", foundIn: ["inline-svg"], logoScore: score, label: "Apple", rendered: { width: 14, height: 44 } })).toBe("site-logo");
    // Logo evidence does not lift the limit: on apple.com the hero group carries it and is still a hero.
    expect(role({ logoScore: score, logoWord: true, rendered: { width: 3008, height: 692 } })).toBe("image");
    // A JSON-LD logo is a declaration, not a guess, so it is the site logo at any size.
    expect(role({ foundIn: ["json-ld"], rendered: { width: 3008, height: 692 } })).toBe("site-logo");
    // The limit is generous: a banner sized wordmark on position alone is still the site logo.
    expect(role({ logoScore: score, rendered: { width: 600, height: 200 } })).toBe("site-logo");
  });

  it("recognizes favicons, social images and logos", () => {
    expect(role({ foundIn: ["og-image"] })).toBe("social");
    expect(role({ foundIn: ["img", "twitter-image"], rendered: { width: 24, height: 24 } })).toBe("social");
    expect(role({ foundIn: ["icon-link"], intrinsic: { width: 16, height: 16 } })).toBe("favicon");
    expect(role({ foundIn: ["manifest"] })).toBe("favicon");
    expect(role({ foundIn: ["meta-icon"], intrinsic: { width: 144, height: 144 } })).toBe("favicon");
    expect(role({ logoWall: true, rendered: { width: 120, height: 40 } })).toBe("logo");
    expect(role({ logoWord: true, rendered: { width: 20, height: 20 } })).toBe("logo");
    expect(role({ label: "Acme Logo", rendered: { width: 300, height: 100 } })).toBe("logo");
  });

  // stripe.com, recorded in the collector output of a real scan: the alt sentence of each photograph mentions the
  // Stripe logo, so the collector flagged logoWord and siteWord on a 1232x531 picture of a street.
  it("keeps a photograph out of the logos while the customer logo wall stays", () => {
    const photograph = {
      logoScore: logoScore(context({ logoWord: true, siteWord: true }), true, { x: 104, y: 5096, width: 1232, height: 531 }),
      logoWord: true,
      label: "Aerial view of a street intersection where the crosswalks form a slanted parallelogram, imitating the Stripe logo.",
      rendered: { width: 1232, height: 531 },
      intrinsic: { width: 2460, height: 1060 },
    };
    expect(role(photograph)).toBe("image");
    // The same file below the fold never rendered, so only the size of the file says how big it is.
    expect(role({ ...photograph, rendered: undefined })).toBe("image");
    // Stripe's customer logos are logos and stay logos.
    expect(role({ kind: "svg", foundIn: ["inline-svg"], logoWall: true, label: "OpenAI", rendered: { width: 142, height: 34 } })).toBe("logo");
    expect(role({ kind: "svg", foundIn: ["inline-svg"], logoWall: true, rendered: { width: 150, height: 36 } })).toBe("logo");
    // A hidden carousel logo has no rendered size, and the viewBox of a vector says nothing about the page.
    expect(role({ kind: "svg", foundIn: ["inline-svg"], logoWall: true, intrinsic: { width: 1024, height: 246 } })).toBe("logo");
    // A raster customer logo is small enough either way.
    expect(role({ logoWall: true, intrinsic: { width: 400, height: 120 } })).toBe("logo");
  });

  // A logo the scanned viewport never showed has no rendered size, so the file is all that is left to measure. A file
  // is a poor measure of a logo: a 2x or stacked raster passes 120,000 px2 on its own, and the page still treats it
  // as its logo. Only a picture that has nothing but a word behind it is measured that way.
  it("keeps a hidden logo in the logos whatever its file measures", () => {
    const header = logoScore(context({ header: true, homeLink: true, logoWord: true }), false);
    expect(header).toBeGreaterThanOrEqual(6);
    // A mobile only header logo, a dark theme variant behind display:none, a 2x raster.
    expect(role({ logoScore: header, logoWord: true, intrinsic: { width: 1200, height: 300 } })).toBe("site-logo");
    expect(role({ logoScore: header, logoWord: true, intrinsic: { width: 512, height: 512 } })).toBe("site-logo");
    // A hidden carousel slide of the customer logo wall.
    expect(role({ logoWall: true, intrinsic: { width: 800, height: 200 } })).toBe("logo");
    // Still measured by its file when a word in a class or an alt is the only logo signal.
    expect(role({ logoScore: 3, logoWord: true, intrinsic: { width: 2460, height: 1060 } })).toBe("image");
    // Once it renders, the rendered size decides, promotion score or not.
    expect(role({ logoScore: header, logoWord: true, rendered: { width: 1200, height: 300 }, intrinsic: { width: 1200, height: 300 } })).toBe("image");
  });

  it("does not read the word logo out of a sentence", () => {
    const prose = "Overhead view of a door stoop with a grocery delivery bag whose handles trace the Stripe logo.";
    expect(role({ label: prose, rendered: { width: 300, height: 100 } })).toBe("image");
    expect(role({ label: "Acme logo", rendered: { width: 300, height: 100 } })).toBe("logo");
  });

  it("applies one small-icon rule: rendered side, else intrinsic side, at most 48", () => {
    expect(role({ kind: "svg", foundIn: ["inline-svg"], rendered: { width: 24, height: 24 } })).toBe("icon");
    expect(role({ kind: "svg", foundIn: ["inline-svg"], rendered: { width: 49, height: 12 } })).toBe("illustration");
    expect(role({ kind: "svg", foundIn: ["inline-svg"], intrinsic: { width: 40, height: 40 } })).toBe("icon");
    expect(role({ rendered: { width: 300, height: 48 }, intrinsic: { width: 24, height: 24 } })).toBe("image");
    expect(role({ intrinsic: { width: 64, height: 48 } })).toBe("image");
    expect(role({})).toBe("image");
  });

  it("never makes a favicon or a logo an icon, and labels sprite symbols", () => {
    expect(role({ foundIn: ["icon-link"], rendered: { width: 16, height: 16 } })).toBe("favicon");
    expect(role({ logoWord: true, intrinsic: { width: 16, height: 16 } })).toBe("logo");
    expect(role({ kind: "svg", foundIn: ["sprite-symbol"], spriteSymbol: true, intrinsic: { width: 24, height: 24 } })).toBe("sprite-symbol");
  });
});

describe("relevanceScore", () => {
  it("orders site logo, large visible image, hidden icon", () => {
    const logo = relevanceScore({ role: "site-logo", visible: true, renderedWidth: 120, renderedHeight: 32, order: 5 });
    const image = relevanceScore({ role: "image", visible: true, renderedWidth: 1200, renderedHeight: 600, order: 40 });
    const icon = relevanceScore({ role: "icon", visible: false, order: 2 });
    expect(logo).toBeGreaterThan(image);
    expect(image).toBeGreaterThan(icon);
  });

  it("follows the weights", () => {
    expect(relevanceScore({ role: "image", visible: true, renderedWidth: 1200, renderedHeight: 600, order: 100 })).toBeCloseTo(100 + 90 + 50 - 1);
    expect(relevanceScore({ role: "favicon", visible: false, renderedWidth: 16, renderedHeight: 16, order: 0 })).toBe(300);
    expect(relevanceScore({ role: "sprite-symbol", visible: false, order: 3 })).toBeCloseTo(19.97);
  });
});

describe("isSpriteSheet", () => {
  it("recognizes SVG files that only define symbols", () => {
    expect(isSpriteSheet('<svg xmlns="http://www.w3.org/2000/svg"><symbol id="a" viewBox="0 0 24 24"><path d="M0 0h24v24z"/></symbol></svg>')).toBe(true);
    expect(isSpriteSheet('<svg><defs><linearGradient id="g"/><symbol id="a"><circle r="4"/></symbol></defs><style>.a{fill:red}</style></svg>')).toBe(true);
    expect(isSpriteSheet('<svg><defs><symbol id="a"><path d="M0 0h8v8z"/></symbol></defs><use href="#a"/></svg>')).toBe(false);
    expect(isSpriteSheet('<svg><symbol id="a"><path d="M0 0h8v8z"/></symbol><rect width="8" height="8"/></svg>')).toBe(false);
    expect(isSpriteSheet('<svg><path d="M0 0h8v8z"/></svg>')).toBe(false);
  });

  it("reads a drawing left open in a symbol or a definition as drawn", () => {
    expect(isSpriteSheet('<svg><symbol id="a"><path d="M0 0h8v8z"/></svg>')).toBe(false);
    expect(isSpriteSheet('<svg><symbol id="a"/></symbol><defs><path d="M0 0h8v8z"/></svg>')).toBe(false);
    expect(isSpriteSheet('<svg><SYMBOL id="a"><path d="M0 0h8v8z"/></SYMBOL ><symbol id="b"><rect/></symbol></svg>')).toBe(true);
  });

  /**
   * Regression: the lazy strip read from every `<symbol` without a closer to the end of the markup, so a valid 1 MB SVG
   * holding `<symbol` 150,000 times in a comment took 20 seconds, for each file asset that carried it.
   */
  it("reads hostile markup in linear time", async () => {
    const hostile: Record<string, (size: number) => string> = {
      symbols: (size) => `<svg><!--${"<symbol ".repeat(size / 8)}--><path d="M0 0"/></svg>`,
      definitions: (size) => `<svg><symbol id="a"/></symbol><!--${"<defs ".repeat(size / 6)}--><path d="M0 0"/></svg>`,
      closed: (size) => `<svg>${'<symbol id="a"><path d="M0 0"/></symbol>'.repeat(size / 40)}</svg>`,
    };
    for (const [kind, markup] of Object.entries(hostile)) {
      const { small, large, factor } = await opGrowth((size) => isSpriteSheet(markup(size)), 20_000, ops);
      expect.soft(small, kind).toBeGreaterThan(0);
      expect.soft(factor, kind).toBeLessThan(LINEAR_OP_GROWTH_BOUND);
      // Each pass reads the markup once
      expect.soft(large, kind).toBeLessThanOrEqual(3 * markup(20_000 * 8).length);
    }
    expect(isSpriteSheet(`<svg><!--${"<symbol ".repeat(150_000)}--><path d="M0 0"/></svg>`)).toBe(false);
  });
});
