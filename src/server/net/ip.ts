import dns from "node:dns/promises";
import net from "node:net";
import { domainToASCII } from "node:url";
import ipaddr from "ipaddr.js";

export class SsrfError extends Error {
  constructor(readonly reason: "private-ip" | "private-dns" | "own-host" | "dns-failure" | "invalid-host", readonly host: string) {
    super(`${reason}: ${host}`);
    this.name = "SsrfError";
  }
}

/** ipaddr.js classifies IPv4-compatible IPv6 (`::7f00:1`) as "unicast", so that block is denied explicitly. */
const IPV4_COMPATIBLE = ipaddr.parseCIDR("::/96");

/**
 * True only for a bare IP address (no brackets, no port) in globally routable unicast space. ipaddr.js also accepts
 * legacy IPv4 spellings (`2130706433`, `0x7f000001`, `127.1`) and classifies them by the address they name.
 */
export function isPublicIp(ip: string): boolean {
  if (!ipaddr.isValid(ip)) return false;
  let address = ipaddr.parse(ip);
  if (address.kind() === "ipv6") {
    const v6 = address as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) address = v6.toIPv4Address();
    else if (v6.match(IPV4_COMPATIBLE)) return false;
  }
  return address.range() === "unicast";
}

/**
 * Lenient host key for comparisons: lowercase, without scheme, credentials, path, brackets, port or root dots,
 * IDN in punycode. Works on configured values ("https://Scraper.example.com:443/") and on checked hosts.
 */
function hostKey(value: string): string {
  let host = value.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  host = host.split(/[/?#]/, 1)[0];
  host = host.slice(host.lastIndexOf("@") + 1);
  if (host.startsWith("[")) host = host.slice(1, host.includes("]") ? host.indexOf("]") : undefined);
  else if (!net.isIPv6(host)) host = host.replace(/:\d*$/, "");
  // A loop, not `/\.+$/`: that pattern backtracks quadratically on a long run of dots followed by another character.
  let end = host.length;
  while (end > 0 && host.charCodeAt(end - 1) === 0x2e) end -= 1;
  host = host.slice(0, end);
  if (!host || ipaddr.isValid(host)) return host;
  return domainToASCII(host) || host;
}

const OWN_HOST_VARS = ["VERCEL_URL", "VERCEL_BRANCH_URL", "VERCEL_PROJECT_PRODUCTION_URL"] as const;

/** Hosts that serve this app, read from the environment on every call (spec 11.1). */
export function isOwnHost(host: string): boolean {
  const target = hostKey(host);
  if (!target) return false;
  if (process.env.NODE_ENV === "production" && target === "localhost") return true;
  const configured = [...OWN_HOST_VARS.map((name) => process.env[name] ?? ""), ...(process.env.APP_HOSTS ?? "").split(",")];
  return configured.some((value) => hostKey(value) === target);
}

/**
 * Tests only: `SCAN_TEST_ALLOW_HOSTS` lists exact `host:port` pairs (IPv6 in brackets) that may reach private
 * addresses and any port. Never honored in production or on Vercel.
 */
export function isTestAllowed(host: string, port: number): boolean {
  if (process.env.NODE_ENV === "production" || process.env.VERCEL) return false;
  const raw = process.env.SCAN_TEST_ALLOW_HOSTS;
  if (!raw || !Number.isInteger(port) || port < 1 || port > 65_535) return false;
  const target = hostKey(host);
  if (!target) return false;
  return raw.split(",").some((entry) => {
    const value = entry.trim();
    const colon = value.lastIndexOf(":");
    if (colon <= 0 || !/^\d{1,5}$/.test(value.slice(colon + 1))) return false;
    return Number(value.slice(colon + 1)) === port && hostKey(value.slice(0, colon)) === target;
  });
}

const DNS_NAME = /^(?=.{1,253}$)[a-z0-9_-]{1,63}(?:\.[a-z0-9_-]{1,63})*$/;

/**
 * Resolves a host once and returns the address callers must connect to (never re-resolve, so DNS rebinding has no
 * window). IP literals, including bracketed IPv6 and legacy IPv4 spellings, are checked without DNS and returned in
 * canonical form. Every A and AAAA record must be public. Own hosts are always denied; an exact test allowlist entry
 * skips the private checks.
 */
export async function resolvePublicHost(host: string, port: number): Promise<string> {
  let name = host.toLowerCase();
  const bracketed = name.startsWith("[");
  if (bracketed) {
    if (!name.endsWith("]")) throw new SsrfError("invalid-host", host);
    name = name.slice(1, -1);
    if (!net.isIPv6(name)) throw new SsrfError("invalid-host", host);
  }
  if (name.endsWith(".") && !bracketed) name = name.slice(0, -1);
  if (!name) throw new SsrfError("invalid-host", host);
  if (isOwnHost(name)) throw new SsrfError("own-host", name);
  const allowed = isTestAllowed(name, port);

  if (ipaddr.isValid(name)) {
    const ip = ipaddr.parse(name).toString();
    if (!allowed && !isPublicIp(ip)) throw new SsrfError("private-ip", name);
    return ip;
  }
  if (!DNS_NAME.test(name)) throw new SsrfError("invalid-host", host);
  if (!allowed && (name === "localhost" || name.endsWith(".localhost"))) throw new SsrfError("private-dns", name);

  let records: { address: string }[];
  try {
    records = await dns.lookup(name, { all: true, order: "verbatim" });
  } catch (error) {
    throw Object.assign(new SsrfError("dns-failure", name), { cause: error });
  }
  if (records.length === 0) throw new SsrfError("dns-failure", name);
  if (!allowed && records.some((record) => !isPublicIp(record.address))) throw new SsrfError("private-dns", name);
  return records[0].address;
}
