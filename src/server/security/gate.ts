import { createHash, timingSafeEqual } from "node:crypto";
import { checkBotId } from "botid/server";
import { ScanRequest, type ApiError, type ErrorCode } from "@/lib/contract";
import { normalizeInputUrl, type UrlInputResult } from "@/lib/url";
import { isOwnHost, isTestAllowed, privateHostReason } from "@/server/net/ip";
import { takeScanBudget } from "./budget";

export type GateResult = { ok: true; url: string; host: string; ops: boolean } | { ok: false; response: Response };

const MAX_BODY_BYTES = 16 * 1024;
const MIN_OPS_TOKEN_LENGTH = 32;

/** JSON error for failures before the stream starts (spec 6), never cached. */
export function apiError(status: number, code: ErrorCode, message: string, headers: Record<string, string> = {}): Response {
  const body: ApiError = { error: { code, message } };
  return Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
}

const fail = (status: number, code: ErrorCode, message: string, headers?: Record<string, string>): GateResult => ({
  ok: false,
  response: apiError(status, code, message, headers),
});

/** Constant-time string comparison that does not leak the length either. */
function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

function isOpsRequest(request: Request): boolean {
  const expected = process.env.OPS_TOKEN ?? "";
  const token = request.headers.get("x-ops-token");
  return expected.length >= MIN_OPS_TOKEN_LENGTH && token !== null && safeEqual(token, expected);
}

/** Reads at most `MAX_BODY_BYTES`; null when the body is larger or unreadable. */
async function readBody(request: Request): Promise<string | null> {
  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

async function parseScanRequest(request: Request): Promise<string | null> {
  const text = await readBody(request);
  if (text === null) return null;
  try {
    const parsed = ScanRequest.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data.url : null;
  } catch {
    return null;
  }
}

const INVALID_URL = "Enter a web address, like linear.app";

/**
 * Tests only: `normalizeInputUrl` refuses every port but 80 and 443, which would keep an allowlisted test origin
 * (`SCAN_TEST_ALLOW_HOSTS`, spec 11.1) out even though `safeFetch` and the egress proxy accept it. For an absolute
 * http(s) URL on an allowlisted `host:port`, the URL is normalized without its port, then gets the port back. Null
 * otherwise, including everywhere `isTestAllowed` is off (production, Vercel).
 */
function normalizeTestUrl(input: string): UrlInputResult | null {
  let parsed: URL;
  try {
    parsed = new URL(input.trim());
  } catch {
    return null;
  }
  const port = Number(parsed.port);
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.port || !isTestAllowed(parsed.hostname, port)) return null;
  parsed.port = "";
  const normalized = normalizeInputUrl(parsed.href);
  if (!normalized.ok) return null;
  const url = new URL(normalized.url);
  url.port = String(port);
  return { ok: true, url: url.href, host: normalized.host };
}

/**
 * Request gate for `POST /api/scan`, in the order of spec 7.1 (the WAF rule runs before the function): method, JSON
 * content type and same Origin, body, BotID, kill switch and access code, budget, then the URL policy. A valid
 * `x-ops-token` (OPS_TOKEN, at least 32 characters) skips BotID and the budget and may omit Origin.
 */
export async function gateScanRequest(request: Request): Promise<GateResult> {
  if (request.method !== "POST") return fail(405, "invalid-url", "Use POST with a JSON body.", { allow: "POST" });
  const mediaType = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (mediaType !== "application/json") return fail(400, "invalid-url", INVALID_URL);

  const ops = isOpsRequest(request);
  const origin = request.headers.get("origin");
  if (origin === null ? !ops : origin !== new URL(request.url).origin) return fail(403, "bot", "The scan request was blocked.");

  const input = await parseScanRequest(request);
  if (input === null) return fail(400, "invalid-url", INVALID_URL);

  if (!ops) {
    let isBot = true;
    try {
      isBot = (await checkBotId()).isBot;
    } catch (error) {
      console.error(`BotID check failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (isBot) return fail(403, "bot", "The scan request was blocked.");
  }

  if (process.env.SCAN_DISABLED === "1") return fail(503, "disabled", "Scanning is paused.");
  const accessCode = process.env.ACCESS_CODE;
  if (accessCode && !safeEqual(request.headers.get("x-access-code") ?? "", accessCode)) return fail(401, "access-code", "Enter the access code.");

  if (!ops && !(await takeScanBudget())) return fail(429, "budget", "Daily scan limit reached.");

  let normalized = normalizeInputUrl(input);
  if (!normalized.ok && normalized.code === "unsupported-port") normalized = normalizeTestUrl(input) ?? normalized;
  if (!normalized.ok) {
    return normalized.code === "unsupported-port"
      ? fail(422, "unsupported-port", "Only ports 80 and 443 are supported.")
      : fail(400, "invalid-url", INVALID_URL);
  }
  const url = new URL(normalized.url);
  const hostname = normalized.host.replace(/^\[(.*)\]$/, "$1");
  if (isOwnHost(hostname)) return fail(422, "own-host", "Assets Scraper can't scan itself.");
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (privateHostReason(hostname) && !isTestAllowed(hostname, port)) {
    return fail(422, "blocked-address", "Local and private network addresses are blocked.");
  }
  return { ok: true, url: normalized.url, host: normalized.host, ops };
}
