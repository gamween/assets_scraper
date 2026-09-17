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

  it("keeps DNS failures and the exchange deadline apart from connect failures", async () => {
    undici.fetch.mockRejectedValue(fetchFailed("ENOTFOUND", "getaddrinfo ENOTFOUND example.com"));
    await expect(safeFetch("https://example.com/")).rejects.toMatchObject({ code: "dns" });
    undici.fetch.mockImplementation((_url: URL, init: { signal: AbortSignal }) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason))));
    await expect(safeFetch("https://example.com/", { timeoutMs: 50 })).rejects.toMatchObject({ code: "timeout" });
  });
});
