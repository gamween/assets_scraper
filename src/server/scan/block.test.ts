import { describe, expect, it } from "vitest";
import { detectBlock, detectChallenge } from "./block";

const base = { status: 200, title: "Home", html: "<html></html>", headers: {}, elementCount: 400 };

describe("detectBlock", () => {
  it("flags Cloudflare's mitigation header", () => expect(detectBlock({ ...base, headers: { "cf-mitigated": "challenge" } })).toBe("cloudflare-challenge"));

  it.each(["Just a moment...", "Access to this page has been denied", "Please verify you are a human", "Attention Required! | Cloudflare"])("flags title %s", (title) =>
    expect(detectBlock({ ...base, title })).toBe("challenge-title"));

  it.each(["Access Denied", "Are you a robot?", "Verify you are human", "Pardon Our Interruption", "Request unsuccessful. Incapsula incident ID", "Security check", "One more step", "Checking your browser before accessing"])(
    "flags the other challenge title %s",
    (title) => expect(detectBlock({ ...base, title })).toBe("challenge-title"),
  );

  it("flags challenge markup on small or failed pages only", () => {
    const html = '<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script>';
    expect(detectBlock({ ...base, html, elementCount: 40 })).toBe("challenge-markup");
    expect(detectBlock({ ...base, html, elementCount: 297 })).toBeNull(); // medium.com false positive
    expect(detectBlock({ ...base, html, elementCount: 900, status: 400 })).toBe("challenge-markup");
    for (const marker of ["cf-chl-widget", "geo.captcha-delivery.com", "px-captcha", "_Incapsula_Resource", "client.perimeterx.net", "window._pxAppId", "ak-challenge", "sec-cpt-if"])
      expect(detectBlock({ ...base, html: marker, elementCount: 20 })).toBe("challenge-markup");
  });

  it("flags captcha-only pages and forbidden small pages", () => {
    expect(detectBlock({ ...base, html: "hcaptcha", elementCount: 50 })).toBe("captcha-only-page");
    expect(detectBlock({ ...base, html: "g-recaptcha", elementCount: 79 })).toBe("captcha-only-page");
    expect(detectBlock({ ...base, html: "cf-turnstile", elementCount: 60 })).toBe("captcha-only-page");
    expect(detectBlock({ ...base, html: "recaptcha", elementCount: 80 })).toBeNull();
    expect(detectBlock({ ...base, status: 403, elementCount: 120 })).toBe("http-403");
    expect(detectBlock({ ...base, status: 429, elementCount: 10 })).toBe("http-429");
    expect(detectBlock({ ...base, status: 503, elementCount: 299 })).toBe("http-503");
    expect(detectBlock({ ...base, status: 403, elementCount: 900 })).toBeNull();
    expect(detectBlock({ ...base, status: 404, elementCount: 10 })).toBeNull();
  });

  it("reads header names in any case and leaves normal pages alone", () => {
    expect(detectBlock({ ...base, headers: { "CF-Mitigated": "challenge" } })).toBe("cloudflare-challenge");
    expect(detectBlock({ ...base, headers: { "cf-mitigated": "none" } })).toBeNull();
    expect(detectBlock(base)).toBeNull();
  });
});

describe("detectChallenge", () => {
  it("applies only the header and title rules, which hold before the page has loaded", () => {
    expect(detectChallenge({ title: "Home", headers: { "CF-Mitigated": "challenge" } })).toBe("cloudflare-challenge");
    expect(detectChallenge({ title: "Just a moment...", headers: {} })).toBe("challenge-title");
    expect(detectChallenge({ title: "Home", headers: {} })).toBeNull();
    // An app shell at domcontentloaded: few elements, Cloudflare's script and reCAPTCHA v3. Only detectBlock, once the
    // page has loaded, may look at the markup and the element count.
    const shell = { ...base, elementCount: 12, html: '<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script><script src="https://www.google.com/recaptcha/api.js"></script>' };
    expect(detectChallenge(shell)).toBeNull();
    expect(detectBlock(shell)).toBe("challenge-markup");
  });
});

