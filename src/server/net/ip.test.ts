import { afterEach, describe, expect, it, vi } from "vitest";

const dnsMock = vi.hoisted(() => ({ lookup: vi.fn() }));

vi.mock("node:dns/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns/promises")>();
  dnsMock.lookup.mockImplementation(actual.lookup);
  return { ...actual, default: { ...actual, lookup: dnsMock.lookup }, lookup: dnsMock.lookup };
});

import { isOwnHost, isPublicIp, isTestAllowed, resolvePublicHost, SsrfError } from "./ip";

describe("isPublicIp", () => {
  it.each([
    "127.0.0.1", "10.0.0.1", "172.16.5.4", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1",
    "198.18.0.1", "192.0.0.1", "224.0.0.1", "255.255.255.255", "::1", "::", "fd00::1", "fe80::1",
    "::ffff:10.0.0.1", "::ffff:127.0.0.1", "::7f00:1", "64:ff9b::7f00:1", "2002:7f00:1::", "2001::1", "not-an-ip",
  ])("blocks %s", (ip) => expect(isPublicIp(ip)).toBe(false));

  it.each([
    // more reserved and transition ranges
    "0.1.2.3", "192.0.2.1", "240.0.0.1", "fec0::1", "ff02::1", "100::1", "2001:db8::1", "64:ff9b:1::a00:1",
    "fd00:ec2::254", "::ffff:169.254.169.254", "0:0:0:0:0:ffff:7f00:1", "::ffff:0:7f00:1", "::a00:1", "fe80::1%eth0",
    // legacy IPv4 spellings of 127.0.0.1
    "2130706433", "0x7f000001", "127.1", "017700000001",
    // not a bare IP
    "[::1]", "", " 127.0.0.1", "8.8.8.8:53",
  ])("blocks %j", (ip) => expect(isPublicIp(ip)).toBe(false));

  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"])("allows %s", (ip) => expect(isPublicIp(ip)).toBe(true));
});

describe("own hosts and test allowlist", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("treats Vercel and APP_HOSTS hosts as own", () => {
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "assets-scraper.vercel.app");
    vi.stubEnv("APP_HOSTS", "scraper.example.com, other.example");
    expect(isOwnHost("assets-scraper.vercel.app")).toBe(true);
    expect(isOwnHost("SCRAPER.example.com")).toBe(true);
    expect(isOwnHost("stripe.com")).toBe(false);
  });

  it("ignores a trailing root dot on either side", () => {
    // normalizeInputUrl drops the root dot, but env values and redirect targets can still end with one
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "assets-scraper.vercel.app");
    vi.stubEnv("APP_HOSTS", "other.example.");
    expect(isOwnHost("assets-scraper.vercel.app.")).toBe(true);
    expect(isOwnHost("other.example")).toBe(true);
  });

  it("reads VERCEL_URL and VERCEL_BRANCH_URL, strips ports and schemes, and never matches an empty host", () => {
    vi.stubEnv("VERCEL_URL", "assets-scraper-abc123.vercel.app");
    vi.stubEnv("VERCEL_BRANCH_URL", "assets-scraper-git-main.vercel.app");
    vi.stubEnv("APP_HOSTS", "https://Scraper.Example.com:8443/, ,");
    expect(isOwnHost("assets-scraper-abc123.vercel.app")).toBe(true);
    expect(isOwnHost("assets-scraper-git-main.vercel.app:443")).toBe(true);
    expect(isOwnHost("scraper.example.com")).toBe(true);
    expect(isOwnHost("")).toBe(false);
    expect(isOwnHost("vercel.app")).toBe(false);
  });

  it("treats localhost as own only in production", () => {
    expect(isOwnHost("localhost")).toBe(false);
    vi.stubEnv("NODE_ENV", "production");
    expect(isOwnHost("localhost")).toBe(true);
    expect(isOwnHost("LOCALHOST.")).toBe(true);
  });

  it("honors the test allowlist only outside production and Vercel", () => {
    vi.stubEnv("SCAN_TEST_ALLOW_HOSTS", "127.0.0.1:8787");
    expect(isTestAllowed("127.0.0.1", 8787)).toBe(true);
    expect(isTestAllowed("127.0.0.1", 8788)).toBe(false);
    vi.stubEnv("VERCEL", "1");
    expect(isTestAllowed("127.0.0.1", 8787)).toBe(false);
  });

  it("matches exact host and port pairs only", () => {
    vi.stubEnv("SCAN_TEST_ALLOW_HOSTS", "127.0.0.1:8787, [::1]:9000,localhost:3000");
    expect(isTestAllowed("[::1]", 9000)).toBe(true);
    expect(isTestAllowed("::1", 9000)).toBe(true);
    expect(isTestAllowed("localhost", 3000)).toBe(true);
    expect(isTestAllowed("127.0.0.2", 8787)).toBe(false);
    expect(isTestAllowed("localhost", 8787)).toBe(false);
    expect(isTestAllowed("127.0.0.1", 0)).toBe(false);
    vi.stubEnv("NODE_ENV", "production");
    expect(isTestAllowed("127.0.0.1", 8787)).toBe(false);
  });
});

