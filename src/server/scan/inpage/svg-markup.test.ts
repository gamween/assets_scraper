import { describe, expect, it } from "vitest";
import { canonicalSvgMarkup, varFallback, withoutRootSize } from "./svg-markup";

describe("varFallback", () => {
  it("replaces each var() by its fallback, or gives nothing when one has none", () => {
    expect(varFallback("var(--brand, #ff0000)")).toBe("#ff0000");
    expect(varFallback("var(--a,  rgb(0, 0, 0) )")).toBe("rgb(0, 0, 0)");
    expect(varFallback("var(--a)")).toBe("");
    expect(varFallback("var(--a, var(--b, red))")).toBe("");
  });

  it("reads a long run of spaces after the comma in linear time", () => {
    // `,\s*` before the fallback matched the same spaces as the fallback: 400,000 of them took minutes in the page.
    expect(varFallback(`var(--a,${" ".repeat(400_000)}`)).toBe("");
    expect(varFallback(`var(--a,${" ".repeat(400_000)}red)`)).toBe("red");
  });
});

describe("canonicalSvgMarkup", () => {
  it("renames ids in order of appearance, references included, and collapses whitespace", () => {
    const a = '<svg>\n  <defs><linearGradient id="grad-123"/></defs>\n  <rect fill="url(#grad-123)"/><use href="#grad-123"/></svg>';
    const b = '<svg>\n  <defs><linearGradient id="grad-987"/></defs>\n  <rect fill="url(#grad-987)"/><use href="#grad-987"/></svg>';
    expect(canonicalSvgMarkup(a)).toBe('<svg><defs><linearGradient id="i0"/></defs><rect fill="url(#i0)"/><use href="#i0"/></svg>');
    expect(canonicalSvgMarkup(b)).toBe(canonicalSvgMarkup(a));
    // A reference to an id the markup does not declare, and a longer id that starts with a declared one, stay as they are
    expect(canonicalSvgMarkup('<svg><g id="a"/><use href="#ab"/><use href="#c"/></svg>')).toBe('<svg><g id="i0"/><use href="#ab"/><use href="#c"/></svg>');
    // A declared id named like a renamed one is renamed once, not twice
    expect(canonicalSvgMarkup('<svg><g id="x"/><g id="i0"/><use href="#i0"/></svg>')).toBe('<svg><g id="i0"/><g id="i1"/><use href="#i1"/></svg>');
  });

  it("hashes one logo rendered at two sizes as one drawing", () => {
    // bnbchain.org: the header and a menu render the same wordmark 136 and 137 px wide, and the collector writes that
    // size onto the root, so the two copies came back as two logos.
    const logo = (width: string) => `<svg viewBox="0 0 137 24" xmlns="http://www.w3.org/2000/svg" width="${width}" height="24"><path d="M0 0h10v10z" fill="#F0B90B"/></svg>`;
    expect(canonicalSvgMarkup(logo("136"))).toBe(canonicalSvgMarkup(logo("137")));
    expect(canonicalSvgMarkup(logo("136"))).toBe('<svg viewBox="0 0 137 24" xmlns="http://www.w3.org/2000/svg"><path d="M0 0h10v10z" fill="#F0B90B"/></svg>');
  });

  it("renames many ids in one pass", () => {
    // A pass per id read the whole markup once for each of them.
    const markup = `<svg>${Array.from({ length: 40_000 }, (_, index) => `<g id="g${index}"/><use href="#g${index}"/>`).join("")}</svg>`;
    const canonical = canonicalSvgMarkup(markup);
    expect(canonical.startsWith('<svg><g id="i0"/><use href="#i0"/><g id="i1"/>')).toBe(true);
    expect(canonical.endsWith('<g id="i39999"/><use href="#i39999"/></svg>')).toBe(true);
  });
});

describe("withoutRootSize", () => {
  it("drops the root's width and height when it has a viewBox, in either quote style", () => {
    expect(withoutRootSize(`<svg width='12.5' viewBox="0 0 10 10" height="8"><rect width="10" height="10"/></svg>`))
      .toBe('<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>');
    expect(withoutRootSize('<?xml version="1.0"?>\n<svg viewbox="0 0 10 10" width="20" height="20"/>'))
      .toBe('<?xml version="1.0"?>\n<svg viewbox="0 0 10 10"/>');
  });

  it("keeps them without a viewBox, where they set the coordinate system", () => {
    const markup = '<svg width="20" height="20"><rect width="10" height="10"/></svg>';
    expect(withoutRootSize(markup)).toBe(markup);
  });

  it("leaves other size-like attributes and the children alone", () => {
    const markup = '<svg viewBox="0 0 10 10" stroke-width="2" data-width="4"><rect width="10" height="10"/></svg>';
    expect(withoutRootSize(markup)).toBe(markup);
  });
});
