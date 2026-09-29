import { checkBotId } from "botid/server";
import { ScanRequest, type ApiError, type ErrorCode } from "@/lib/contract";
import { normalizeInputUrl, type UrlInputResult } from "@/lib/url";
import { isOwnHost, isTestAllowed, privateHostReason } from "@/server/net/ip";
import { takeScanBudget } from "./budget";
import { clientAddress, readCappedBody, requestMediaType, safeEqual } from "./request";

/** A refusal, the one shape both gates answer with before anything runs. */
export type GateRefusal = { ok: false; response: Response };

/** `client` is the caller's address, the key of its own daily quota; null off Vercel. */
export type GateResult = { ok: true; url: string; host: string; ops: boolean; client: string | null } | GateRefusal;

const MIN_OPS_TOKEN_LENGTH = 32;

/** JSON error for failures before the stream starts (spec 6), never cached. */
export function apiError(status: number, code: ErrorCode, message: string, headers: Record<string, string> = {}): Response {
  const body: ApiError = { error: { code, message } };
  return Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
}

/**
 * Spec 7.1 step 1. Exported because the route binds it to every method but POST: the Next router answers a method it
 * has no export for before any of this runs, with a bare cacheable 405 and no `allow`.
 */
export const refuseScanMethod = (): Response => apiError(405, "invalid-url", "Use POST with a JSON body.", { allow: "POST" });

const fail = (status: number, code: ErrorCode, message: string, headers?: Record<string, string>): GateRefusal => ({
  ok: false,
  response: apiError(status, code, message, headers),
});

function isOpsRequest(request: Request): boolean {
  const expected = process.env.OPS_TOKEN ?? "";
  const token = request.headers.get("x-ops-token");
  return expected.length >= MIN_OPS_TOKEN_LENGTH && token !== null && safeEqual(token, expected);
}

async function parseScanRequest(request: Request): Promise<string | null> {
  const body = await readCappedBody(request);
  if (body === null) return null;
  try {
    const parsed = ScanRequest.safeParse(JSON.parse(new TextDecoder().decode(body)));
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
 * Step 5 of spec 7.1, for both gates: a paused scanner refuses everyone, and an app behind an access code stays behind
 * it. Null when neither applies. The access code message is the caller's, since only it knows where its client types
 * the code: the browser has a field, an agent has a header.
 */
export function refuseWhenClosed(request: Request, accessCodeMessage: string): GateRefusal | null {
  if (process.env.SCAN_DISABLED === "1") return fail(503, "disabled", "Scanning is paused.");
  const accessCode = process.env.ACCESS_CODE;
  if (accessCode && !safeEqual(request.headers.get("x-access-code") ?? "", accessCode)) return fail(401, "access-code", accessCodeMessage);
  return null;
}

/**
 * Step 6 of spec 7.1, the URL policy, for both gates: the normalized URL (an allowlisted test origin keeps its port),
 * then own-host and private-address refusals. `invalidUrlMessage` is the caller's wording for input that is not a URL at
 * all. This is the first layer only: `safeFetch` and the egress proxy check every address again after DNS.
 */
export function checkScanTarget(input: string, invalidUrlMessage: string): { ok: true; url: string; host: string } | GateRefusal {
  let normalized = normalizeInputUrl(input);
  if (!normalized.ok && normalized.code === "unsupported-port") normalized = normalizeTestUrl(input) ?? normalized;
  if (!normalized.ok) {
    return normalized.code === "unsupported-port"
      ? fail(422, "unsupported-port", "Only ports 80 and 443 are supported.")
      : fail(400, "invalid-url", invalidUrlMessage);
  }
  const url = new URL(normalized.url);
  const hostname = normalized.host.replace(/^\[(.*)\]$/, "$1");
  if (isOwnHost(hostname)) return fail(422, "own-host", "Assets Scraper can't scan itself.");
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (privateHostReason(hostname) && !isTestAllowed(hostname, port)) {
    return fail(422, "blocked-address", "Local and private network addresses are blocked.");
  }
  return { ok: true, url: normalized.url, host: normalized.host };
}

/**
 * Request gate for `POST /api/scan`, in the order of spec 7.1 (the WAF rule runs before the function): method, JSON
 * content type and same Origin, body, BotID, kill switch and access code, the URL policy, then the budget. A valid
 * `x-ops-token` (OPS_TOKEN, at least 32 characters) skips BotID and the budget and may omit Origin.
 */
export async function gateScanRequest(request: Request): Promise<GateResult> {
  if (request.method !== "POST") return { ok: false, response: refuseScanMethod() };
  if (requestMediaType(request) !== "application/json") return fail(400, "invalid-url", INVALID_URL);

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

  const closed = refuseWhenClosed(request, "Enter the access code.");
  if (closed) return closed;

  const target = checkScanTarget(input, INVALID_URL);
  if (!target.ok) return target;
  // Last, so a request that never becomes a scan (a typo, a blocked address) does not spend a unit of the shared
  // budget. The client address carries a per-address daily quota; it is null off Vercel, which skips that quota.
  const client = clientAddress(request);
  if (!ops && !(await takeScanBudget(client))) return fail(429, "budget", "Daily scan limit reached.");
  return { ok: true, url: target.url, host: target.host, ops, client };
}
