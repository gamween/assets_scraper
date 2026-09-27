import { describe, expect, it } from "vitest";
import { decodeDataUri, scanIdFor } from "./source-local";

describe("scanIdFor", () => {
  it("names a scan after the host and the time, and the cache accepts it", () => {
    expect(scanIdFor("www.Stripe.com", 1_759_000_000_000)).toMatch(/^stripe\.com-[0-9a-z]+-[0-9a-f]{6}$/);
    expect(scanIdFor("127.0.0.1:8787")).toMatch(/^127\.0\.0\.1-8787-/);
    expect(scanIdFor("")).toMatch(/^site-/);
    expect(scanIdFor("a".repeat(400)).length).toBeLessThanOrEqual(120);
  });
});

describe("decodeDataUri", () => {
  it("reads base64 and percent encoded payloads", () => {
    expect(decodeDataUri("data:font/woff2;base64,aGVsbG8=").toString("utf8")).toBe("hello");
    expect(decodeDataUri("data:image/svg+xml,%3Csvg%2F%3E").toString("utf8")).toBe("<svg/>");
    expect(decodeDataUri("data:,plain").toString("utf8")).toBe("plain");
    expect(() => decodeDataUri("data:image/png;base64")).toThrow(/malformed/);
  });
});
