import { describe, expect, it } from "vitest";
import { classifySource, decodeDataUri, remoteUrl } from "./files";

describe("decodeDataUri", () => {
  it("decodes base64 and percent-encoded payloads", () => {
    expect(decodeDataUri("data:font/woff2;base64,d09GMg==")).toEqual({ mime: "font/woff2", bytes: Buffer.from("wOF2") });
    expect(decodeDataUri("data:application/x-font-woff;charset=utf-8,w%4FF2%00%FF")).toEqual({
      mime: "application/x-font-woff",
      bytes: Buffer.from([0x77, 0x4f, 0x46, 0x32, 0x00, 0xff]),
    });
    expect(decodeDataUri("data:;BASE64,%64%30%39GMg==")).toEqual({ mime: "", bytes: Buffer.from("wOF2") });
    expect(decodeDataUri("data:font/woff2;base64,d09G\n Mg==")?.bytes).toEqual(Buffer.from("wOF2"));
  });

  it("gives null without a payload", () => {
    expect(decodeDataUri("data:font/woff2;base64,")).toBeNull();
    expect(decodeDataUri("data:font/woff2")).toBeNull();
    expect(decodeDataUri("https://x.example/a.woff2")).toBeNull();
  });
});

describe("classifySource", () => {
  it.each([
    ["https://fonts.gstatic.com/s/inter/v13/a.woff2", "www.site.example", "google-fonts"],
    ["https://use.typekit.net/af/1/l?fvd=n4", "www.site.example", "adobe-fonts"],
    ["https://p.typekit.net/p.css", "site.example", "adobe-fonts"],
    ["https://cdn.site.example/f.woff2", "www.site.example", "self-hosted"],
    ["https://assets.shop.co.uk/f.woff2", "www.shop.co.uk", "self-hosted"],
    ["https://assets.other.co.uk/f.woff2", "www.shop.co.uk", "third-party"],
    ["https://b.stripecdn.com/f.woff2", "stripe.com", "third-party"],
    ["http://127.0.0.1:3000/f.woff2", "127.0.0.1", "self-hosted"],
    ["http://127.0.0.2/f.woff2", "127.0.0.1", "third-party"],
  ])("%s on %s is %s", (url, pageHost, source) => {
    expect(classifySource(url, pageHost)).toEqual({ source, host: new URL(url).hostname });
  });
});

describe("remoteUrl", () => {
  it("resolves http(s) URLs without their fragment", () => {
    expect(remoteUrl("f.svg#icons", "https://s.example/css/a.css")).toBe("https://s.example/css/f.svg");
    expect(remoteUrl("blob:https://s.example/1")).toBeNull();
    expect(remoteUrl("not a url")).toBeNull();
  });
});
