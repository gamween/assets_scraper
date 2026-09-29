import { apiError } from "./gate";
import { safeEqual } from "./request";

/**
 * Bearer authentication for the agent API (spec `2026-09-27-agent-access-design.md` section 8). A token listed in
 * `AGENT_TOKENS` skips BotID, which is what keeps curl out of `/api/scan`, and nothing else: the WAF rate limit, the
 * scan budget, the SSRF guards and every v1 cap still apply. It is not the ops token, which keeps its own bypass on
 * `/api/scan` and is refused here.
 */

/** `{ tokenIndex }` says which configured token matched. The token itself never leaves this module. */
export type AgentAuth = { ok: true; tokenIndex: number } | { ok: false; response: Response };

/**
 * Configured tokens shorter than this are ignored, so a typo or a placeholder in `AGENT_TOKENS` cannot become the only
 * thing guarding the API. 24 characters is 128 bits of base64url.
 */
export const MIN_AGENT_TOKEN_LENGTH = 24;

const BEARER = /^bearer[ \t]+(.+)$/i;

/** The tokens `AGENT_TOKENS` configures, in order: comma separated, trimmed, long enough to be a token. */
export function agentTokens(): string[] {
  return (process.env.AGENT_TOKENS ?? "")
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length >= MIN_AGENT_TOKEN_LENGTH);
}

const refuse = (): AgentAuth => ({
  ok: false,
  response: apiError(401, "access-code", "This endpoint needs a bearer token.", { "www-authenticate": "Bearer" }),
});

/**
 * Reads `Authorization: Bearer <token>` and matches it against `agentTokens()`. Every configured token is compared
 * whatever the outcome, so the timing says nothing about which one nearly matched, and nothing here logs the token.
 */
export function authenticateAgent(request: Request): AgentAuth {
  const presented = BEARER.exec(request.headers.get("authorization") ?? "")?.[1].trim();
  if (!presented) return refuse();
  let tokenIndex = -1;
  const tokens = agentTokens();
  for (let index = 0; index < tokens.length; index++) {
    if (safeEqual(presented, tokens[index]) && tokenIndex < 0) tokenIndex = index;
  }
  return tokenIndex < 0 ? refuse() : { ok: true, tokenIndex };
}
