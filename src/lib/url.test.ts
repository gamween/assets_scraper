import { describe, expect, it } from "vitest";
import { normalizeInputUrl } from "./url";

describe("normalizeInputUrl", () => {
  it.each([
    ["linear.app", "https://linear.app/"],
    ["  <https://Linear.app/features>  ", "https://linear.app/features"],
    ['"stripe.com"', "https://stripe.com/"],
    ["https://x.com:443/a", "https://x.com/a"],
    ["http://x.com:80/", "http://x.com/"],
    ["https://user:pw@x.com/", "https://x.com/"],
    ["https://x.com/#/route", "https://x.com/#/route"],
    ["https://x.com/#!/route", "https://x.com/#!/route"],
    ["https://x.com/page#section", "https://x.com/page"],
    ["例え.jp", "https://xn--r8jz45g.jp/"],
    ["linear.app.", "https://linear.app/"],
    ["https://x.com/a).", "https://x.com/a"],
    // wrappers and punctuation
    ["(linear.app)", "https://linear.app/"],
    ["`linear.app`", "https://linear.app/"],
    ["(linear.app).", "https://linear.app/"],
    ["(https://x.com/a).", "https://x.com/a"],
    ["https://en.wikipedia.org/wiki/Foo_(bar)", "https://en.wikipedia.org/wiki/Foo_(bar)"],
    ["https://linear.app.", "https://linear.app/"],
    ["x.com/docs.", "https://x.com/docs"],
    // wrappers before trailing punctuation
    ['"linear.app",', "https://linear.app/"],
    ["<https://x.com>.", "https://x.com/"],
    ["`x.com`.", "https://x.com/"],
    ["'https://x.com/a',", "https://x.com/a"],
    ['("https://x.com/a").', "https://x.com/a"],
    ['"linear.app."', "https://linear.app/"],
    ["linear.app..", "https://linear.app/"],
    // ports 80 and 443 are allowed with either scheme
    ["https://x.com:80/", "https://x.com:80/"],
    ["http://x.com:443/a", "http://x.com:443/a"],
    // IP literals and localhost pass here; the gate blocks them
    ["http://[::1]/", "http://[::1]/"],
    ["[2606:4700:4700::1111]", "https://[2606:4700:4700::1111]/"],
    ["http://0x7f000001/", "http://127.0.0.1/"],
    ["localhost", "https://localhost/"],
    ["my_site.example.com", "https://my_site.example.com/"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeInputUrl(input)).toEqual({ ok: true, url: expected, host: new URL(expected).hostname });
  });

  it("returns IPv6 hosts with their brackets", () => {
    expect(normalizeInputUrl("http://[::1]/")).toMatchObject({ ok: true, host: "[::1]" });
  });

  it("drops the root dot from domain hosts, so every consumer sees one form", () => {
    expect(normalizeInputUrl("https://assets-scraper.vercel.app./")).toEqual({
      ok: true, url: "https://assets-scraper.vercel.app/", host: "assets-scraper.vercel.app",
    });
    expect(normalizeInputUrl("localhost.")).toEqual({ ok: true, url: "https://localhost/", host: "localhost" });
    expect(normalizeInputUrl("https://www.x.com.:443/a?b=1#/c")).toEqual({ ok: true, url: "https://www.x.com/a?b=1#/c", host: "www.x.com" });
    expect(normalizeInputUrl("linear.app./features")).toEqual({ ok: true, url: "https://linear.app/features", host: "linear.app" });
  });

  it.each([
    "", "   ", "ftp://x.com", "javascript:alert(1)", "not a url", "x", "mailto:a@b.c",
    "lin{ear.app", 'a"b.com', "x..com", "-x.com", "https://exa$mple.com", "()", "``",
    // one label once the root dot is gone, or more than one root dot
    "x.", ".", "https://intranet./", "linear.app../features",
  ])("rejects %j", (input) => {
    expect(normalizeInputUrl(input)).toEqual({ ok: false, code: "invalid-url" });
  });

  it("rejects non-default ports", () => {
    expect(normalizeInputUrl("http://x.com:8080")).toEqual({ ok: false, code: "unsupported-port" });
    expect(normalizeInputUrl("localhost:3000")).toEqual({ ok: false, code: "unsupported-port" });
    expect(normalizeInputUrl("[::1]:8443")).toEqual({ ok: false, code: "unsupported-port" });
  });
});
