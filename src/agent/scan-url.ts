import { normalizeInputUrl } from "@/lib/url";

/**
 * The URL to scan, read the way the app reads what a user pastes, so `stripe.com` works like the spec's examples and the
 * cache sees one form of each page. Null when it is not a web address at all.
 *
 * It lives on its own because every entry point owes its caller the same reading: the CLI normalizes here, the hosted
 * endpoint normalizes in `gateAgentTarget`, and the MCP server used to hand the raw string to the engine, which threw
 * `invalid-url` on `new URL("example.com")`. That made `scan_page` cache-dependent as well as wrong, since the cache key
 * then stripped the scheme: a bare host worked while a scan of the `https:` form was still warm and failed once it aged
 * out (review issue 17).
 *
 * A port outside 80 and 443 is not refused here: that policy belongs to the scan, which also knows the test allowlist, so
 * such a URL is passed through for the engine to answer with its own `unsupported-port`.
 */
export function normalizeScanUrl(raw: string): string | null {
  const parsed = normalizeInputUrl(raw);
  if (parsed.ok) return parsed.url;
  const trimmed = raw.trim();
  if (parsed.code === "unsupported-port") {
    try {
      return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`).toString();
    } catch {
      // Not a URL after all, so it is not one for the caller either.
    }
  }
  return null;
}
