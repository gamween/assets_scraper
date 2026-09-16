import { describe, expect, it } from "vitest";
import { normHex, svgColors } from "./extras";

describe("normHex", () => {
  it("normalizes 3, 4, 6 and 8 digit hex, with or without #", () => {
    expect(normHex("#ABC")).toBe("#aabbcc");
    expect(normHex("#abcd")).toBe("#aabbcc");
    expect(normHex("0052FF")).toBe("#0052ff");
    expect(normHex(" #0052ff80 ")).toBe("#0052ff");
  });

  it("rejects anything else", () => {
    for (const value of ["", "#12345", "#1234567", "red", "rgb(0,0,0)", "#ggg", 12, null, undefined, {}]) expect(normHex(value)).toBeNull();
  });
});

describe("svgColors", () => {
  it("counts fill, stroke and stop colors from attributes and CSS", () => {
    const svg = `<svg><style>.a{fill:#FF0000}</style><path class="a"/><path fill="#ff0000"/><rect stroke='#0f0'/>
      <stop offset="0" stop-color="rgb(0, 0, 255)"/><circle fill="white"/><path fill="url(#g)"/><path fill="none"/></svg>`;
    const colors = new Map(svgColors(svg));
    expect([...colors.keys()].sort()).toEqual(["#0000ff", "#00ff00", "#ff0000", "#ffffff"]);
    expect(colors.get("#ff0000")).toBeCloseTo(400);
    expect(colors.get("#00ff00")).toBeCloseTo(200);
    expect([...colors.values()].reduce((a, b) => a + b, 0)).toBeCloseTo(1000);
  });

  it("drops the alpha of 4 and 8 digit hex", () => {
    expect(svgColors(`<path fill="#f00c"/><path fill="#00ff0080"/>`)).toEqual([["#ff0000", 500], ["#00ff00", 500]]);
  });

  it("treats shapes without any color as black", () => {
    expect(svgColors(`<svg><path d="M0 0h1v1z"/></svg>`)).toEqual([["#000000", 1000]]);
    expect(svgColors(`<svg><path fill="currentColor"/></svg>`)).toEqual([["#000000", 1000]]);
    expect(svgColors(`<svg></svg>`)).toEqual([]);
  });
});
