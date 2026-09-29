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
 * The query of a signed path, in the one order and encoding the signer writes and `verifyAssetParams` accepts: `u`, `e`,
 * `s`, then `dl` when there is one, then `fmt`, which the client appends last, all as `URLSearchParams` writes them. That
 * encoding is the one that comes through unchanged on the way to the handler: a browser leaves a query it already holds
 * in that form alone, and the Next server rewrites every query into exactly that form before a route sees it.
 */
function assetQuery(params: { u: string; e: string; s: string; dl?: string | null; fmt?: string | null }): string {
  const query = new URLSearchParams({ u: params.u, e: params.e, s: params.s });
  if (params.dl != null) query.append("dl", params.dl);
  if (params.fmt != null) query.append("fmt", params.fmt);
  return query.toString();
}

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
      const path = `/api/asset?${assetQuery({ u: Buffer.from(url, "utf8").toString("base64url"), e: String(expiry), s: mac(secret, expiry, url, dl ?? ""), dl })}`;
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
 * Verifies the query of an `/api/asset` request (`URL.search`, with or without its `?`). 400 for unknown, repeated,
 * missing, malformed or non-canonical params (checked before the secret is needed), 403 for a bad signature or an
 * expired link. `expiry` comes back in seconds, so the proxy can keep the CDN from outliving the link.
 *
 * The query is the CDN cache key, so it has to be the one the signer wrote, byte for byte (plus the client's `&fmt=ttf`):
 * any other spelling of the same values would be one more cache miss, one more invocation and one more upstream fetch on
 * a single signature. `dl` is part of the MAC for the same reason. `fmt` stays out of it: the client appends `&fmt=ttf`,
 * it has two values, and the proxy checks it against the font licence. No caller names its downloads today, so every
 * signed path is an inline one, but a signer given a name signs it with the URL and appends it as `dl`.
 *
 * Next hands a route the query already decoded and encoded again, so a percent-encoding variant of a value arrives
 * in the canonical spelling and cannot be told apart here: what this refuses behind Next is every difference that
 * survives that rewrite (order, a repeated or unknown param, a leading zero in `e`). A variant that gets through is
 * still charged to its caller's share of the proxy budget, like any download.
 */
export function verifyAssetParams(
  search: string,
  now: number = Date.now(),
  secret?: string,
): { url: string; expiry: number; dl?: string; fmt?: "ttf" } {
  const query = search.startsWith("?") ? search.slice(1) : search;
  const params = new URLSearchParams(query);
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
  // `e` as the number the MAC covers, so a leading zero is one more spelling too
  const expiry = Number(e);
  if (assetQuery({ u, e: String(expiry), s, dl, fmt }) !== query) throw invalid("Non-canonical parameters");

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
  return { url, expiry, ...(dl !== null && { dl }), ...(fmt === "ttf" && { fmt: "ttf" as const }) };
}
