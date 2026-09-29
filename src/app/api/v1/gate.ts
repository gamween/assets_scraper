import { ipAddress } from "@vercel/functions";
import { AssetKind, AssetRole, type ErrorCode } from "@/lib/contract";
import { normalizeInputUrl, type UrlInputResult } from "@/lib/url";
import { agentLimits } from "@/agent/limits";
import type { SelectionOptions, SelectionProfile } from "@/agent/types";
import { zipMaxBytes } from "./zip";
import { isOwnHost, isTestAllowed, privateHostReason } from "@/server/net/ip";
import { authenticateAgent, safeEqual } from "@/server/security/agent-auth";
import { takeScanBudget } from "@/server/security/budget";
import { apiError } from "@/server/security/gate";

/**
 * The request gate of the agent API (spec section 8): the order of v1 spec 7.1 minus BotID, which the bearer token
 * replaces, and minus the same Origin rule, which a token client has no Origin for. Everything else v1 applies still
 * applies here: the kill switch, the access code, the URL policy (SSRF guards included) and the daily scan budget.
 *
 * It is split in two so a route can authorize before it reads anything: an unauthenticated caller gets a 401 without
 * the endpoint parsing its body or telling it which of its parameters were wrong.
 */

export type AgentRefusal = { ok: false; response: Response };

/** `client` is the caller's address, the key of its own daily quota; null off Vercel. */
export type AgentTarget = { ok: true; url: string; host: string; client: string | null } | AgentRefusal;

const fail = (status: number, code: ErrorCode, message: string): AgentRefusal => ({ ok: false, response: apiError(status, code, message) });

const INVALID_URL = "Pass a web address, like linear.app";

/**
 * Steps 5 and 6 of v1 spec 7.1 after the bearer token: a paused scanner refuses everyone, and an app behind an access
 * code stays behind it (spec section 8: an agent token skips BotID and nothing else).
 */
export function authorizeAgent(request: Request): { ok: true; tokenIndex: number } | AgentRefusal {
  const auth = authenticateAgent(request);
  if (!auth.ok) return auth;
  if (process.env.SCAN_DISABLED === "1") return fail(503, "disabled", "Scanning is paused.");
  const accessCode = process.env.ACCESS_CODE;
  if (accessCode && !safeEqual(request.headers.get("x-access-code") ?? "", accessCode)) {
    return fail(401, "access-code", "Send the access code in x-access-code.");
  }
  return auth;
}

/** Bytes of a request body the agent API reads, as in v1's gate: a scan request is one short URL. */
export const AGENT_MAX_BODY_BYTES = 16 * 1024;

/**
 * The JSON body of an agent request, or null when the media type is wrong, the body is not JSON, or it is larger than
 * `AGENT_MAX_BODY_BYTES`. The size is enforced while reading, so a body that lies in `content-length` is still capped.
 */
export async function readAgentJson(request: Request): Promise<unknown | null> {
  const mediaType = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (mediaType !== "application/json") return null;
  if (Number(request.headers.get("content-length")) > AGENT_MAX_BODY_BYTES) return null;
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > AGENT_MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
  } catch {
    return null;
  }
}

/**
 * The same exception v1's gate makes for its own integration tests: `normalizeInputUrl` refuses every port but 80 and
 * 443, which would keep an allowlisted test origin (`SCAN_TEST_ALLOW_HOSTS`) out even though `safeFetch` and the egress
 * proxy accept it. Null everywhere `isTestAllowed` is off, so production and Vercel never see it.
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
 * Steps 7 and 8 of v1 spec 7.1: the URL policy, then the budget. The budget is last, so a request that never becomes a
 * scan (a typo, a blocked address) does not spend a unit of the shared daily limit.
 */
export async function gateAgentTarget(input: string | null | undefined, request: Request): Promise<AgentTarget> {
  if (!input) return fail(400, "invalid-url", INVALID_URL);
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
  const client = ipAddress(request) ?? null;
  if (!(await takeScanBudget(client))) return fail(429, "budget", "Daily scan limit reached.");
  return { ok: true, url: normalized.url, host: normalized.host, client };
}

