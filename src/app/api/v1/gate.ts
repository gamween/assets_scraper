import { AssetKind, AssetRole, type ErrorCode } from "@/lib/contract";
import { agentLimits } from "@/agent/limits";
import type { SelectionOptions, SelectionProfile } from "@/agent/types";
import { zipMaxBytes } from "./zip";
import { authenticateAgent } from "@/server/security/agent-auth";
import { takeScanBudget } from "@/server/security/budget";
import { apiError, checkScanTarget, refuseWhenClosed, type GateRefusal } from "@/server/security/gate";
import { clientAddress, readCappedBody, requestMediaType } from "@/server/security/request";

/**
 * The request gate of the agent API (spec section 8): the order of v1 spec 7.1 minus BotID, which the bearer token
 * replaces, and minus the same Origin rule, which a token client has no Origin for. Everything else v1 applies still
 * applies here, through the very functions `/api/scan` runs: the kill switch, the access code, the URL policy (SSRF
 * guards included) and the daily scan budget.
 *
 * It is split in two so a route can authorize before it reads anything: an unauthenticated caller gets a 401 without
 * the endpoint parsing its body or telling it which of its parameters were wrong.
 */

/** `client` is the caller's address, the key of its own daily quota; null off Vercel. */
export type AgentTarget = { ok: true; url: string; host: string; client: string | null } | GateRefusal;

const fail = (status: number, code: ErrorCode, message: string): GateRefusal => ({ ok: false, response: apiError(status, code, message) });

const INVALID_URL = "Pass a web address, like linear.app";

/**
 * Steps 5 and 6 of v1 spec 7.1 after the bearer token: a paused scanner refuses everyone, and an app behind an access
 * code stays behind it (spec section 8: an agent token skips BotID and nothing else).
 */
export function authorizeAgent(request: Request): { ok: true; tokenIndex: number } | GateRefusal {
  const auth = authenticateAgent(request);
  if (!auth.ok) return auth;
  return refuseWhenClosed(request, "Send the access code in x-access-code.") ?? auth;
}

/**
 * The JSON body of an agent request, or null when the media type is wrong, the body is not JSON, or it is larger than
 * v1's gate reads (`MAX_BODY_BYTES`, enforced while reading, so a body that lies in `content-length` is still capped).
 */
export async function readAgentJson(request: Request): Promise<unknown | null> {
  if (requestMediaType(request) !== "application/json") return null;
  const body = await readCappedBody(request);
  if (body === null) return null;
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    return null;
  }
}

/**
 * Steps 7 and 8 of v1 spec 7.1: the URL policy, then the budget. The budget is last, so a request that never becomes a
 * scan (a typo, a blocked address) does not spend a unit of the shared daily limit.
 */
export async function gateAgentTarget(input: string | null | undefined, request: Request): Promise<AgentTarget> {
  if (!input) return fail(400, "invalid-url", INVALID_URL);
  const target = checkScanTarget(input, INVALID_URL);
  if (!target.ok) return target;
  const client = clientAddress(request);
  if (!(await takeScanBudget(client))) return fail(429, "budget", "Daily scan limit reached.");
  return { ok: true, url: target.url, host: target.host, client };
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
    // At least one: an empty list would keep nothing, after spending a scan on an archive that holds only a manifest.
    const parsed = AssetKind.array().min(1).safeParse(list(kinds));
    if (!parsed.success) return { ok: false, message: `kinds must be a comma separated list of ${AssetKind.options.join(", ")}.` };
    options.kinds = parsed.data;
  }
  const roles = params.get("roles");
  if (roles !== null) {
    const parsed = AssetRole.array().min(1).safeParse(list(roles));
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
  return { ok: true, options };
}
