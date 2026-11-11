import { describe, expect, it } from "vitest";
import { LOGO_WORD } from "./logo-word";

describe("LOGO_WORD", () => {
  it("finds the logo words in names", () => {
    for (const name of ["logo", "site-logo", "redstonelogosymbol", "logos-wall", "wordmark", "logotype", "navbar-brand", "w-nav-brand", "brand", "brandmark"]) {
      expect(LOGO_WORD.test(name), name).toBe(true);
    }
  });

  it("leaves out a brand qualifier and the log out and log on buttons", () => {
    for (const name of ["card-brand-content", "branding", "logout", "logout-button", "icon-logon", "logon"]) expect(LOGO_WORD.test(name), name).toBe(false);
  });
});
