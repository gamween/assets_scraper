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
    ["linear.app.", "https://linear.app./"],
    ["https://x.com/a).", "https://x.com/a"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeInputUrl(input)).toEqual({ ok: true, url: expected, host: new URL(expected).hostname });
  });

  it.each(["", "   ", "ftp://x.com", "javascript:alert(1)", "not a url", "x", "mailto:a@b.c"])("rejects %j", (input) => {
    expect(normalizeInputUrl(input)).toEqual({ ok: false, code: "invalid-url" });
  });

  it("rejects non-default ports", () => {
    expect(normalizeInputUrl("http://x.com:8080")).toEqual({ ok: false, code: "unsupported-port" });
    expect(normalizeInputUrl("localhost:3000")).toEqual({ ok: false, code: "unsupported-port" });
  });
});
