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

/**
 * Why a host is refused before any DNS lookup, or null: `private-ip` for an IP literal outside public unicast space
 * (bracketed IPv6 and legacy IPv4 spellings included), `private-dns` for `localhost` and `*.localhost`. Case, a port
 * and root dots are ignored. The one rule shared by the gate, `safeFetch` and `resolvePublicHost`; callers apply the
 * test allowlist themselves.
 */
export function privateHostReason(host: string): "private-ip" | "private-dns" | null {
  const key = hostKey(host);
  if (!key) return null;
  if (ipaddr.isValid(key)) return isPublicIp(key) ? null : "private-ip";
  return key === "localhost" || key.endsWith(".localhost") ? "private-dns" : null;
}

const DNS_NAME = /^(?=.{1,253}$)[a-z0-9_-]{1,63}(?:\.[a-z0-9_-]{1,63})*$/;

/**
 * Resolves a host once and returns every address callers may connect to, in resolver order, without duplicates. Callers
 * never resolve again, so DNS rebinding has no window: they connect to these addresses, trying the next one when a
 * connection fails (`pinnedConnectOptions`, `pinnedLookup`). IP literals, including bracketed IPv6 and legacy IPv4
 * spellings, are checked without DNS and returned alone in canonical form. Every A and AAAA record must be public. Own
 * hosts are always denied; an exact test allowlist entry skips the private checks.
 */
export async function resolvePublicAddresses(host: string, port: number): Promise<string[]> {
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
  const reason = allowed ? null : privateHostReason(name);

  if (ipaddr.isValid(name)) {
    if (reason) throw new SsrfError(reason, name);
    return [ipaddr.parse(name).toString()];
  }
  if (!DNS_NAME.test(name)) throw new SsrfError("invalid-host", host);
  if (reason) throw new SsrfError(reason, name);

  let records: { address: string }[];
  try {
    records = await dns.lookup(name, { all: true, order: "verbatim" });
  } catch (error) {
    throw Object.assign(new SsrfError("dns-failure", name), { cause: error });
  }
  if (records.length === 0) throw new SsrfError("dns-failure", name);
  if (!allowed && records.some((record) => !isPublicIp(record.address))) throw new SsrfError("private-dns", name);
  return [...new Set(records.map((record) => record.address))];
}

/** The first address `resolvePublicAddresses` returns, for callers that connect to one address only. */
export async function resolvePublicHost(host: string, port: number): Promise<string> {
  return (await resolvePublicAddresses(host, port))[0];
}

/**
 * A `lookup` for `net.connect` (and undici or `http.request`, which pass it through) that answers with addresses that
 * were already checked and never queries DNS. With `all`, as Node asks when it autoselects the address family, every
 * address is returned, so a dead first record falls back to the next one.
 */
export function pinnedLookup(addresses: readonly string[]): net.LookupFunction {
  const records = addresses.map((address) => ({ address, family: net.isIP(address) }));
  return (_hostname, options, callback) => {
    if (options.all) callback(null, records);
    else callback(null, records[0].address, records[0].family);
  };
}

/**
 * `net.connect` or `http.request` target options that reach only `addresses` (from `resolvePublicAddresses(host)`):
 * one address is connected to directly; several go through `pinnedLookup` with family autoselection, which tries them
 * in turn (IPv6 and IPv4 interleaved, 250 ms per attempt before the next one starts, the last one until the caller's
 * connect timeout).
 */
export function pinnedConnectOptions(host: string, addresses: readonly string[]): { host: string; lookup?: net.LookupFunction; autoSelectFamily?: boolean } {
  if (addresses.length === 1 || net.isIP(host)) return { host: addresses[0] };
  return { host, lookup: pinnedLookup(addresses), autoSelectFamily: true };
}
