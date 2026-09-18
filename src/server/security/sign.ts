import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { limits } from "@/server/config/limits";
import { HttpError } from "@/server/errors";
import type { Signer } from "@/server/scan/types";

export class SignLimitError extends Error {
  constructor(message = "Too many signed URLs in one scan") {
    super(message);
    this.name = "SignLimitError";
  }
}

const HOUR_MS = 3_600_000;
const MIN_SECRET_LENGTH = 32;
const PARAMS = new Set(["u", "e", "s", "dl", "fmt"]);
const MAX_DL_LENGTH = 255;

let processSecret: string | undefined;

/** `ASSET_URL_SECRET`; outside production a random key per process when it is unset (spec 11.2). */
function getSecret(): string {
  const secret = process.env.ASSET_URL_SECRET;
  if (secret) {
    if (secret.length < MIN_SECRET_LENGTH) throw new Error(`ASSET_URL_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
    return secret;
  }
  if (process.env.NODE_ENV === "production") throw new Error("ASSET_URL_SECRET is required in production");
  processSecret ??= randomBytes(32).toString("base64url");
  return processSecret;
}

const mac = (secret: string, expiry: number, url: string, dl = "") =>
  createHmac("sha256", secret).update(`v1\n${expiry}\n${url}\n${dl}`).digest("base64url").slice(0, 32);

/**
 * Signs asset proxy paths for one scan. The expiry is bucketed by hour and lands 6 to 7 hours ahead, so the same URL
 * signed within an hour gives the same path and CDN cache keys repeat. A download name is signed with the URL and
 * appended as `dl`, so a name cannot be swapped in to turn one link into unlimited cache misses. At most `max`
 * distinct URL and name pairs per signer.
 */
export function createSigner(options: { secret?: string; now?: number; max?: number } = {}): Signer {
  const now = options.now ?? Date.now();
  const max = options.max ?? limits.maxSignedUrls;
  const expiry = (Math.floor(now / HOUR_MS) + 7) * 3600;
  const signed = new Map<string, string>();
  let secret = options.secret;

  return {
    sign(url: string, dl?: string): string {
      const key = dl === undefined ? url : `${url}\n${dl}`;
      const existing = signed.get(key);
      if (existing) return existing;
      if (signed.size >= max) throw new SignLimitError(`More than ${max} signed URLs in one scan`);
      secret ??= getSecret();
      const name = dl === undefined ? "" : `&dl=${encodeURIComponent(dl)}`;
      const path = `/api/asset?u=${Buffer.from(url, "utf8").toString("base64url")}&e=${expiry}&s=${mac(secret, expiry, url, dl ?? "")}${name}`;
      signed.set(key, path);
      return path;
    },
    get count() {
      return signed.size;
    },
  };
}

const invalid = (message: string) => new HttpError(400, "invalid-params", message);

/**
 * Verifies `/api/asset` query params. 400 for unknown, repeated, missing or malformed params (checked before the
 * secret is needed), 403 for a bad signature or an expired link. `dl` is part of the MAC: it is part of the request
 * URL and therefore part of the CDN cache key, so an unsigned one turns a single signed link into unlimited cache
 * misses, each a fresh invocation and a fresh upstream fetch. The signer never appends `dl`, so any request carrying
 * one fails the signature today; a named download link would have to sign the name with the URL. `fmt` stays out of
 * the MAC: the client appends `&fmt=ttf`, it has two values, and the proxy checks it against the font licence.
 */
export function verifyAssetParams(params: URLSearchParams, now: number = Date.now(), secret?: string): { url: string; dl?: string; fmt?: "ttf" } {
  for (const key of new Set(params.keys())) {
    if (!PARAMS.has(key)) throw invalid(`Unknown parameter: ${key.slice(0, 32)}`);
    if (params.getAll(key).length !== 1) throw invalid(`Repeated parameter: ${key}`);
  }
  const u = params.get("u");
  const e = params.get("e");
  const s = params.get("s");
  if (!u || !e || !s) throw invalid("Missing parameter");
  if (!/^[A-Za-z0-9_-]+$/.test(u) || !/^\d{1,12}$/.test(e) || !/^[A-Za-z0-9_-]{32}$/.test(s)) throw invalid("Malformed parameter");
  const url = Buffer.from(u, "base64url").toString("utf8");
  if (Buffer.from(url, "utf8").toString("base64url") !== u) throw invalid("Malformed parameter");
  const dl = params.get("dl");
  if (dl !== null && (dl.length === 0 || dl.length > MAX_DL_LENGTH)) throw invalid("Invalid file name");
  const fmt = params.get("fmt");
  if (fmt !== null && fmt !== "ttf") throw invalid("Unsupported format");

  const expiry = Number(e);
  const expected = Buffer.from(mac(secret ?? getSecret(), expiry, url, dl ?? ""));
  if (!timingSafeEqual(Buffer.from(s), expected)) throw new HttpError(403, "bad-signature", "Invalid signature");
  if (expiry * 1000 <= now) throw new HttpError(403, "expired", "Link expired");

  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    throw invalid("Invalid URL");
  }
  if (protocol !== "http:" && protocol !== "https:") throw invalid("Invalid URL");
  return { url, ...(dl !== null && { dl }), ...(fmt === "ttf" && { fmt: "ttf" as const }) };
}