describe("resolvePublicHost", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    dnsMock.lookup.mockClear();
  });

  it("rejects private literals and loopback names", async () => {
    await expect(resolvePublicHost("127.0.0.1", 443)).rejects.toBeInstanceOf(SsrfError);
    await expect(resolvePublicHost("[::1]", 443)).rejects.toBeInstanceOf(SsrfError);
    await expect(resolvePublicHost("localhost", 80)).rejects.toBeInstanceOf(SsrfError);
    await expect(resolvePublicHost("localhost.", 80)).rejects.toBeInstanceOf(SsrfError);
  });

  it("checks literals without DNS, including legacy IPv4 spellings and IPv4-compatible IPv6", async () => {
    for (const host of ["2130706433", "0x7f.1", "[::ffff:7f00:1]", "[::7f00:1]", "0.0.0.0", "[fe80::1]"]) {
      await expect(resolvePublicHost(host, 443)).rejects.toMatchObject({ reason: "private-ip" });
    }
    await expect(resolvePublicHost("app.localhost", 443)).rejects.toMatchObject({ reason: "private-dns" });
    expect(dnsMock.lookup).not.toHaveBeenCalled();
    await expect(resolvePublicHost("[2606:4700:4700::1111]", 443)).resolves.toBe("2606:4700:4700::1111");
    await expect(resolvePublicHost("134744072", 443)).resolves.toBe("8.8.8.8");
  });

  it("requires every DNS record to be public and returns the first one", async () => {
    dnsMock.lookup.mockResolvedValueOnce([{ address: "93.184.215.14", family: 4 }, { address: "2606:2800:21f:cb07:6820:80da:af6b:8b2c", family: 6 }]);
    await expect(resolvePublicHost("example.com", 443)).resolves.toBe("93.184.215.14");
    expect(dnsMock.lookup).toHaveBeenLastCalledWith("example.com", { all: true, order: "verbatim" });

    dnsMock.lookup.mockResolvedValueOnce([{ address: "93.184.215.14", family: 4 }, { address: "10.0.0.7", family: 4 }]);
    await expect(resolvePublicHost("rebind.example", 443)).rejects.toMatchObject({ reason: "private-dns", host: "rebind.example" });

    dnsMock.lookup.mockResolvedValueOnce([{ address: "::ffff:169.254.169.254", family: 6 }]);
    await expect(resolvePublicHost("metadata.example", 80)).rejects.toMatchObject({ reason: "private-dns" });
  });

  it("maps DNS failures and junk hosts", async () => {
    dnsMock.lookup.mockRejectedValueOnce(Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }));
    await expect(resolvePublicHost("missing.example", 443)).rejects.toMatchObject({ reason: "dns-failure" });
    dnsMock.lookup.mockResolvedValueOnce([]);
    await expect(resolvePublicHost("empty.example", 443)).rejects.toMatchObject({ reason: "dns-failure" });
    for (const host of ["", "a b.com", "evil.com/x", "[::1", "x..com"]) {
      await expect(resolvePublicHost(host, 443)).rejects.toMatchObject({ reason: "invalid-host" });
    }
  });

  it("denies own hosts before any lookup", async () => {
    vi.stubEnv("APP_HOSTS", "scraper.example.com");
    await expect(resolvePublicHost("Scraper.Example.com.", 443)).rejects.toMatchObject({ reason: "own-host" });
    expect(dnsMock.lookup).not.toHaveBeenCalled();
  });

  it("skips the private check only for an exact test allowlist entry", async () => {
    vi.stubEnv("SCAN_TEST_ALLOW_HOSTS", "127.0.0.1:8787,localhost:3000");
    await expect(resolvePublicHost("127.0.0.1", 8787)).resolves.toBe("127.0.0.1");
    await expect(resolvePublicHost("127.0.0.1", 443)).rejects.toMatchObject({ reason: "private-ip" });
    dnsMock.lookup.mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    await expect(resolvePublicHost("localhost", 3000)).resolves.toBe("127.0.0.1");
  });
});
