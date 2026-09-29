import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@/server/errors";
import { createSigner, SignLimitError, verifyAssetParams } from "./sign";

const secret = "test-secret-with-enough-entropy-0123456789";
const now = Date.UTC(2026, 8, 16, 12, 30);

const paramsOf = (path: string) => new URL(path, "https://app.local").searchParams;
/** The query of a path as a request carries it, `?` included. */
const queryOf = (path: string) => new URL(path, "https://app.local").search;
/** The query of `path` with its params edited, each left where the signer put it. */
const edited = (path: string, edit: (params: URLSearchParams) => void): string => {
  const params = paramsOf(path);
  edit(params);
  return `?${params}`;
};

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
    expect(verifyAssetParams(queryOf(a), now, secret)).toEqual({ url: "https://cdn.example.com/logo.svg", expiry: Date.UTC(2026, 8, 16, 19) / 1000 });
  });

  it("rejects tampering, expiry and unknown params", () => {
    const path = createSigner({ secret, now }).sign("https://a.com/x.png");
    const tampered = edited(path, (p) => p.set("u", Buffer.from("https://evil.com/x.png").toString("base64url")));
    expect(statusOf(() => verifyAssetParams(tampered, now, secret))).toBe(403);
    expect(statusOf(() => verifyAssetParams(queryOf(path), now + 8 * 3_600_000, secret))).toBe(403);
    expect(statusOf(() => verifyAssetParams(`${queryOf(path)}&x=1`, now, secret))).toBe(400);
  });

  it("accepts a signed dl and fmt=ttf, rejects other fmt", () => {
    const path = createSigner({ secret, now }).sign("https://a.com/f.woff2", "inter.woff2");
    expect(verifyAssetParams(`${queryOf(path)}&fmt=ttf`, now, secret)).toMatchObject({ url: "https://a.com/f.woff2", dl: "inter.woff2", fmt: "ttf" });
    expect(statusOf(() => verifyAssetParams(`${queryOf(path)}&fmt=png`, now, secret))).toBe(400);
  });

  it("covers dl with the signature, since it is part of the CDN cache key", () => {
    // An unsigned name turns one signed link into unlimited cache misses, each a fresh invocation and upstream fetch.
    const signer = createSigner({ secret, now });
    const plain = signer.sign("https://a.com/x.png");
    expect(verifyAssetParams(queryOf(plain), now, secret)).not.toHaveProperty("dl");
    expect(statusOf(() => verifyAssetParams(`${queryOf(plain)}&dl=x.png`, now, secret))).toBe(403);

    const named = signer.sign("https://a.com/x.png", "Logo dark.png");
    expect(paramsOf(named).get("dl")).toBe("Logo dark.png");
    expect(paramsOf(named).get("s")).not.toBe(paramsOf(plain).get("s"));
    expect(verifyAssetParams(queryOf(named), now, secret)).toMatchObject({ url: "https://a.com/x.png", dl: "Logo dark.png" });
    expect(statusOf(() => verifyAssetParams(queryOf(named).replace("Logo+dark", "Logo+light"), now, secret))).toBe(403);
  });

  it("writes a download name the way it comes back to the handler, so the signed path is the one requested", () => {
    const path = createSigner({ secret, now }).sign("https://a.com/x.png", "Logo (it's dark) ~é!.png");
    expect(path).toContain("&dl=Logo+%28it%27s+dark%29+%7E%C3%A9%21.png");
    // A browser leaves the query as it is, and `next start` rewrites every query the way URLSearchParams writes it,
    // before the route runs: either way the handler gets the path the signer wrote.
    expect(queryOf(path)).toBe(path.slice(path.indexOf("?")));
    const rewritten = `?${new URLSearchParams(queryOf(path))}`;
    expect(rewritten).toBe(queryOf(path));
    expect(verifyAssetParams(rewritten, now, secret)).toMatchObject({ dl: "Logo (it's dark) ~é!.png" });
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
    expect(verifyAssetParams(queryOf(path), Date.UTC(2026, 8, 16, 18, 59), secret).url).toBe("https://cdn.example.com/logo.svg");
    expect(statusOf(() => verifyAssetParams(queryOf(path), Date.UTC(2026, 8, 16, 19), secret))).toBe(403);
    expect(statusOf(() => verifyAssetParams(queryOf(path), now, "another-secret-with-enough-entropy-000"))).toBe(403);
  });

  it("counts each distinct URL once", () => {
    const signer = createSigner({ secret, now, max: 1 });
    const first = signer.sign("https://a.com/1");
    expect(signer.sign("https://a.com/1")).toBe(first);
    expect(signer.count).toBe(1);
  });

  it("answers 400 to missing, repeated or malformed params and to non-http URLs", () => {
    const valid = createSigner({ secret, now }).sign("https://a.com/x.png");
    const variant = (edit: (p: URLSearchParams) => void) => edited(valid, edit);
    expect(statusOf(() => verifyAssetParams("", now, secret))).toBe(400);
    expect(statusOf(() => verifyAssetParams(variant((p) => p.delete("s")), now, secret))).toBe(400);
    expect(statusOf(() => verifyAssetParams(variant((p) => p.append("u", p.get("u") ?? "")), now, secret))).toBe(400);
    expect(statusOf(() => verifyAssetParams(variant((p) => p.set("e", "1e10")), now, secret))).toBe(400);
    expect(statusOf(() => verifyAssetParams(variant((p) => p.set("s", "short")), now, secret))).toBe(400);
    expect(statusOf(() => verifyAssetParams(variant((p) => p.set("u", `${p.get("u")}==`)), now, secret))).toBe(400);
    expect(statusOf(() => verifyAssetParams(variant((p) => p.set("dl", "")), now, secret))).toBe(400);
    expect(statusOf(() => verifyAssetParams(variant((p) => p.set("dl", "x".repeat(256))), now, secret))).toBe(400);

    const javascript = createSigner({ secret, now }).sign("javascript:alert(1)");
    expect(statusOf(() => verifyAssetParams(queryOf(javascript), now, secret))).toBe(400);
  });

  /**
   * The query is the CDN cache key. Each of these names the same signed link, so each one the proxy answered would be a
   * cache miss, an invocation and an upstream fetch of its own, all on one signature.
   */
  it("answers 400 to any spelling of a signed query but the signer's own", () => {
    const signer = createSigner({ secret, now });
    const plain = queryOf(signer.sign("https://a.com/x.png"));
    const named = queryOf(signer.sign("https://a.com/x.png", "Logo dark.png"));
    const { u, e, s } = Object.fromEntries(paramsOf(plain));
    expect(u.startsWith("a")).toBe(true);
    const spellings = [
      `?s=${s}&e=${e}&u=${u}`,
      `?u=%61${u.slice(1)}&e=${e}&s=${s}`,
      `?u=${u}&e=0${e}&s=${s}`,
      // a digit is 0x30 to 0x39, so `%3` and the digit is that digit percent-encoded
      `?u=${u}&e=%3${e[0]}${e.slice(1)}&s=${s}`,
      `?u=${u}&e=${e}&fmt=ttf&s=${s}`,
      `${plain}&`,
      named.replace("Logo+dark", "Logo%20dark"),
      named.replace(".png", "%2Epng"),
    ];
    for (const spelling of spellings) {
      expect(spelling).not.toBe(plain);
      expect(statusOf(() => verifyAssetParams(spelling, now, secret)), spelling).toBe(400);
    }
    expect(verifyAssetParams(plain.slice(1), now, secret).url).toBe("https://a.com/x.png");
  });

  it("uses a random per-process key outside production and requires ASSET_URL_SECRET in production", () => {
    vi.stubEnv("ASSET_URL_SECRET", "");
    const path = createSigner({ now }).sign("https://a.com/dev.png");
    expect(verifyAssetParams(queryOf(path), now).url).toBe("https://a.com/dev.png");
    expect(statusOf(() => verifyAssetParams(queryOf(path), now, secret))).toBe(403);

    vi.stubEnv("NODE_ENV", "production");
    expect(() => createSigner({ now }).sign("https://a.com/prod.png")).toThrow(/ASSET_URL_SECRET/);
    vi.stubEnv("ASSET_URL_SECRET", "too-short");
    expect(() => createSigner({ now }).sign("https://a.com/prod.png")).toThrow(/ASSET_URL_SECRET/);
    vi.stubEnv("ASSET_URL_SECRET", secret);
    const prod = createSigner({ now }).sign("https://a.com/prod.png");
    expect(verifyAssetParams(queryOf(prod), now, secret).url).toBe("https://a.com/prod.png");
    expect(verifyAssetParams(queryOf(prod), now).url).toBe("https://a.com/prod.png");
  });

  it("validates params before it needs the secret", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ASSET_URL_SECRET", "");
    expect(statusOf(() => verifyAssetParams("?u=x", now))).toBe(400);
  });
});
