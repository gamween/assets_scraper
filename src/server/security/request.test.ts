import { afterEach, describe, expect, it, vi } from "vitest";
import { clientAddress, MAX_BODY_BYTES, readCappedBody, requestMediaType, safeEqual } from "./request";

const post = (body: BodyInit | null, headers: Record<string, string> = {}) =>
  new Request("https://assets.example.com/api/scan", { method: "POST", body, headers });

describe("readCappedBody", () => {
  it("reads a body up to the cap, and an absent one as empty", async () => {
    expect((await readCappedBody(post("{\"url\":\"linear.app\"}")))?.toString()).toBe('{"url":"linear.app"}');
    expect(await readCappedBody(post("x".repeat(MAX_BODY_BYTES)))).toHaveLength(MAX_BODY_BYTES);
    expect(await readCappedBody(new Request("https://assets.example.com/"))).toEqual(Buffer.alloc(0));
  });

  it("refuses a body past the cap, whether content-length says so or lies about it", async () => {
    expect(await readCappedBody(post("x".repeat(MAX_BODY_BYTES + 1)))).toBeNull();
    expect(await readCappedBody(post("x".repeat(MAX_BODY_BYTES + 1), { "content-length": "20" }))).toBeNull();
    expect(await readCappedBody(post("short", { "content-length": String(MAX_BODY_BYTES + 1) }))).toBeNull();
    expect(await readCappedBody(post("0123456789"), 4)).toBeNull();
  });
});

describe("request helpers", () => {
  it("reads the media type without its parameters", () => {
    expect(requestMediaType(post("{}", { "content-type": "Application/JSON; charset=utf-8" }))).toBe("application/json");
    expect(requestMediaType(new Request("https://assets.example.com/"))).toBe("");
  });

  it("compares secrets of any length", () => {
    expect(safeEqual("open-sesame", "open-sesame")).toBe(true);
    expect(safeEqual("open-sesame", "open-sesamE")).toBe(false);
    expect(safeEqual("open", "open-sesame")).toBe(false);
  });
});

describe("clientAddress", () => {
  const from = (address?: string) => new Request("https://assets.example.com/", { headers: address ? { "x-real-ip": address } : {} });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is the address Vercel's edge writes, on Vercel", () => {
    vi.stubEnv("VERCEL", "1");
    expect(clientAddress(from("203.0.113.7"))).toBe("203.0.113.7");
    expect(clientAddress(from())).toBeNull();
  });

  it("is null anywhere else, where x-real-ip is whatever the client sent", () => {
    vi.stubEnv("VERCEL", "");
    expect(clientAddress(from("203.0.113.7"))).toBeNull();
  });
});
