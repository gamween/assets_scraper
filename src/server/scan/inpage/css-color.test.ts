import { describe, expect, it } from "vitest";
import { colorReader, COLOR_TOKEN_RE, over, toHex, type RGBA } from "./css-color";

/**
 * A stand-in for the canvas: the browser converts lab() and oklch() to sRGB, which Node cannot. The values are what
 * Chrome's canvas gave for investirday.fr's two wordmark colours, whose computed style holds them as lab().
 */
const PAINTED: Record<string, RGBA> = {
  "lab(4.8647 5.89541 -12.118)": [19, 13, 33, 1],
  "lab(56.2517 80.3767 1.26251)": [251, 33, 137, 1],
  "oklch(0.5 0.2 300 / 0.5)": [120, 40, 200, 0.5],
};

const reader = () => {
  const painted: string[] = [];
  const parse = colorReader((value) => {
    painted.push(value);
    return PAINTED[value] ?? null;
  });
  return { parse, painted };
};

describe("colorReader", () => {
  it("reads rgb() and rgba() itself, alpha in either notation", () => {
    const { parse, painted } = reader();
    expect(parse("rgb(19, 13, 33)")).toEqual([19, 13, 33, 1]);
    expect(parse("rgba(0, 0, 0, 0.8)")).toEqual([0, 0, 0, 0.8]);
    expect(parse("rgb(255 255 255 / 50%)")).toEqual([255, 255, 255, 0.5]);
    expect(painted).toEqual([]);
  });

  it("hands lab() and oklch() to the painter, once per string", () => {
    const { parse, painted } = reader();
    expect(parse("lab(56.2517 80.3767 1.26251)")).toEqual([251, 33, 137, 1]);
    expect(parse("  lab(56.2517 80.3767 1.26251) ")).toEqual([251, 33, 137, 1]);
    expect(parse("oklch(0.5 0.2 300 / 0.5)")).toEqual([120, 40, 200, 0.5]);
    expect(painted).toEqual(["lab(56.2517 80.3767 1.26251)", "oklch(0.5 0.2 300 / 0.5)"]);
  });

  it("reads no colour from none, transparent, currentcolor, a colour under 2 percent alpha or what the browser refuses", () => {
    const { parse } = reader();
    for (const value of [undefined, null, "", "none", "transparent", "currentcolor", "rgba(0, 0, 0, 0)", "rgba(10, 10, 10, 0.01)", "not-a-colour"]) {
      expect(parse(value), String(value)).toBeNull();
    }
  });

  it("clamps channels a raw string pushes past 255", () => {
    const { parse } = reader();
    expect(parse("rgb(300, 12, 999)")).toEqual([255, 12, 255, 1]);
  });
});

describe("over, toHex and the colour tokens", () => {
  it("composes a translucent colour over its backdrop and writes it as #rrggbb", () => {
    expect(toHex([19, 13, 33, 1])).toBe("#130d21");
    expect(toHex(over([0, 0, 0, 0.5], 1, [255, 255, 255]))).toBe("#808080");
    expect(toHex(over([0, 0, 0, 1], 0.5, [255, 255, 255]))).toBe("#808080");
  });

  it("finds the stops of a gradient in the order they are written", () => {
    expect("linear-gradient(45deg, rgb(34, 34, 34), oklch(0.6 0.2 350) 40%, #fff)".match(COLOR_TOKEN_RE)).toEqual([
      "rgb(34, 34, 34)",
      "oklch(0.6 0.2 350)",
      "#fff",
    ]);
  });
});
