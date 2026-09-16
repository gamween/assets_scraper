export type UrlInputResult =
  | { ok: true; url: string; host: string }
  | { ok: false; code: "invalid-url" | "unsupported-port" };

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const HOST_PORT = /^[^:/?#]+:\d+/;

export function normalizeInputUrl(raw: string): UrlInputResult {
  let s = raw.trim().replace(/^["'<\s]+/, "").replace(/["'>\s]+$/, "");
  // A trailing dot is punctuation only when the URL has a path ("x.com/a."), not for a bare FQDN ("linear.app.").
  const hasPath = /^(?:[a-z][a-z0-9+.-]*:\/\/)?[^/]+\/./i.test(s);
  const trimTrailing = (value: string) => value.replace(hasPath ? /[.,;]+$/ : /[,;]+$/, "");
  s = trimTrailing(s);
  const opens = (s.match(/\(/g) ?? []).length;
  const closes = (s.match(/\)/g) ?? []).length;
  if (s.endsWith(")") && closes > opens) s = trimTrailing(s.slice(0, -1));
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
  if (!host || (!host.includes(".") && !host.startsWith("[") && host !== "localhost")) return { ok: false, code: "invalid-url" };
  if (u.port && u.port !== "80" && u.port !== "443") return { ok: false, code: "unsupported-port" };
  u.username = "";
  u.password = "";
  if (!u.hash.startsWith("#/") && !u.hash.startsWith("#!/")) u.hash = "";
  return { ok: true, url: u.toString(), host };
}