const PROFILES = new Set<SelectionProfile>(["deck", "all"]);

/** Characters of `nameContains` the endpoint keeps. */
export const MAX_NAME_CONTAINS = 200;

const list = (value: string): string[] =>
  value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");

/** A whole number above 0, or null: a query string carries text, and `Number("")` is 0. */
const whole = (value: string): number | null => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

/** The same, plus 0, which is how a caller says "no limit" for a byte budget. */
const wholeOrZero = (value: string): number | null => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
};

export type SelectionParams = { ok: true; options: SelectionOptions } | { ok: false; message: string };

/**
 * The selection a ZIP request asks for (spec section 8), with the same defaults `selectAssets` uses: the `deck`
 * profile, and a `max` the hosted endpoint holds to `AGENT_MAX_FILES` whatever the caller asks, since every file it
 * names is a fetch and a byte of the shared proxy budget. An unknown value is a 400 rather than a silent default: an
 * agent that misspelled a role should hear about it instead of getting the whole page.
 */
export function parseSelectionParams(params: URLSearchParams): SelectionParams {
  const options: SelectionOptions = { profile: "deck" };
  const profile = params.get("profile");
  if (profile !== null) {
    if (!PROFILES.has(profile as SelectionProfile)) return { ok: false, message: "profile must be deck or all." };
    options.profile = profile as SelectionProfile;
  }
  const kinds = params.get("kinds");
  if (kinds !== null) {
    const parsed = AssetKind.array().safeParse(list(kinds));
    if (!parsed.success) return { ok: false, message: `kinds must be a comma separated list of ${AssetKind.options.join(", ")}.` };
    options.kinds = parsed.data;
  }
  const roles = params.get("roles");
  if (roles !== null) {
    const parsed = AssetRole.array().safeParse(list(roles));
    if (!parsed.success) return { ok: false, message: `roles must be a comma separated list of ${AssetRole.options.join(", ")}.` };
    options.roles = parsed.data;
  }
  const max = params.get("max");
  if (max !== null) {
    const parsed = whole(max);
    if (parsed === null) return { ok: false, message: "max must be a whole number above 0." };
    options.max = Math.min(parsed, agentLimits.maxFiles);
  }
  // The byte budget, held to what one request may serve the way `max` is held to AGENT_MAX_FILES: lifting it here means
  // the hosted ceiling, not an unbounded archive, since every byte is a fetch and a byte of the shared proxy budget.
  const maxBytes = params.get("maxBytes");
  if (maxBytes !== null) {
    const parsed = wholeOrZero(maxBytes);
    if (parsed === null) return { ok: false, message: "maxBytes must be a whole number of bytes, or 0 for no limit." };
    options.maxTotalBytes = parsed === 0 ? zipMaxBytes() : Math.min(parsed, zipMaxBytes());
  }
  const maxFileBytes = params.get("maxFileBytes");
  if (maxFileBytes !== null) {
    const parsed = wholeOrZero(maxFileBytes);
    if (parsed === null) return { ok: false, message: "maxFileBytes must be a whole number of bytes, or 0 for no ceiling." };
    options.maxFileBytes = parsed === 0 ? 0 : Math.min(parsed, zipMaxBytes());
  }
  const minLongSide = params.get("minLongSide");
  if (minLongSide !== null) {
    const parsed = whole(minLongSide);
    if (parsed === null) return { ok: false, message: "minLongSide must be a whole number above 0." };
    options.minLongSide = parsed;
  }
  const nameContains = params.get("nameContains");
  // Cut, because it is echoed back in the archive's manifest: a caller has no use for a needle longer than a file name.
  if (nameContains !== null && nameContains.trim() !== "") options.nameContains = nameContains.trim().slice(0, MAX_NAME_CONTAINS);
  // The same switch the CLI (`--include-icons`) and the MCP tool take, so all three surfaces accept one input.
  const includeIcons = params.get("includeIcons");
  if (includeIcons !== null) {
    if (includeIcons !== "true" && includeIcons !== "false") return { ok: false, message: "includeIcons must be true or false." };
    if (includeIcons === "true") options.includeIcons = true;
  }
  return { ok: true, options };
}
