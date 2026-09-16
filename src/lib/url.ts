/**
 * On success, `url` is the normalized absolute URL and `host` is its `URL.hostname`: lowercase, IDN in punycode,
 * IPv4 in dotted form, IPv6 literals inside brackets (`[::1]`) and no root dot (`linear.app.` gives `linear.app`,
 * in `url` too). Strip the brackets before IP checks.
 */
export type UrlInputResult =
  | { ok: true; url: string; host: string }
  | { ok: false; code: "invalid-url" | "unsupported-port" };

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const HOST_PORT = /^[^:/?#]+:\d+/;
/** DNS labels of letters, digits, hyphens and underscores (IDN arrives as punycode), without a root dot. */
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)*[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/;

/** Wrappers people paste around URLs: quotes, angle brackets, parentheses, backticks. */
const OPENING = /^["'<(`\s]+/;
const CLOSING = /["'>`\s]/;

const count = (value: string, char: string) => value.split(char).length - 1;

export function normalizeInputUrl(raw: string): UrlInputResult {
  let s = raw.trim().replace(OPENING, "");
  // Closing wrappers, trailing punctuation and an unbalanced ")" can come in any order ("linear.app", from JSON,
  // <https://x.com>. from prose), so strip them one character at a time from the end until nothing changes.
  // A trailing dot is always punctuation here ("x.com/a.", "(x.com)."): on a bare host ("linear.app.") it is a root
  // dot, which names the same host and is dropped below anyway.
  let unbalanced = count(s, ")") - count(s, "(");
  let end = s.length;
  while (end > 0) {
    const last = s[end - 1];
    if (CLOSING.test(last) || ".,;".includes(last)) end -= 1;
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
  // A root dot left before a port or path ("linear.app./features") names the same DNS host. Drop it so own-host checks,
  // site-host comparisons, file names and the UI all see one form. A second dot stays and fails DOMAIN.
  if (u.hostname.endsWith(".")) u.hostname = u.hostname.slice(0, -1);
  const host = u.hostname;
  const ipv6 = host.startsWith("[");
  if (!ipv6 && (!DOMAIN.test(host) || (!host.includes(".") && host !== "localhost"))) return { ok: false, code: "invalid-url" };
  if (u.port && u.port !== "80" && u.port !== "443") return { ok: false, code: "unsupported-port" };
  u.username = "";
  u.password = "";
  if (!u.hash.startsWith("#/") && !u.hash.startsWith("#!/")) u.hash = "";
  return { ok: true, url: u.toString(), host };
}
