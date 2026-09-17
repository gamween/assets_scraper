import { describe, expect, it } from "vitest";
import type { CandidateContext } from "../types";
import { assignRole, isSpriteSheet, logoScore, relevanceScore, type RoleInput } from "./roles";

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

  it("recognizes favicons, social images and logos", () => {
    expect(role({ foundIn: ["og-image"] })).toBe("social");
    expect(role({ foundIn: ["img", "twitter-image"], rendered: { width: 24, height: 24 } })).toBe("social");
    expect(role({ foundIn: ["icon-link"], intrinsic: { width: 16, height: 16 } })).toBe("favicon");
    expect(role({ foundIn: ["manifest"] })).toBe("favicon");
    expect(role({ logoWall: true, rendered: { width: 120, height: 40 } })).toBe("logo");
    expect(role({ logoWord: true, rendered: { width: 20, height: 20 } })).toBe("logo");
    expect(role({ label: "Acme Logo", rendered: { width: 300, height: 100 } })).toBe("logo");
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
});
