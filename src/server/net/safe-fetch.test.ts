import { afterEach, describe, expect, it, vi } from "vitest";

const undici = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("undici", async (importOriginal) => ({ ...(await importOriginal<typeof import("undici")>()), fetch: undici.fetch }));

import { safeFetch } from "./safe-fetch";

/** The rejection undici's fetch gives when its connector fails with `code`. */
const fetchFailed = (code: string, message: string) => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(message), { code }) });

describe("safeFetch error mapping", () => {
  afterEach(() => {
    undici.fetch.mockReset();
  });

  it("reports a host whose connect times out as unreachable, not as a slow page", async () => {
    // a port that drops SYNs: undici's own connect timeout fires well before the exchange deadline
    undici.fetch.mockRejectedValue(fetchFailed("UND_ERR_CONNECT_TIMEOUT", "Connect Timeout Error"));
    await expect(safeFetch("https://example.com/", { timeoutMs: 60_000 })).rejects.toMatchObject({ code: "connect", message: "Connect Timeout Error" });
  });

  it.each([
    ["ECONNREFUSED", "connect ECONNREFUSED 93.184.216.34:443"],
    ["ECONNRESET", "read ECONNRESET"],
    ["EHOSTUNREACH", "connect EHOSTUNREACH 93.184.216.34:443"],
    ["UND_ERR_SOCKET", "other side closed"],
    ["CERT_HAS_EXPIRED", "certificate has expired"],
    ["ERR_TLS_CERT_ALTNAME_INVALID", "Hostname/IP does not match certificate's altnames"],
    ["ERR_SSL_WRONG_VERSION_NUMBER", "wrong version number"],
    ["EPROTO", "write EPROTO"],
  ])("reports the socket or TLS failure %s as connect", async (code, message) => {
    undici.fetch.mockRejectedValue(fetchFailed(code, message));
    await expect(safeFetch("https://example.com/")).rejects.toMatchObject({ name: "SafeFetchError", code: "connect", message });
  });

  it("rethrows errors that are not socket, TLS or DNS failures unchanged", async () => {
    // a caller's invalid header value, an HTTP parser error and undici's own header timeout are not unreachable hosts
    const unexpected = [
      new TypeError('Headers.append: "a\nb" is an invalid header value.'),
      fetchFailed("HPE_INVALID_CONSTANT", "Expected HTTP/"),
      fetchFailed("UND_ERR_HEADERS_TIMEOUT", "Headers Timeout Error"),
    ];
    for (const error of unexpected) {
      undici.fetch.mockRejectedValueOnce(error);
      await expect(safeFetch("https://example.com/")).rejects.toBe(error);
    }
  });

  it("keeps DNS failures and the exchange deadline apart from connect failures", async () => {
    undici.fetch.mockRejectedValue(fetchFailed("ENOTFOUND", "getaddrinfo ENOTFOUND example.com"));
    await expect(safeFetch("https://example.com/")).rejects.toMatchObject({ code: "dns" });
    undici.fetch.mockImplementation((_url: URL, init: { signal: AbortSignal }) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason))));
    await expect(safeFetch("https://example.com/", { timeoutMs: 50 })).rejects.toMatchObject({ code: "timeout" });
  });
});
