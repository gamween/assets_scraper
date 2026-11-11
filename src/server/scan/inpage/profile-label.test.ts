import { describe, expect, it } from "vitest";
import { labelNamesOnlyTheLink } from "./profile-label";

const webflow = "https://cdn.prod.website-files.com/66f11b59c8366f8c2c215596";

describe("labelNamesOnlyTheLink", () => {
  it("leaves a profile action to the link when the picture's own names say it is something else", () => {
    // raisesummit.com: each speaker card is a link labelled "Open LinkedIn" around a headshot and a company logo,
    // both with an empty alt.
    expect(labelNamesOnlyTheLink("Open LinkedIn", ["", `${webflow}/6a0ef2217fea771d7e7210bf_cognition-logo-new.svg`])).toBe(true);
    expect(labelNamesOnlyTheLink("Open LinkedIn", ["", `${webflow}/69a716bbfae69f1942b8677d_image%20(8).avif`])).toBe(true);
    for (const label of ["Follow us on X", "View profile", "LinkedIn profile", "Check out my LinkedIn", "Go to the profile page", "Watch on YouTube"]) {
      expect(labelNamesOnlyTheLink(label, ["Broadcom-logo.svg"]), label).toBe(true);
    }
    // An alt or a title of its own that names something else counts like the file name.
    expect(labelNamesOnlyTheLink("Follow us on X", ["Acme logo", null])).toBe(true);
  });

  it("keeps the label on the network's own mark", () => {
    for (const name of ["linkedin.svg", "LinkedInIcon.svg", "icon-li.png", "LinkedIn"]) {
      expect(labelNamesOnlyTheLink("Follow us on LinkedIn", [name]), name).toBe(false);
    }
    for (const name of ["x-logo.svg", "icon-twitter-white.png"]) expect(labelNamesOnlyTheLink("Follow us on X", [name]), name).toBe(false);
    expect(labelNamesOnlyTheLink("View profile", ["profile-photo.jpg"])).toBe(false);
    // An inline vector with no name of its own: nothing says it is not the LinkedIn icon.
    expect(labelNamesOnlyTheLink("Follow us on LinkedIn", [])).toBe(false);
    expect(labelNamesOnlyTheLink("Follow us on LinkedIn", [null, "", " "])).toBe(false);
    // A short alias has to be a word: "fixture" is not "x".
    expect(labelNamesOnlyTheLink("Follow us on X", ["fixture.png"])).toBe(true);
  });

  it("does not touch a label that names something besides the network", () => {
    // apple.com's TV tiles are named by the label of their link, and "Stream now" is no social network.
    for (const label of [
      "Stream now, Stick - Comedy - New season.",
      "Play now, Hello Kitty Island Adventure",
      "Watch now, Join the Team with “Ted Lasso”",
      "Scott Wu on LinkedIn",
      "LinkedIn",
      "Follow",
      "Open menu",
      "Home",
    ]) {
      expect(labelNamesOnlyTheLink(label, ["220x54.png"]), label).toBe(false);
    }
    expect(labelNamesOnlyTheLink("Follow us on LinkedIn and X and GitHub and Discord today", ["acme.svg"])).toBe(false);
  });
});
