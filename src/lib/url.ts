/**
 * On success, `url` is the normalized absolute URL and `host` is its `URL.hostname`: lowercase, IDN in punycode,
 * IPv4 in dotted form and IPv6 literals inside brackets (`[::1]`). Strip the brackets before IP checks.
 * A domain host may end with a root dot (`linear.app.`, `localhost.`): strip it before comparing hosts, such as own-host checks.
 */
export type UrlInputResult =
  | { ok: true; url: string; host: string }
  | { ok: false; code: "invalid-url" | "unsupported-port" };

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const SCHEME_SLASHES = /^[a-z][a-z0-9+.-]*:\/\//i;
const HOST_PORT = /^[^:/?#]+:\d+/;
/** DNS labels of letters, digits, hyphens and underscores (IDN arrives as punycode), with an optional root dot. */
const DOMAIN = /^(?=.{1,253}\.?$)(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)*[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.?$/;

/** Wrappers people paste around URLs: quotes, angle brackets, parentheses, backticks. */
const OPENING = /^["'<(`\s]+/;
const CLOSING = /["'>`\s]/;

const count = (value: string, char: string) => value.split(char).length - 1;

export function normalizeInputUrl(raw: string): UrlInputResult {
  let s = raw.trim().replace(OPENING, "");
  // Closing wrappers, trailing punctuation and an unbalanced ")" can come in any order ("linear.app", from JSON,
  // <https://x.com>. from prose), so strip them one character at a time from the end until nothing changes.
  // A trailing dot is punctuation when the URL has a path ("x.com/a.") or follows a closing wrapper ("(x.com)."),
  // not for a bare FQDN ("linear.app." or "https://linear.app."). The scheme is removed first so "//" is not a path.
  // `hasPath` is computed once: stripping stops at a "/", so it never removes the path.
  const hasPath = /^[^/]+\/./.test(s.replace(SCHEME_SLASHES, ""));
  let unbalanced = count(s, ")") - count(s, "(");
  let end = s.length;
  while (end > 0) {
    const last = s[end - 1];
    const dot = last === "." && (hasPath || (end > 1 && ")>\"'`".includes(s[end - 2])));
    if (CLOSING.test(last) || ",;".includes(last) || dot) end -= 1;
    else if (last === ")" && unbalanced > 0) {
      end -= 1;
      unbalanced -= 1;
    } else break;
  }
  s = s.slice(0, end);
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
