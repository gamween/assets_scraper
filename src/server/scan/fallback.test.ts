import { describe, expect, it } from "vitest";
import { officialWebsiteIris } from "./fallback";

describe("officialWebsiteIris", () => {
  it("lists every form Wikidata may hold for the host, with and without www", () => {
    const iris = ["<https://example.com/>", "<https://example.com>", "<https://www.example.com/>", "<https://www.example.com>", "<http://example.com/>", "<http://example.com>", "<http://www.example.com/>", "<http://www.example.com>"];
    expect(officialWebsiteIris("www.Example.com")).toEqual(iris);
    expect(officialWebsiteIris("example.com")).toEqual(iris);
    expect(officialWebsiteIris("xn--mnchen-3ya.de")).toContain("<https://xn--mnchen-3ya.de/>");
  });

  it("gives nothing for a host that cannot go into an IRI as it is", () => {
    for (const host of ["[::1]", "", "a b.com", "example.com>", "exa\"mple.com", "example..com"]) expect(officialWebsiteIris(host)).toEqual([]);
  });
});
