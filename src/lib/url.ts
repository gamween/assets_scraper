/**
 * On success, `url` is the normalized absolute URL and `host` is its `URL.hostname`: lowercase, IDN in punycode,
 * IPv4 in dotted form and IPv6 literals inside brackets (`[::1]`). Strip the brackets before IP checks.
 */
export type UrlInputResult =
  | { ok: true; url: string; host: string }
  | { ok: false; code: "invalid-url" | "unsupported-port" };

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const SCHEME_SLASHES = /^[a-z][a-z0-9+.-]*:\/\//i;
const HOST_PORT = /^[^:/?#]+:\d+/;
/** DNS labels of letters, digits, hyphens and underscores (IDN arrives as punycode), with an optional root dot. */
const DOMAIN = /^(?=.{1,253}\.?$)(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)*[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.?$/;

const count = (value: string, char: string) => value.split(char).length - 1;

export function normalizeInputUrl(raw: string): UrlInputResult {
  // Wrappers people paste around URLs: quotes, angle brackets, parentheses, backticks.
  let s = raw.trim().replace(/^["'<(`\s]+/, "").replace(/["'>`\s]+$/, "");
  // A trailing dot is punctuation when the URL has a path ("x.com/a.") or follows a parenthesis ("(x.com)."),
  // not for a bare FQDN ("linear.app." or "https://linear.app."). The scheme is removed first so "//" is not a path.
  const hasPath = /^[^/]+\/./.test(s.replace(SCHEME_SLASHES, ""));
  const punctuation = hasPath ? /[.,;]$/ : /[,;]$|\)\.$/;
  for (;;) {
    if (punctuation.test(s)) s = s.slice(0, -1);
    else if (s.endsWith(")") && count(s, ")") > count(s, "(")) s = s.slice(0, -1);
    else break;
  }
  if (!s || /\s/.test(s)) return { ok: false, code: "invalid-url" };
  if (!SCHEME.test(s) || HOST_PORT.test(s)) s = `https://${s}`;

  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, code: "invalid-url" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, code: "invalid-url" };
  const host = u.hostname;
  const ipv6 = host.startsWith("[");
  if (!ipv6 && (!DOMAIN.test(host) || (!host.includes(".") && host !== "localhost"))) return { ok: false, code: "invalid-url" };
  if (u.port && u.port !== "80" && u.port !== "443") return { ok: false, code: "unsupported-port" };
  u.username = "";
  u.password = "";
  if (!u.hash.startsWith("#/") && !u.hash.startsWith("#!/")) u.hash = "";
  return { ok: true, url: u.toString(), host };
}
