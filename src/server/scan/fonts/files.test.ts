import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { classifySource, createFileLookup, decodeDataUri, MAX_INLINE_BYTES, remoteUrl } from "./files";

const MIB = 1024 * 1024;
const font = readFileSync(path.join(process.cwd(), "tests/fixtures/site/assets/jbm-cyr.woff2"));

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

describe("createFileLookup", () => {
  it("sniffs the format of a data: URI from the first 4 KiB of its payload at most", () => {
    const lookup = createFileLookup(new Map(), "www.site.example");
    const spaced = (spaces: number) => `data:font/woff2;base64,${" ".repeat(spaces)}${font.toString("base64")}`;
    expect(lookup.file(spaced(0))).toMatchObject({ url: "", format: "woff2", source: "data-uri" });
    expect(lookup.file(spaced(4_000))).toMatchObject({ format: "woff2" });
    expect(lookup.file(spaced(4_096))).toBeNull();
  });

  it("decodes a data: URI only when its estimated size fits in what is left of the byte budget", () => {
    const lookup = createFileLookup(new Map(), "www.site.example");
    // Distinct URIs of `bytes` bytes that start with a WOFF2 signature, base64 or percent-encoded
    const base64 = (bytes: number, index: number) => `data:font/woff2;v=${index};base64,${Buffer.concat([font, Buffer.alloc(bytes - font.length)]).toString("base64")}`;
    const escaped = (bytes: number) => `data:font/woff2,${[...Buffer.concat([font, Buffer.alloc(bytes - font.length)])].map((byte) => `%${byte.toString(16).padStart(2, "0")}`).join("")}`;
    const from = vi.spyOn(Buffer, "from");
    const longestDecoded = () => Math.max(0, ...from.mock.calls.map(([value]: unknown[]) => (typeof value === "string" ? value.length : 0)));
    try {
      // 2 MiB left
      expect(lookup.take(lookup.file(base64(MAX_INLINE_BYTES - 2 * MIB, 0))!)).toBe(true);
      const tooLarge = [base64(2 * MIB + 1, 1), base64(2 * MIB + 2, 2)].map((uri) => lookup.file(uri)!);
      from.mockClear();
      for (const file of tooLarge) expect(lookup.take(file)).toBe(false);
      expect(longestDecoded()).toBeLessThan(8_000);
      // an estimate never refuses what fits: an exact base64 size, and escapes that encode every byte
      expect(lookup.take(lookup.file(escaped(MIB))!)).toBe(true);
      expect(lookup.take(lookup.file(base64(MIB, 3))!)).toBe(true);
      expect(lookup.take(lookup.file(base64(font.length, 4))!)).toBe(false);
    } finally {
      from.mockRestore();
    }
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
