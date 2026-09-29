import { describe, expect, it } from "vitest";
import { parseSrcset } from "./srcset";

describe("parseSrcset", () => {
  it("keeps commas inside URLs and reads descriptors", () => {
    expect(parseSrcset("https://res.cloudinary.com/x/image/upload/w_500,c_fill/a.jpg 500w, /b.jpg 1000w")).toEqual([
      { url: "https://res.cloudinary.com/x/image/upload/w_500,c_fill/a.jpg", w: 500 },
      { url: "/b.jpg", w: 1000 },
    ]);
    expect(parseSrcset("a.png, b.png 2x")).toEqual([{ url: "a.png", x: 1 }, { url: "b.png", x: 2 }]);
    expect(parseSrcset("")).toEqual([]);
  });

  it("reads fractional densities, trailing commas and extra whitespace", () => {
    expect(parseSrcset("  a.png 1.5x ,b.png,  ")).toEqual([{ url: "a.png", x: 1.5 }, { url: "b.png", x: 1 }]);
    expect(parseSrcset("a.png 100w 50h, b.png")).toEqual([{ url: "a.png", w: 100 }, { url: "b.png", x: 1 }]);
  });

  it("reads a URL of a long comma run that does not end it", () => {
    // `,+$` tried from every comma of the run: 400,000 of them took minutes in the page.
    const url = `a${",".repeat(400_000)}b.png`;
    expect(parseSrcset(`${url} 2x`)).toEqual([{ url, x: 2 }]);
    expect(parseSrcset("a.png,,, b.png")).toEqual([{ url: "a.png", x: 1 }, { url: "b.png", x: 1 }]);
  });

  it("stays fast on a long digit run in a descriptor", () => {
    // An unbounded `\d*\.?\d+` in the x descriptor is cubic in the descriptor length: 4000 digits took 8 seconds.
    const started = performance.now();
    expect(parseSrcset(`a.png ${"9".repeat(4_000)}y`)).toEqual([{ url: "a.png", x: 1 }]);
    expect(performance.now() - started).toBeLessThan(200);
  });
});
