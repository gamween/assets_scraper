import { describe, expect, it } from "vitest";
import { colourRuns, commonStyle, drawnWeight, firstFamily, isGenericHomeLabel, isSetApart, px, type TextStyle } from "./wordmark";

describe("colourRuns", () => {
  it("reads investirday.fr's home link as two runs on two lines, without the zero-width span at the end", () => {
    expect(
      colourRuns([
        { text: "Investir", hex: "#130d21" },
        { text: "Day ", hex: "#fb2189", newLine: true },
        { text: "​", hex: "#fb2189" },
      ]),
    ).toEqual([
      { text: "Investir\n", hex: "#130d21" },
      { text: "Day", hex: "#fb2189" },
    ]);
  });

  it("keeps one space where the page has white space between two pieces, and merges neighbours of one colour", () => {
    expect(
      colourRuns([
        { text: "  Acme", hex: "#111111" },
        { text: "\n   ", hex: "" },
        { text: "Labs", hex: "#111111" },
        { text: " Studio  ", hex: "#ff0000" },
      ]),
    ).toEqual([
      { text: "Acme Labs ", hex: "#111111" },
      { text: "Studio", hex: "#ff0000" },
    ]);
  });

  it("gives nothing for white space and invisible characters alone", () => {
    expect(colourRuns([{ text: " ­﻿ ", hex: "#000000" }])).toEqual([]);
  });
});

describe("isGenericHomeLabel", () => {
  it("knows a menu item or a skip link that leads home, in any case and a few languages", () => {
    for (const text of ["Home", "HOME", "Homepage", "Back to home", "Accueil", "Retour à l'accueil", "Inicio", "Startseite", "Skip to main content", "← Home", "Menu"]) {
      expect(isGenericHomeLabel(text), text).toBe(true);
    }
  });

  it("leaves names alone, one that holds a generic word included", () => {
    for (const text of ["InvestirDay", "Home Depot", "Accueil Paysan", "Framer", "Julia Evans"]) {
      expect(isGenericHomeLabel(text), text).toBe(false);
    }
  });
});

describe("the typography readers", () => {
  it("takes the weight a variable font is drawn at over font-weight", () => {
    // framer.com: `font-variation-settings: "opsz" 32, "wght" 600` on text whose computed font-weight reads 400.
    expect(drawnWeight("400", `"opsz" 32, "wght" 600`)).toBe(600);
    expect(drawnWeight("700", "normal")).toBe(700);
    expect(drawnWeight("bold", "normal")).toBe(400);
  });

  it("reads computed lengths and the first family of a stack", () => {
    expect(px("1.2px")).toBe(1.2);
    expect(px("normal")).toBe(0);
    expect(firstFamily(`"Inter Variable", "Inter Variable Placeholder", sans-serif`)).toBe("inter variable");
    expect(firstFamily("Inter, system-ui, sans-serif")).toBe("inter");
  });
});

describe("isSetApart", () => {
  const nav: TextStyle = { family: "inter", weight: 500, size: 13, letterSpacing: 0, transform: "none" };

  it("takes investirday.fr's home link, set apart five ways and beside its monogram", () => {
    const own: TextStyle = { family: "inter", weight: 700, size: 12, letterSpacing: 1.2, transform: "uppercase" };
    expect(isSetApart(own, nav, true)).toBe(true);
    expect(isSetApart(own, nav, false)).toBe(true);
  });

  it("takes any one difference: family, a weight of 600 its neighbours lack, tracking, case, a 10 percent larger size", () => {
    expect(isSetApart({ ...nav, family: "montserrat" }, nav, false)).toBe(true);
    expect(isSetApart({ ...nav, weight: 600 }, nav, false)).toBe(true);
    expect(isSetApart({ ...nav, letterSpacing: 0.3 }, nav, false)).toBe(true);
    expect(isSetApart({ ...nav, transform: "uppercase" }, nav, false)).toBe(true);
    expect(isSetApart({ ...nav, size: 14.5 }, nav, false)).toBe(true);
  });

  it("leaves a home link set like the menu it sits in, a bold, tracked and capitalised menu included", () => {
    expect(isSetApart({ ...nav }, nav, false)).toBe(false);
    expect(isSetApart({ ...nav, size: 14, letterSpacing: 0.2 }, nav, false)).toBe(false);
    // gymshark.com and allbirds.com set their whole menu in heavy, tracked capitals.
    const heavy: TextStyle = { family: "geograph", weight: 700, size: 12, letterSpacing: 0.6, transform: "uppercase" };
    expect(isSetApart({ ...heavy }, heavy, false)).toBe(false);
    expect(isSetApart({ ...heavy, weight: 500 }, heavy, false)).toBe(false);
  });
});

describe("commonStyle", () => {
  it("takes the style most links share, the first on a tie, and nothing from no links", () => {
    const menu: TextStyle = { family: "inter", weight: 400, size: 14, letterSpacing: 0, transform: "none" };
    const button: TextStyle = { ...menu, weight: 600 };
    expect(commonStyle([button, menu, menu, button, menu])).toEqual(menu);
    expect(commonStyle([button, menu])).toEqual(button);
    expect(commonStyle([])).toBeUndefined();
  });
});
