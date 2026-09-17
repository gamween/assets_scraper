import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@/server/errors";
import { createSigner, SignLimitError, verifyAssetParams } from "./sign";

const secret = "test-secret-with-enough-entropy-0123456789";
const now = Date.UTC(2026, 8, 16, 12, 30);

const paramsOf = (path: string) => new URL(path, "https://app.local").searchParams;

function statusOf(fn: () => unknown): number | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof HttpError ? error.status : -1;
  }
  return undefined;
}

describe("sign", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("round-trips and keeps the same path within an hour", () => {
    const signer = createSigner({ secret, now });
    const a = signer.sign("https://cdn.example.com/logo.svg");
    const b = createSigner({ secret, now: now + 10 * 60_000 }).sign("https://cdn.example.com/logo.svg");
    expect(a).toBe(b);
    const params = new URL(a, "https://app.local").searchParams;
    expect(verifyAssetParams(params, now, secret)).toEqual({ url: "https://cdn.example.com/logo.svg" });
  });

  it("rejects tampering, expiry and unknown params", () => {
    const params = new URL(createSigner({ secret, now }).sign("https://a.com/x.png"), "https://app.local").searchParams;
    const tampered = new URLSearchParams(params);
    tampered.set("u", Buffer.from("https://evil.com/x.png").toString("base64url"));
    expect(() => verifyAssetParams(tampered, now, secret)).toThrow(HttpError);
    expect(() => verifyAssetParams(params, now + 8 * 3_600_000, secret)).toThrow(HttpError);
    const extra = new URLSearchParams(params);
    extra.set("x", "1");
    expect(() => verifyAssetParams(extra, now, secret)).toThrow(HttpError);
  });

  it("accepts dl and fmt=ttf, rejects other fmt", () => {
    const params = new URL(createSigner({ secret, now }).sign("https://a.com/f.woff2"), "https://app.local").searchParams;
    params.set("dl", "inter.woff2");
    params.set("fmt", "ttf");
    expect(verifyAssetParams(params, now, secret)).toEqual({ url: "https://a.com/f.woff2", dl: "inter.woff2", fmt: "ttf" });
    params.set("fmt", "png");
    expect(() => verifyAssetParams(params, now, secret)).toThrow(HttpError);
  });

  it("caps signed URLs per scan", () => {
    const signer = createSigner({ secret, now, max: 2 });
    signer.sign("https://a.com/1");
    signer.sign("https://a.com/2");
    expect(() => signer.sign("https://a.com/3")).toThrow(SignLimitError);
    expect(signer.count).toBe(2);
  });

  it("uses the documented path, MAC and hour-bucketed expiry of 6 to 7 hours", () => {
    const path = createSigner({ secret, now }).sign("https://cdn.example.com/logo.svg");
    const params = paramsOf(path);
    expect(path.startsWith("/api/asset?u=")).toBe(true);
    expect([...params.keys()]).toEqual(["u", "e", "s"]);
    expect(Number(params.get("e"))).toBe(Date.UTC(2026, 8, 16, 19) / 1000);
    expect(params.get("s")).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(verifyAssetParams(params, Date.UTC(2026, 8, 16, 18, 59), secret).url).toBe("https://cdn.example.com/logo.svg");
    expect(statusOf(() => verifyAssetParams(params, Date.UTC(2026, 8, 16, 19), secret))).toBe(403);
    expect(statusOf(() => verifyAssetParams(params, now, "another-secret-with-enough-entropy-000"))).toBe(403);
  });

  it("counts each distinct URL once", () => {
    const signer = createSigner({ secret, now, max: 1 });
    const first = signer.sign("https://a.com/1");
    expect(signer.sign("https://a.com/1")).toBe(first);
    expect(signer.count).toBe(1);
  });

  it("answers 400 to missing, repeated, malformed or non-canonical params and to non-http URLs", () => {
    const valid = paramsOf(createSigner({ secret, now }).sign("https://a.com/x.png"));
    const variant = (edit: (p: URLSearchParams) => void) => {
      const copy = new URLSearchParams(valid);
      edit(copy);
      return copy;
    };
    expect(statusOf(() => verifyAssetParams(new URLSearchParams(), now, secret))).toBe(400);
    expect(statusOf(() => verifyAssetParams(variant((p) => p.delete("s")), now, secret))).toBe(400);
    expect(statusOf(() => verifyAssetParams(variant((p) => p.append("u", p.get("u") ?? "")), now, secret))).toBe(400);
    expect(statusOf(() => verifyAssetParams(variant((p) => p.set("e", "1e10")), now, secret))).toBe(400);
    expect(statusOf(() => verifyAssetParams(variant((p) => p.set("s", "short")), now, secret))).toBe(400);
    expect(statusOf(() => verifyAssetParams(variant((p) => p.set("u", `${p.get("u")}==`)), now, secret))).toBe(400);
    expect(statusOf(() => verifyAssetParams(variant((p) => p.set("dl", "")), now, secret))).toBe(400);
    expect(statusOf(() => verifyAssetParams(variant((p) => p.set("dl", "x".repeat(256))), now, secret))).toBe(400);

    const javascript = paramsOf(createSigner({ secret, now }).sign("javascript:alert(1)"));
    expect(statusOf(() => verifyAssetParams(javascript, now, secret))).toBe(400);
  });

  it("uses a random per-process key outside production and requires ASSET_URL_SECRET in production", () => {
    vi.stubEnv("ASSET_URL_SECRET", "");
    const path = createSigner({ now }).sign("https://a.com/dev.png");
    expect(verifyAssetParams(paramsOf(path), now).url).toBe("https://a.com/dev.png");
    expect(statusOf(() => verifyAssetParams(paramsOf(path), now, secret))).toBe(403);

    vi.stubEnv("NODE_ENV", "production");
    expect(() => createSigner({ now }).sign("https://a.com/prod.png")).toThrow(/ASSET_URL_SECRET/);
    vi.stubEnv("ASSET_URL_SECRET", "too-short");
    expect(() => createSigner({ now }).sign("https://a.com/prod.png")).toThrow(/ASSET_URL_SECRET/);
    vi.stubEnv("ASSET_URL_SECRET", secret);
    const prod = createSigner({ now }).sign("https://a.com/prod.png");
    expect(verifyAssetParams(paramsOf(prod), now, secret).url).toBe("https://a.com/prod.png");
    expect(verifyAssetParams(paramsOf(prod), now).url).toBe("https://a.com/prod.png");
  });

  it("validates params before it needs the secret", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ASSET_URL_SECRET", "");
    expect(statusOf(() => verifyAssetParams(new URLSearchParams("u=x"), now))).toBe(400);
  });
});
